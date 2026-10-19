const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, powerMonitor } = require('electron');
const path = require('path');

const { readCredentials, REASON } = require('./src/credentials');
const { snapshotForRenderer, sessionPercent, weeklyPercent, fablePercent, opusPercent } = require('./src/derivations');
const { createPoller } = require('./src/poller');

let tray = null;
let popup = null;
let iconRenderer = null;
let cachedToken = null;

const state = {
  usage: null,
  localCosts: null,
  subscriptionType: '',
  rateLimitTier: '',
  lastUpdated: null,
  errorMessage: null,
  // Typed credential failure surface. Null while creds are healthy.
  // Shape: { reason: REASON.*, pathsTried: [{source,status,detail?}] }
  credentialError: null,
  isLoading: false,
  hasLoaded: false,
};

const CRED_ERROR_COPY = {
  [REASON.NOT_FOUND]:         'No Claude Code credentials found. Launch Claude Code and sign in.',
  [REASON.UNREADABLE]:        'Credentials file exists but couldn’t be read.',
  [REASON.MALFORMED]:         'Credentials file is unreadable or corrupt.',
  [REASON.EXPIRED]:           'Token expired. Open Claude Code to sign in again.',
  [REASON.LOCKED_KEYCHAIN]:   'Keychain access denied. Click “Always Allow” on the prompt.',
  [REASON.PERMISSION_DENIED]: 'Permission denied reading credentials file.',
};

function loadCredentials() {
  const result = readCredentials();
  if (result.ok) {
    cachedToken = result.oauth.accessToken;
    state.subscriptionType = result.oauth.subscriptionType || '';
    state.rateLimitTier = result.oauth.rateLimitTier || '';
    state.credentialError = null;
    return;
  }
  cachedToken = null;
  state.credentialError = { reason: result.reason, pathsTried: result.pathsTried || [] };
  state.errorMessage = CRED_ERROR_COPY[result.reason] || 'Could not read Claude Code credentials.';
}

function popupVisible() {
  return !!(popup && !popup.isDestroyed() && popup.isVisible());
}

function pushToWindow() {
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('state', snapshotForRenderer(state));
  }
}

const poller = createPoller({
  state,
  getToken: () => cachedToken,
  setToken: (t) => { cachedToken = t; },
  loadCredentials,
  pushToWindow,
  refreshTray: () => refreshTray(),
  popupVisible,
});

async function setupIconRenderer() {
  iconRenderer = new BrowserWindow({
    show: false,
    width: 64, height: 64,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await iconRenderer.loadFile(path.join(__dirname, 'renderer', 'icon.html'));
}

// The drawn icon is 5 segments with a ~10-step partial fill, so the whole
// 0-100% range collapses to a few dozen distinct bitmaps. Key the cache on
// that quantised form and skip the render whenever it repeats.
const iconCache = new Map();

function iconKey(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const exact = (pct / 100) * 5;
  let key = '';
  for (let i = 0; i < 5; i++) {
    const remaining = exact - i;
    if (remaining >= 1) key += 'F';
    else if (remaining > 0.05) key += String(Math.max(1, Math.round(10 * remaining)));
    else key += '0';
  }
  return key;
}

async function makeTrayIcon(percent) {
  if (!iconRenderer) return null;
  const key = iconKey(percent);
  const hit = iconCache.get(key);
  if (hit) return hit;

  const dataUrl = await iconRenderer.webContents.executeJavaScript(
    `window.drawIcon(${percent}, 2)`
  );
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2.0 });
  if (process.platform === 'darwin') img.setTemplateImage(true);
  iconCache.set(key, img);
  return img;
}

let lastIconKey = null;
let lastTitle = null;
let lastTooltip = null;

async function refreshTray() {
  if (!tray) return;
  const percent = state.hasLoaded ? sessionPercent(state) : 0;

  const key = iconKey(percent);
  if (key !== lastIconKey) {
    try {
      const img = await makeTrayIcon(percent);
      if (img) {
        tray.setImage(img);
        lastIconKey = key;
      }
    } catch {}
  }

  const titleText = state.hasLoaded ? `${Math.round(percent)}%` : '--';
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function' && titleText !== lastTitle) {
    tray.setTitle(' ' + titleText);
    lastTitle = titleText;
  }
  const tooltip = buildTooltip();
  if (tooltip !== lastTooltip) {
    tray.setToolTip(tooltip);
    lastTooltip = tooltip;
  }
}

