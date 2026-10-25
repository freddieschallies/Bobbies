'use strict';
// Bobbies POS — Electron main process.
// One program, two windows: the till on the main monitor and the customer
// menu borderless + full screen on the second output (the TV).

const { app, BrowserWindow, ipcMain, screen, protocol, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Store, StoreError } = require('./store');

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'];

// media://v/<file> serves uploaded videos to the menu screen.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// The menu window never has keyboard focus, and Chromium would otherwise treat
// it as a "background" page and pause videos / slow timers to save power.
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let store;
let videosDir;
let tillWin = null;
let menuWin = null;
let saleActive = false;
let tvStatus = { playing: false };

// Only these store methods may be called from the till screen.
const STORE_METHODS = new Set([
  'addCategory', 'renameCategory', 'moveCategory', 'deleteCategory',
  'saveProduct', 'deleteProduct', 'adjustStock', 'setStock',
  'completeSale', 'report', 'updateSettings', 'setVideoEnabled',
]);

function broadcast() {
  const state = store.publicState();
  for (const w of [tillWin, menuWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('state', state);
  }
}

function sendToMenu(channel, payload) {
  if (menuWin && !menuWin.isDestroyed()) menuWin.webContents.send(channel, payload);
}

function secondDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}

function createTill() {
  const { workArea } = screen.getPrimaryDisplay();
  tillWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    title: 'BGF420 Clubhouse POS',
    backgroundColor: '#14171a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tillWin.maximize();
  tillWin.loadFile(path.join(__dirname, '..', 'renderer', 'till', 'index.html'));
  tillWin.once('ready-to-show', () => tillWin.show());
  // Closing the till closes the whole program.
  tillWin.on('closed', () => {
    tillWin = null;
    app.quit();
  });
}

function createMenu() {
  menuWin = new BrowserWindow({
    title: 'BGF420 Clubhouse Menu',
    frame: false,
    backgroundColor: '#0b0d0c',
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  menuWin.loadFile(path.join(__dirname, '..', 'renderer', 'menu', 'index.html'));
  menuWin.once('ready-to-show', () => {
    placeMenu();
    menuWin.showInactive(); // never steal keyboard focus from the till
  });
  menuWin.on('closed', () => { menuWin = null; });
}

// Put the menu full screen on the TV. With only one screen plugged in, it
// opens as a small window so you can still test it.
function placeMenu() {
  if (!menuWin || menuWin.isDestroyed()) return;
  const d = secondDisplay();
  if (d) {
    menuWin.setFullScreen(false);
    menuWin.setBounds(d.bounds);
    menuWin.setFullScreen(true);
    menuWin.setAlwaysOnTop(true, 'screen-saver');
  } else {
    menuWin.setAlwaysOnTop(false);
    menuWin.setFullScreen(false);
    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.round(workArea.width * 0.5);
    const h = Math.round((w * 9) / 16);
    menuWin.setBounds({ x: workArea.x + workArea.width - w - 20, y: workArea.y + 20, width: w, height: h });
  }
  if (tillWin && !tillWin.isDestroyed()) tillWin.focus();
}

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
};

// Serve an uploaded video with byte-range support — the video player asks
// for the file in pieces and stalls if it can't get them.
async function serveVideo(req) {
  const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
  const file = path.join(videosDir, name);
  let size;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2])); // "last N bytes"
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    status = 206;
  }
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status, headers });
}

function applyAutoStart() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: Boolean(store.data.settings.autoStart) });
  }
}

function registerIpc() {
  ipcMain.handle('state:get', () => store.publicState());

  ipcMain.handle('store', (_e, method, args) => {
    if (!STORE_METHODS.has(method)) return { ok: false, error: 'Not allowed.' };
    try {
      const result = store[method](...(Array.isArray(args) ? args : []));
      if (method === 'updateSettings') applyAutoStart();
      if (method !== 'report') broadcast();
      return { ok: true, result };
    } catch (err) {
      if (err instanceof StoreError) return { ok: false, error: err.message };
      console.error(err);
      return { ok: false, error: 'Something went wrong — check the log.' };
    }
  });

  ipcMain.handle('videos:add', async () => {
    const res = await dialog.showOpenDialog(tillWin, {
      title: 'Add videos for the menu screen',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Videos', extensions: VIDEO_EXTS }],
    });
    if (res.canceled) return { ok: true, result: [] };
    const added = [];
    for (const src of res.filePaths) {
      const ext = path.extname(src).toLowerCase();
      const file = `${crypto.randomUUID()}${ext}`;
      await fs.promises.copyFile(src, path.join(videosDir, file));
      added.push(store.addVideo(file, path.basename(src)));
    }
    broadcast();
    return { ok: true, result: added };
  });

  ipcMain.handle('videos:remove', async (_e, id) => {
    try {
      const v = store.removeVideo(id);
      await fs.promises.rm(path.join(videosDir, v.file), { force: true });
      broadcast();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // The till tells us when a customer is busy ordering; the menu holds videos back.
  ipcMain.on('sale-active', (_e, active) => {
    saleActive = Boolean(active);
    sendToMenu('sale-active', saleActive);
  });
  ipcMain.handle('sale-active:get', () => saleActive);

  ipcMain.on('video:test', () => sendToMenu('video:test'));

  // The TV tells us when a video starts or stops; the till's mini TV follows it.
  ipcMain.on('tv-status', (_e, s) => {
    tvStatus = s && typeof s === 'object' ? s : { playing: false };
    if (tillWin && !tillWin.isDestroyed()) tillWin.webContents.send('tv-status', tvStatus);
  });
  ipcMain.handle('tv-status:get', () => tvStatus);
  ipcMain.handle('menu:place', () => { placeMenu(); return { ok: true, hasSecond: Boolean(secondDisplay()) }; });
  ipcMain.handle('menu:reload', () => { if (menuWin) menuWin.reload(); return { ok: true }; });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  videosDir = path.join(dataDir, 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  store = new Store(path.join(dataDir, 'bobbies-data.json'));

  protocol.handle('media', (req) => serveVideo(req));

  Menu.setApplicationMenu(null);
  registerIpc();
  applyAutoStart();
  createTill();
  createMenu();

  // TV switched on/off or plugged in later: move the menu to the right place.
  screen.on('display-added', () => setTimeout(placeMenu, 500));
  screen.on('display-removed', () => setTimeout(placeMenu, 500));
  screen.on('display-metrics-changed', () => setTimeout(placeMenu, 500));
});

app.on('second-instance', () => {
  if (tillWin) {
    if (tillWin.isMinimized()) tillWin.restore();
    tillWin.focus();
  }
});

app.on('window-all-closed', () => app.quit());
