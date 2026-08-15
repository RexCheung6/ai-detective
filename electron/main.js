// AI 侦探 · Electron 主进程
// 加载本地前端（public/index.html），API 请求由前端自动指向 Netlify
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 430,
    height: 820,
    minWidth: 380,
    minHeight: 640,
    title: 'AI 侦探',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 打包版加载 file:// 页面请求 https:// Netlify API 是跨域请求，
      // 关闭 webSecurity 让本地前端能访问远程 API（仅打包版生效，网页版不受影响）
      webSecurity: false,
    },
  });

  // 加载打包进来的本地前端
  win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

  // 阻止新窗口（防止误触外链打开）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 隐藏默认菜单，保持手机风格
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
