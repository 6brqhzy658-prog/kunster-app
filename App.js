import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  SafeAreaView,
  LogBox,
  AppState,
  Platform,
  Text,
  Pressable,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

// expo-location 完全延遲載入：舊的原生二進位沒有模組時，啟動不碰就不崩潰。
let _locationModule; // undefined=還沒試過, null=載入失敗
function getLocationModule() {
  if (_locationModule === undefined) {
    try {
      _locationModule = require('expo-location');
    } catch (e) {
      _locationModule = null;
    }
  }
  return _locationModule;
}

// 開發環境保留警告；正式版隱藏 banner
if (!__DEV__) {
  LogBox.ignoreAllLogs();
}

const APP_BUILD_VERSION = '20260721_cookie_isolate';
const CLOUD_ORIGIN = 'https://tender-expression-production-9798.up.railway.app';
const CLOUD_URL = `${CLOUD_ORIGIN}/?app_v=${APP_BUILD_VERSION}`;
// iOS Simulator / 真機預覽：
//   false = 正式站（Railway）← 目前
//   true  = 本機沙盒（port 8911，桌面「案場協作沙盒」）
const USE_LOCAL_PREVIEW = false;
const LOCAL_SANDBOX_PORT = 8911;
/** Railway 重啟／部署中常回 502 upstream error；App 自動重試次數 */
const UPSTREAM_AUTO_RETRY_MAX = 5;

function _parseHost(raw) {
  if (!raw) return '';
  try {
    const cleaned = String(raw).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
    const host = (cleaned.split(':')[0] || '').trim();
    if (!host) return '';
    if (host === 'exp.host' || host.endsWith('.exp.direct')) return '';
    return host;
  } catch (e) {
    return '';
  }
}

/** 收集所有可能的本機主機（真機 127.0.0.1=手機自己 → Error-1004，需用 LAN IP） */
function getLocalHostCandidates() {
  const hosts = [];
  const push = (h) => {
    if (!h) return;
    const x = String(h).trim();
    if (!x || hosts.includes(x)) return;
    hosts.push(x);
  };
  try {
    // 優先：手動指定的 Mac LAN IP（可逗號分隔多個網卡）
    const manual = [
      Constants.expoConfig?.extra?.localHost,
      process.env.EXPO_PUBLIC_LOCAL_HOST,
    ]
      .filter(Boolean)
      .join(',');
    String(manual)
      .split(/[\s,;]+/)
      .map((x) => _parseHost(x))
      .forEach(push);
    // Expo 開發主機（--lan 時通常是 192.168.x.x）
    push(_parseHost(Constants.expoConfig?.hostUri));
    push(_parseHost(Constants.manifest2?.extra?.expoGo?.debuggerHost));
    push(_parseHost(Constants.manifest?.debuggerHost));
    push(_parseHost(Constants.linkingUri));
  } catch (e) {}
  // Simulator 常用；Android emulator 連 host 用 10.0.2.2
  if (Platform.OS === 'android') {
    push('10.0.2.2');
  }
  push('127.0.0.1');
  push('localhost');
  return hosts.length ? hosts : ['127.0.0.1'];
}

function originFromHost(host) {
  return `http://${host}:${LOCAL_SANDBOX_PORT}`;
}

const LOCAL_HOST_CANDIDATES = getLocalHostCandidates();
const LOCAL_ORIGIN_CANDIDATES = LOCAL_HOST_CANDIDATES.map(originFromHost);
// 初始用第一個（通常是 Expo debugger 的 LAN IP）
const LOCAL_ORIGIN = LOCAL_ORIGIN_CANDIDATES[0];
const LOCAL_URL = `${LOCAL_ORIGIN}/?app_v=${APP_BUILD_VERSION}`;
const APP_URL = USE_LOCAL_PREVIEW ? LOCAL_URL : CLOUD_URL;
// API_ORIGIN 會在 runtime 隨 WebView 成功連上的 origin 更新（見 App 內 state）
let _runtimeApiOrigin = LOCAL_ORIGIN;
function getApiOrigin() {
  return USE_LOCAL_PREVIEW ? _runtimeApiOrigin : CLOUD_ORIGIN;
}

