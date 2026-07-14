import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, SafeAreaView, LogBox, AppState, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

// expo-location 完全延遲載入：舊的原生二進位（還沒重新 build 的開發機/舊版
// TestFlight）沒有 ExpoLocation 原生模組，啟動階段碰到就會崩潰。
// 改成「第一次要定位時」才 require，載不到就當作拿不到定位，
// 打卡走既有的「無定位照樣打卡」流程
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

// 隱藏開發環境警告 banner
LogBox.ignoreAllLogs();

const APP_BUILD_VERSION = '20260714_0950';
const CLOUD_ORIGIN = 'https://tender-expression-production-9798.up.railway.app';
const CLOUD_URL = `${CLOUD_ORIGIN}/?app_v=${APP_BUILD_VERSION}`;
const LOCAL_URL = 'http://127.0.0.1:8898/login?role=admin&app_v=20260601_1731';
// 正式上線：改用雲端；本地開發時換回 LOCAL_URL
const APP_URL = CLOUD_URL;
const API_ORIGIN = CLOUD_ORIGIN; // 推播 token 註冊打這個 origin，跟 WebView 共用登入 cookie

// App 在前景時收到推播，也要照樣顯示橫幅／音效／更新角標，
// 不然師傅開著 app 在看別的畫面時會完全沒感覺
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// 把 Expo Push Token 送到後端，記住「這支手機屬於哪個登入的使用者」。
// 模擬器拿不到真正的推播 token（iOS 限制），所以先確認是實機才繼續；
// 還沒登入時後端會擋掉（401），不算錯誤，下次開 app 或登入後會再試一次。
async function registerForPushNotificationsAsync() {
  try {
    if (!Device.isDevice) return;

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

    await fetch(`${API_ORIGIN}/api/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
  } catch (e) {
    // 推播註冊失敗不影響 app 主要功能（網頁本身），靜默放過即可
  }
}

export default function App() {
  const webViewRef = useRef(null);
  const lastUrlRef = useRef(APP_URL);
  // 啟動畫面背景是白色，但 App 介面是淺灰色（#F5F5F7）；如果一啟動就切成灰色，
  // 在網頁還沒載入完成前會先看到一塊空白灰畫面，跟白色啟動畫面疊在一起變成
  // 「白→灰→空白→內容」幾次明顯的閃色。改成：內容真正載入完成前維持白底，
  // 載入完成才一次性換成灰底＋畫面內容，閃色感會明顯減少。
  const [contentReady, setContentReady] = useState(false);

  const handleLoadEnd = useCallback(() => {
    setContentReady(true);
  }, []);

  // 萬一網路異常導致 onLoadEnd 沒有觸發，幾秒後還是要顯示出來，
  // 不要讓使用者卡在白畫面動彈不得
  useEffect(() => {
    const t = setTimeout(() => setContentReady(true), 6000);
    return () => clearTimeout(t);
  }, []);

  // 內容第一次載入完成後嘗試註冊推播 token；如果這時候還沒登入，後端會擋掉，
  // 不算錯誤。另外每次 app 從背景回到前景也再試一次，涵蓋「剛剛才登入」的情況。
  useEffect(() => {
    if (!contentReady) return;
    registerForPushNotificationsAsync();
  }, [contentReady]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        registerForPushNotificationsAsync();
      }
    });
    return () => sub.remove();
  }, []);

  // 點擊系統通知時，把 WebView 導去通知裡帶的網址（例如某個案場頁面），
  // 不要只是把 app 帶到前景卻停在原來的畫面
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response?.notification?.request?.content?.data?.url;
      if (url && webViewRef.current) {
        const target = /^https?:\/\//.test(url) ? url : `${API_ORIGIN}${url}`;
        webViewRef.current.injectJavaScript(
          `window.location.href=${JSON.stringify(target)}; true;`
        );
      }
    });
    return () => sub.remove();
  }, []);

  const source = useMemo(() => ({ uri: APP_URL }), []);

  const injectedBeforeContentLoaded = useMemo(() => `
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

      // ── 原生定位橋接：WKWebView 的 navigator.geolocation 在 RN WebView 內
      // 拿不到座標（權限流程不會被觸發，打卡全部變成「未取得定位」）。
      // 改成攔截 getCurrentPosition，請 APP 用 expo-location 原生取得座標後回填 ──
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
          // 與網頁打卡看門狗對齊：預設 4 秒，避免卡在「定位中…」
          entry.timer = setTimeout(function () {
            if (geoCallbacks[id]) {
              delete geoCallbacks[id];
              if (error) error({ code: 3, message: 'timeout' });
            }
          }, (options && options.timeout) || 4000);
          geoCallbacks[id] = entry;
          try {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'getCurrentPosition', id: id }));
          } catch (e) {
            delete geoCallbacks[id];
            clearTimeout(entry.timer);
            if (error) error({ code: 2, message: 'bridge unavailable' });
          }
        };
      }
    })();
    true;
  `, []);

  // 網頁端要定位時，用 expo-location 原生取得座標回填給 WebView。
  // 權限被拒或取不到就回失敗，讓網頁端走「無定位照樣打卡」的既有流程
  const handleMessage = useCallback(async (event) => {
    let msg = null;
    try { msg = JSON.parse(event?.nativeEvent?.data || ''); } catch (e) { return; }
    if (!msg || msg.type !== 'getCurrentPosition' || !msg.id) return;
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
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      reply(true, {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 0,
      });
    } catch (e) {
      reply(false, { message: 'unavailable' });
    }
  }, []);

  const handleNavigationStateChange = useCallback((navState) => {
    if (navState.url) {
      lastUrlRef.current = navState.url;
    }
  }, []);

  const handleContentProcessDidTerminate = useCallback(() => {
    // iOS may reclaim WKWebView under memory pressure. If it happens, reload the last page,
    // not the app root, so returning from another app lands back on the current job site.
    webViewRef.current?.reload();
  }, []);

  return (
    <SafeAreaView style={[styles.safeArea, !contentReady && styles.safeAreaLoading]}>
      <View style={[styles.container, !contentReady && styles.containerLoading]}>
      <StatusBar style="dark" />
      <WebView
        ref={webViewRef}
        source={source}
        style={[styles.webview, !contentReady && styles.webviewLoading]}
        startInLoadingState={false}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        geolocationEnabled={true}
        // 開啟 WebView 快取：搭配伺服器端的 Cache-Control 標頭
        // （HTML 30 秒、CSS/JS/圖片 1 小時）重複使用已下載的資源，
        // 避免每次切換頁面都整份重新下載＋解析，是流暢度的關鍵設定。
        cacheEnabled={true}
        cacheMode="LOAD_DEFAULT"
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeContentLoaded}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigationStateChange}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
        onLoadEnd={handleLoadEnd}
        allowsBackForwardNavigationGestures={true}
        allowsLinkPreview={false}
        allowsInlineMediaPlayback={true}
        decelerationRate="normal"
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={false}
        backgroundColor={contentReady ? '#F5F5F7' : '#ffffff'}
      />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F5F5F7',   // 頂部 safe area 顏色（topbar 同色）
  },
  container: {
    flex: 1,
    backgroundColor: '#F5F5F7',   // 底部 safe area 顏色（nav 同色）
  },
  webview: {
    flex: 1,
    backgroundColor: '#F5F5F7',
  },
  // 內容還沒載入完成前維持跟啟動畫面一樣的白底，避免「白→灰→空白→內容」
  // 連續閃色；改成載入完成才一次性換成灰底＋畫面內容
  safeAreaLoading: {
    backgroundColor: '#ffffff',
  },
  containerLoading: {
    backgroundColor: '#ffffff',
  },
  webviewLoading: {
    backgroundColor: '#ffffff',
  },
});
