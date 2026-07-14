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

const APP_BUILD_VERSION = '20260714_fast1';
const CLOUD_ORIGIN = 'https://tender-expression-production-9798.up.railway.app';
const CLOUD_URL = `${CLOUD_ORIGIN}/?app_v=${APP_BUILD_VERSION}`;
const LOCAL_URL = 'http://127.0.0.1:8898/login?role=admin&app_v=20260601_1731';
const APP_URL = CLOUD_URL;
const API_ORIGIN = CLOUD_ORIGIN;

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

    const res = await fetch(`${API_ORIGIN}/api/push/register`, {
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

function isSameOrigin(url) {
  try {
    return new URL(url).origin === CLOUD_ORIGIN;
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
      // 非本站：用系統瀏覽器開，避免 WebView 卡住或空白
      if (u.origin !== CLOUD_ORIGIN) return true;
    }
  } catch (e) {}
  return false;
}

export default function App() {
  const webViewRef = useRef(null);
  const lastUrlRef = useRef(APP_URL);
  const [contentReady, setContentReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingHint, setLoadingHint] = useState(true);

  const handleLoadEnd = useCallback(() => {
    setContentReady(true);
    setLoadingHint(false);
    setLoadError(null);
  }, []);

  const handleLoadStart = useCallback(() => {
    setLoadingHint(true);
    setLoadError(null);
  }, []);

  const handleError = useCallback(() => {
    setLoadingHint(false);
    setLoadError('無法連線，請檢查網路後重試');
    setContentReady(true);
  }, []);

  const handleHttpError = useCallback((e) => {
    const code = e?.nativeEvent?.statusCode;
    if (code && code >= 500) {
      setLoadingHint(false);
      setLoadError(`伺服器忙碌（${code}），請稍後再試`);
      setContentReady(true);
    }
  }, []);

  const retryLoad = useCallback(() => {
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
        const target = /^https?:\/\//.test(url) ? url : `${API_ORIGIN}${url}`;
        if (isSameOrigin(target) || target.startsWith(API_ORIGIN)) {
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
    () => ({ uri: lastUrlRef.current || APP_URL }),
    [reloadKey]
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
  }, []);

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
    const uri = lastUrlRef.current || APP_URL;
    setReloadKey((k) => k + 1);
    lastUrlRef.current = uri;
  }, []);

  return (
    <SafeAreaView style={[styles.safeArea, !contentReady && styles.safeAreaLoading]}>
      <View style={[styles.container, !contentReady && styles.containerLoading]}>
        <StatusBar style="dark" />
        <WebView
          key={reloadKey}
          ref={webViewRef}
          source={source}
          style={[styles.webview, !contentReady && styles.webviewLoading]}
          startInLoadingState={false}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          geolocationEnabled={true}
          cacheEnabled={true}
          cacheMode="LOAD_DEFAULT"
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
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
