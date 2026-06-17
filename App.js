import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View, SafeAreaView, LogBox } from 'react-native';
import { WebView } from 'react-native-webview';

// 隱藏開發環境警告 banner
LogBox.ignoreAllLogs();

const APP_BUILD_VERSION = '20260603_1935';
const CLOUD_URL = `https://tender-expression-production-9798.up.railway.app/?app_v=${APP_BUILD_VERSION}`;
const LOCAL_URL = 'http://127.0.0.1:8898/login?role=admin&app_v=20260601_1731';
// 正式上線：改用雲端；本地開發時換回 LOCAL_URL
const APP_URL = CLOUD_URL;

export default function App() {
  const webViewRef = useRef(null);
  const lastUrlRef = useRef(APP_URL);

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
    })();
    true;
  `, []);

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
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
      <StatusBar style="dark" />
      <WebView
        ref={webViewRef}
        source={source}
        style={styles.webview}
        startInLoadingState={false}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        // 開啟 WebView 快取：搭配伺服器端的 Cache-Control 標頭
        // （HTML 30 秒、CSS/JS/圖片 1 小時）重複使用已下載的資源，
        // 避免每次切換頁面都整份重新下載＋解析，是流暢度的關鍵設定。
        cacheEnabled={true}
        cacheMode="LOAD_DEFAULT"
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeContentLoaded}
        onNavigationStateChange={handleNavigationStateChange}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
        allowsBackForwardNavigationGestures={true}
        allowsLinkPreview={false}
        allowsInlineMediaPlayback={true}
        decelerationRate="normal"
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={false}
        backgroundColor="#F5F5F7"
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
});