function buildTooltip() {
  if (!state.hasLoaded) return 'Claude Usage: loading…';
  const parts = [
    `Session: ${Math.round(sessionPercent(state))}%`,
    `Weekly: ${Math.round(weeklyPercent(state))}%`,
  ];
  const fable = fablePercent(state);
  if (fable > 0) parts.push(`Fable (7d): ${Math.round(fable)}%`);
  const opus = opusPercent(state);
  if (opus > 0) parts.push(`Opus (7d): ${Math.round(opus)}%`);
  return 'Claude Usage: ' + parts.join(' · ');
}

function createPopup() {
  popup = new BrowserWindow({
    width: 320,
    height: 540,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#1c1c1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  popup.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  popup.on('blur', () => {
    if (popup && popup.isVisible()) popup.hide();
  });
  popup.webContents.on('did-finish-load', () => pushToWindow());
}

function positionPopup() {
  if (!tray || !popup) return;
  const trayBounds = tray.getBounds();
  const winBounds = popup.getBounds();
  const display = screen.getDisplayMatching(trayBounds.width
    ? trayBounds
    : { x: 0, y: 0, width: 1, height: 1 });
  const work = display.workArea;

  let x, y;
  if (trayBounds.width > 0 && trayBounds.height > 0) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    if (process.platform === 'darwin') {
      y = Math.round(trayBounds.y + trayBounds.height + 4);
    } else {
      const aboveTray = trayBounds.y - winBounds.height - 4;
      const belowTray = trayBounds.y + trayBounds.height + 4;
      y = aboveTray >= work.y ? aboveTray : belowTray;
    }
  } else {
    x = work.x + work.width - winBounds.width - 8;
    y = work.y + 8;
  }

  x = Math.max(work.x + 4, Math.min(x, work.x + work.width - winBounds.width - 4));
  y = Math.max(work.y + 4, Math.min(y, work.y + work.height - winBounds.height - 4));
  popup.setPosition(x, y, false);
}

function togglePopup() {
  if (!popup) return;
  if (popup.isVisible()) {
    popup.hide();
    poller.nudge();
    return;
  }
  positionPopup();
  popup.show();
  popup.focus();
  pushToWindow();
  // Opening nudges a refresh; throttle guards still apply.
  poller.refresh();
  poller.nudge();
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open', click: () => togglePopup() },
    { label: 'Refresh', click: () => poller.refresh({ manual: true }) },
    { label: 'Re-read credentials', click: () => poller.refresh({ forceSource: true, manual: true }) },
    { type: 'separator' },
    { label: 'Open Anthropic console', click: () => shell.openExternal('https://console.anthropic.com/') },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

async function setupTray() {
  const initial = (await makeTrayIcon(0)) || nativeImage.createEmpty();
  tray = new Tray(initial);
  tray.setToolTip('Claude Usage: loading…');
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
    tray.setTitle(' …');
  }
  tray.on('click', () => togglePopup());
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
  await refreshTray();
}

// IPC: handle() for anything that returns a value or whose completion the
// renderer awaits; on() for fire-and-forget commands (no return → no point
// paying for a promise round-trip).
ipcMain.handle('get-state', () => snapshotForRenderer(state));
ipcMain.handle('refresh', () => poller.refresh({ manual: true }));
ipcMain.handle('refresh-force', () => poller.refresh({ forceSource: true, manual: true }));

ipcMain.on('hide', () => { if (popup) popup.hide(); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('open-external', (_e, url) => {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return; }
  if (parsed.protocol !== 'https:') return;
  shell.openExternal(parsed.toString());
});
ipcMain.on('set-height', (_e, h) => {
  if (!popup || popup.isDestroyed()) return;
  const want = Math.max(220, Math.min(900, Math.round(Number(h) || 0)));
  const [w] = popup.getSize();
  popup.setSize(w, want, false);
  if (popup.isVisible()) positionPopup();
});

app.on('window-all-closed', (e) => { e.preventDefault(); });

if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (popup) togglePopup(); });

  app.whenReady().then(async () => {
    await setupIconRenderer();
    createPopup();
    await setupTray();
    loadCredentials();
    await poller.start();

    // setTimeout doesn't fire during macOS sleep; force a refresh on wake.
    powerMonitor.on('resume', () => poller.nudge({ immediate: true }));
  });
}

app.on('before-quit', () => { poller.stop(); });
