const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('snowyyDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform
}));
