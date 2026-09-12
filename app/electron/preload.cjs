/* 渲染进程只拿到这一小块桥：设置面板用它切窗口模式、换仓库、开文件夹。
   contextIsolation 开着，页面代码碰不到 Node。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kbDesktop', {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('kb:info'),
  setWindowMode: (mode) => ipcRenderer.invoke('kb:window-mode', mode),
  pickVault: () => ipcRenderer.invoke('kb:pick-vault'),
  openPath: (p) => ipcRenderer.invoke('kb:open-path', p),
});