// 推播註冊節流：避免每次回前景都打 API
let _lastPushRegisterAt = 0;
let _lastPushToken = '';
const PUSH_REGISTER_MIN_MS = 60 * 1000;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerForPushNotificationsAsync(force = false) {
  try {
    if (!Device.isDevice) return;

    const now = Date.now();
    if (!force && now - _lastPushRegisterAt < PUSH_REGISTER_MIN_MS && _lastPushToken) {
      return;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const projectId = Constants?.expoConfig?.extra?.eas?.projectId;
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenResponse?.data;
    if (!token) return;

    if (!force && token === _lastPushToken && now - _lastPushRegisterAt < PUSH_REGISTER_MIN_MS * 5) {
      return;
    }

    const res = await fetch(`${getApiOrigin()}/api/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    if (res.ok) {
      _lastPushRegisterAt = Date.now();
      _lastPushToken = token;
    }
  } catch (e) {
    // 推播失敗不擋主流程
  }
}

function allowedOrigins() {
  const set = new Set([CLOUD_ORIGIN]);
  try {
    set.add(new URL(getApiOrigin()).origin);
  } catch (e) {}
  try {
    set.add(new URL(APP_URL).origin);
  } catch (e) {}
  // 所有候選本機 origin（避免 shouldOpenExternally 誤判成外部連結）
  for (const o of LOCAL_ORIGIN_CANDIDATES) {
    try {
      set.add(new URL(o).origin);
    } catch (e) {}
  }
  for (const host of LOCAL_HOST_CANDIDATES) {
    for (const port of [LOCAL_SANDBOX_PORT, 8898, 8081]) {
      set.add(`http://${host}:${port}`);
    }
  }
  set.add('http://127.0.0.1:8911');
  set.add('http://localhost:8911');
  return set;
}

function isLocalSandboxOrigin(origin) {
  try {
    const u = new URL(origin);
    const port = String(u.port || (u.protocol === 'https:' ? '443' : '80'));
    if (port !== String(LOCAL_SANDBOX_PORT) && port !== '8898') return false;
    const h = (u.hostname || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '10.0.2.2') return true;
    // 私有網段（真機連 Mac LAN）
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
    return LOCAL_HOST_CANDIDATES.includes(h);
  } catch (e) {
    return false;
  }
}

function isSameOrigin(url) {
  try {
    return allowedOrigins().has(new URL(url).origin);
  } catch (e) {
    return false;
  }
}

function shouldOpenExternally(url) {
  if (!url) return false;
  if (url.startsWith('tel:') || url.startsWith('mailto:') || url.startsWith('sms:')) return true;
  try {
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    if (host.includes('maps.google.') || host.includes('maps.apple.') || host === 'goo.gl') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      // 本機沙盒永遠留在 WebView（避免被當外部連結 → 連線失敗 Error-1004）
      if (isLocalSandboxOrigin(u.origin) || allowedOrigins().has(u.origin)) return false;
      // 非本站：用系統瀏覽器開，避免 WebView 卡住或空白
      return true;
    }
  } catch (e) {}
  return false;
}

