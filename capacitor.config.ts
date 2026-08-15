import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aidetective.game',
  appName: 'AI侦探',
  webDir: 'public',
  server: {
    // Android 打包后 WebView 以 https://localhost 加载本地资源
    androidScheme: 'https'
  }
};

export default config;