export default function App() {
  const webViewRef = useRef(null);
  const [originIndex, setOriginIndex] = useState(0);
  const activeOrigin = USE_LOCAL_PREVIEW
    ? (LOCAL_ORIGIN_CANDIDATES[originIndex] || LOCAL_ORIGIN)
    : CLOUD_ORIGIN;
  const activeAppUrl = USE_LOCAL_PREVIEW
    ? `${activeOrigin}/?app_v=${APP_BUILD_VERSION}`
    : CLOUD_URL;

  // 同步 runtime API origin（推播註冊用）
  _runtimeApiOrigin = activeOrigin;

  const lastUrlRef = useRef(activeAppUrl);
  const [contentReady, setContentReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingHint, setLoadingHint] = useState(true);
  const triedFallbackRef = useRef(false);
  const upstreamRetryRef = useRef(0);
  const upstreamTimerRef = useRef(null);

  // origin 切換時，若還在首頁路徑就跟過去
  useEffect(() => {
    if (!USE_LOCAL_PREVIEW) return;
    const cur = lastUrlRef.current || '';
    try {
      const u = new URL(cur, activeOrigin);
      // 只在連的是沙盒時改 host
      if (isLocalSandboxOrigin(u.origin) || !cur) {
        lastUrlRef.current = `${activeOrigin}${u.pathname}${u.search}${u.hash}` || activeAppUrl;
      }
    } catch (e) {
      lastUrlRef.current = activeAppUrl;
    }
  }, [activeOrigin, activeAppUrl]);

  const scheduleUpstreamRetry = useCallback((reason) => {
    if (upstreamRetryRef.current >= UPSTREAM_AUTO_RETRY_MAX) {
      setLoadingHint(false);
      setLoadError(
        `伺服器暫時無法連線${reason ? `（${reason}）` : ''}\n正在恢復中，請稍後按重新載入`
      );
      setContentReady(true);
      return;
    }
    upstreamRetryRef.current += 1;
    const n = upstreamRetryRef.current;
    const delay = Math.min(1500 * n, 6000);
    setLoadingHint(true);
    setLoadError(null);
    setContentReady(false);
    if (upstreamTimerRef.current) clearTimeout(upstreamTimerRef.current);
    upstreamTimerRef.current = setTimeout(() => {
      // 加時間戳避免 WebView 吃到舊的 502 文字頁
      const base = activeAppUrl.split('&_r=')[0].split('?_r=')[0];
      const join = base.includes('?') ? '&' : '?';
      lastUrlRef.current = `${base}${join}_r=${Date.now()}`;
      setReloadKey((k) => k + 1);
    }, delay);
  }, [activeAppUrl]);

  const handleLoadEnd = useCallback(() => {
    setContentReady(true);
    setLoadingHint(false);
    setLoadError(null);
    triedFallbackRef.current = false;
    // 成功載入後重置 upstream 重試計數（真正的 app 頁，不是 502 字）
    // 若是 502 字頁，injected JS 會 postMessage upstreamError 再觸發重試
  }, []);

  const handleLoadStart = useCallback(() => {
    setLoadingHint(true);
    setLoadError(null);
  }, []);

  const handleError = useCallback((e) => {
    const ne = e?.nativeEvent || {};
    const code = ne.code != null ? String(ne.code) : '';
    const desc = ne.description || ne.localizedDescription || '';
    // iOS -1004 / -1003 / -1001：連不上 → 自動換下一個本機 host 再試
    const isConnErr =
      code.includes('1004') ||
      code.includes('1003') ||
      code.includes('1001') ||
      /cannot connect|timed out|not find host|無法連線|Could not connect/i.test(String(desc));

    if (USE_LOCAL_PREVIEW && isConnErr && originIndex < LOCAL_ORIGIN_CANDIDATES.length - 1) {
      const next = originIndex + 1;
      setOriginIndex(next);
      lastUrlRef.current = `${LOCAL_ORIGIN_CANDIDATES[next]}/?app_v=${APP_BUILD_VERSION}`;
      setLoadingHint(true);
      setLoadError(null);
      setContentReady(false);
      setReloadKey((k) => k + 1);
      return;
    }

    // 正式站連線失敗也自動重試幾次（部署中常見）
    if (!USE_LOCAL_PREVIEW && isConnErr) {
      scheduleUpstreamRetry(code || desc || 'network');
      return;
    }

    setLoadingHint(false);
    const tried = LOCAL_ORIGIN_CANDIDATES.join('\n');
    const hint = USE_LOCAL_PREVIEW
      ? `無法連到本機沙盒（Error ${code || '1004'}）\n已嘗試：\n${tried}\n\n請確認 Mac 上沙盒有在跑：\npython3 app.py（port ${LOCAL_SANDBOX_PORT}）`
      : '無法連線，請檢查網路後重試';
    setLoadError([hint, desc ? `(${desc})` : ''].filter(Boolean).join('\n'));
    setContentReady(true);
  }, [originIndex, scheduleUpstreamRetry]);

  const handleHttpError = useCallback((e) => {
    const code = e?.nativeEvent?.statusCode;
    if (code && code >= 500) {
      scheduleUpstreamRetry(String(code));
    }
  }, [scheduleUpstreamRetry]);

  const retryLoad = useCallback(() => {
    upstreamRetryRef.current = 0;
    if (upstreamTimerRef.current) clearTimeout(upstreamTimerRef.current);
    setOriginIndex(0);
    if (USE_LOCAL_PREVIEW) {
      lastUrlRef.current = `${LOCAL_ORIGIN_CANDIDATES[0] || LOCAL_ORIGIN}/?app_v=${APP_BUILD_VERSION}`;
    } else {
      lastUrlRef.current = `${CLOUD_URL}&_r=${Date.now()}`;
    }
    setLoadError(null);
    setLoadingHint(true);
    setContentReady(false);
    setReloadKey((k) => k + 1);
  }, []);

  // 保險：最長 8 秒結束啟動白屏（比 6 秒稍長，給弱網）
  useEffect(() => {
    const t = setTimeout(() => {
      setContentReady(true);
      setLoadingHint(false);
    }, 8000);
    return () => clearTimeout(t);
  }, [reloadKey]);

  useEffect(() => {
    if (!contentReady || loadError) return;
    registerForPushNotificationsAsync();
  }, [contentReady, loadError]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        registerForPushNotificationsAsync(false);
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response?.notification?.request?.content?.data?.url;
      if (url && webViewRef.current) {
        const api = getApiOrigin();
        const target = /^https?:\/\//.test(url) ? url : `${api}${url}`;
        let ok = isSameOrigin(target) || target.startsWith(api);
        if (!ok) {
          try {
            ok = isLocalSandboxOrigin(new URL(target).origin);
          } catch (e) {}
        }
        if (ok) {
          lastUrlRef.current = target;
          webViewRef.current.injectJavaScript(
            `window.location.href=${JSON.stringify(target)}; true;`
          );
        }
      }
    });
    return () => sub.remove();
  }, []);

  const source = useMemo(
    () => ({ uri: lastUrlRef.current || activeAppUrl }),
    [reloadKey, activeAppUrl, originIndex]
  );

  const injectedBeforeContentLoaded = useMemo(
    () => `
    (function () {
      if (window.__kunsterNativeBridgeInstalled) return;
      window.__kunsterNativeBridgeInstalled = true;
      window.__kunsterLastScroll = window.__kunsterLastScroll || {};

      function keyForUrl() {
        return location.pathname + location.search + location.hash;
      }

      function saveScroll() {
        try {
          window.__kunsterLastScroll[keyForUrl()] = {
            x: window.scrollX || window.pageXOffset || 0,
            y: window.scrollY || window.pageYOffset || 0,
            t: Date.now()
          };
        } catch (e) {}
      }

      function restoreScroll() {
        try {
          var saved = window.__kunsterLastScroll[keyForUrl()];
          if (!saved) return;
          requestAnimationFrame(function () {
            window.scrollTo(saved.x || 0, saved.y || 0);
          });
        } catch (e) {}
      }

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) saveScroll();
      });
      window.addEventListener('pagehide', saveScroll);
      window.addEventListener('beforeunload', saveScroll);
      window.addEventListener('pageshow', restoreScroll);
      window.addEventListener('focus', restoreScroll);
      restoreScroll();

      // 原生定位橋接
      var geoSeq = 0;
      var geoCallbacks = {};
      window.__kunsterGeoResult = function (id, ok, payload) {
        var cb = geoCallbacks[id];
        if (!cb) return;
        delete geoCallbacks[id];
        if (cb.timer) clearTimeout(cb.timer);
        try {
          if (ok) {
            cb.success({
              coords: {
                latitude: payload.latitude,
                longitude: payload.longitude,
                accuracy: payload.accuracy || 0,
                altitude: null, altitudeAccuracy: null, heading: null, speed: null
              },
              timestamp: Date.now()
            });
          } else if (cb.error) {
            cb.error({ code: 1, message: (payload && payload.message) || 'unavailable' });
          }
        } catch (e) {}
      };
      if (window.ReactNativeWebView && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition = function (success, error, options) {
          var id = 'g' + (++geoSeq);
          var entry = { success: success, error: error };
          var reqTimeout = (options && options.timeout) || 0;
          var bridgeTimeout = Math.max(reqTimeout, 20000);
          entry.timer = setTimeout(function () {
            if (geoCallbacks[id]) {
              delete geoCallbacks[id];
              if (error) error({ code: 3, message: 'timeout' });
            }
          }, bridgeTimeout);
          geoCallbacks[id] = entry;
          try {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'getCurrentPosition',
              id: id,
              timeoutMs: bridgeTimeout
            }));
          } catch (e) {
            delete geoCallbacks[id];
            clearTimeout(entry.timer);
            if (error) error({ code: 2, message: 'bridge unavailable' });
          }
        };
      }

      // 登入後通知原生重註冊推播
      try {
        var _origFetch = window.fetch;
        if (_origFetch && !window.__kunsterFetchPatched) {
          window.__kunsterFetchPatched = true;
          window.fetch = function () {
            return _origFetch.apply(this, arguments).then(function (res) {
              try {
                var u = String(arguments[0] || '');
                if (res && res.ok && (u.indexOf('/login') >= 0 || u.indexOf('/api/login') >= 0)) {
                  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'authMaybe' }));
                }
              } catch (e) {}
              return res;
            });
          };
        }
      } catch (e) {}

      // 偵測 Railway 502 純文字頁（WebView 會當成「載入成功」顯示 "upstream error"）
      function checkUpstreamErrorPage() {
        try {
          var t = (document.body && (document.body.innerText || document.body.textContent) || '').trim().toLowerCase();
          if (!t) return;
          if (t === 'upstream error' || t.indexOf('upstream error') === 0 || t === 'application failed to respond') {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'upstreamError', text: t.slice(0, 80) }));
          } else if (t.length < 80 && /bad gateway|502|503 service/i.test(t)) {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'upstreamError', text: t.slice(0, 80) }));
          } else {
            // 正常頁：通知原生重置重試計數
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'pageOk' }));
          }
        } catch (e) {}
      }
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(checkUpstreamErrorPage, 50);
      } else {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(checkUpstreamErrorPage, 50); });
      }
      window.addEventListener('load', function () { setTimeout(checkUpstreamErrorPage, 50); });
    })();
    true;
  `,
    []
  );

  const handleMessage = useCallback(async (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event?.nativeEvent?.data || '');
    } catch (e) {
      return;
    }
    if (!msg || !msg.type) return;

    if (msg.type === 'upstreamError') {
      scheduleUpstreamRetry(msg.text || 'upstream error');
      return;
    }
    if (msg.type === 'pageOk') {
      upstreamRetryRef.current = 0;
      return;
    }

    if (msg.type === 'authMaybe' || msg.type === 'login') {
      registerForPushNotificationsAsync(true);
      return;
    }

    if (msg.type !== 'getCurrentPosition' || !msg.id) return;
    const reply = (ok, payload) => {
      const js = `window.__kunsterGeoResult && window.__kunsterGeoResult(${JSON.stringify(msg.id)}, ${ok ? 'true' : 'false'}, ${JSON.stringify(payload || {})}); true;`;
      webViewRef.current?.injectJavaScript(js);
    };
    try {
      const Location = getLocationModule();
      if (!Location) {
        reply(false, { message: 'module unavailable' });
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        reply(false, { message: 'permission denied' });
        return;
      }
      // 已授權時先試 last known（快），沒有再精準取
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last?.coords && (Date.now() - (last.timestamp || 0) < 120000)) {
          reply(true, {
            latitude: last.coords.latitude,
            longitude: last.coords.longitude,
            accuracy: last.coords.accuracy || 0,
          });
          // 背景更新一筆較新座標（不擋 UI）
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => {});
          return;
        }
      } catch (e) {}

      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gps-timeout')), 12000)),
      ]);
      reply(true, {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 0,
      });
    } catch (e) {
      reply(false, { message: (e && e.message) || 'unavailable' });
    }
  }, [scheduleUpstreamRetry]);

  const handleNavigationStateChange = useCallback((navState) => {
    if (navState?.url) {
      lastUrlRef.current = navState.url;
    }
    if (navState?.loading === false) {
      setLoadingHint(false);
    }
  }, []);

  const handleShouldStart = useCallback((req) => {
    const url = req?.url || '';
    if (!url || url === 'about:blank') return true;
    if (shouldOpenExternally(url)) {
      Linking.openURL(url).catch(() => {});
      return false;
    }
    return true;
  }, []);

  const handleContentProcessDidTerminate = useCallback(() => {
    // iOS 記憶體回收 WKWebView 後，回到最後一頁而不是首頁
    const uri = lastUrlRef.current || activeAppUrl;
    lastUrlRef.current = uri;
    setReloadKey((k) => k + 1);
  }, [activeAppUrl]);

  return (
    <SafeAreaView style={[styles.safeArea, !contentReady && styles.safeAreaLoading]}>
      <View style={[styles.container, !contentReady && styles.containerLoading]}>
        <StatusBar style="dark" />
        <WebView
          key={`${reloadKey}-${originIndex}`}
          ref={webViewRef}
          source={source}
          style={[styles.webview, !contentReady && styles.webviewLoading]}
          startInLoadingState={false}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          geolocationEnabled={true}
          cacheEnabled={false}
          cacheMode="LOAD_NO_CACHE"
          // 必須 false：若 true 會與 Safari 共用 Cookie，同機曾在瀏覽器登過 admin
          // 時，剛下載 App 也會直接進入 admin，沒有登入畫面。
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          // 允許本機 http（沙盒預覽）；否則 iOS 可能直接 Error-1004
          originWhitelist={['*']}
          mixedContentMode="always"
          allowsFullscreenVideo={true}
          injectedJavaScriptBeforeContentLoaded={injectedBeforeContentLoaded}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationStateChange}
          onShouldStartLoadWithRequest={handleShouldStart}
          onContentProcessDidTerminate={handleContentProcessDidTerminate}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onHttpError={handleHttpError}
          allowsBackForwardNavigationGestures={true}
          allowsLinkPreview={false}
          allowsInlineMediaPlayback={true}
          decelerationRate="normal"
          setSupportMultipleWindows={false}
          mediaPlaybackRequiresUserAction={false}
          backgroundColor={contentReady ? '#F5F5F7' : '#ffffff'}
          applicationNameForUserAgent="KunsterApp/1.0"
        />

        {loadingHint && !loadError && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#1677E8" />
            <Text style={styles.loadingText}>載入中…</Text>
          </View>
        )}

        {loadError && (
          <View style={styles.errorOverlay}>
            <Text style={styles.errorTitle}>連線不穩</Text>
            <Text style={styles.errorBody}>{loadError}</Text>
            <Pressable style={styles.retryBtn} onPress={retryLoad}>
              <Text style={styles.retryBtnText}>重新載入</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F5F5F7',
  },
  container: {
    flex: 1,
    backgroundColor: '#F5F5F7',
  },
  webview: {
    flex: 1,
    backgroundColor: '#F5F5F7',
  },
  safeAreaLoading: {
    backgroundColor: '#ffffff',
  },
  containerLoading: {
    backgroundColor: '#ffffff',
  },
  webviewLoading: {
    backgroundColor: '#ffffff',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '600',
    color: '#182230',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5F7FA',
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#182230',
    marginBottom: 8,
  },
  errorBody: {
    fontSize: 14,
    color: '#7C8491',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: '#1677E8',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
