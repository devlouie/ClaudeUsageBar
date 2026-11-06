const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, screen, shell, powerMonitor } = require('electron');
const path = require('path');

const { readCredentials, readGeminiCredentials, REASON } = require('./src/credentials');
const {
  snapshotForRenderer,
  claudeLimits,
  geminiLimits,
  sessionPercent,
  geminiSessionPercent,
  combinedWorstPercent,
} = require('./src/derivations');
const { createPoller } = require('./src/poller');
const { drawTrayIcon } = require('./src/trayIcon');

const isMac = process.platform === 'darwin';

let tray = null;
let popup = null;
let cachedToken = null;
let cachedGeminiCreds = null;

const state = {
  usage: null,
  localCosts: null,
  subscriptionType: '',
  rateLimitTier: '',
  lastUpdated: null,       // last successful Claude usage fetch
  errorMessage: null,
  // Typed credential failure surface. Null while creds are healthy.
  // Shape: { reason: REASON.*, pathsTried: [{source,status,detail?}] }
  credentialError: null,
  isLoading: false,
  hasLoaded: false,

  // Gemini subscription + API key + local log telemetry state
  geminiUsage: null,
  geminiLocalCosts: null,
  geminiLastUpdated: null, // last successful Gemini usage fetch
  geminiErrorMessage: null,
  geminiCredentialError: null,
  geminiHasLoaded: false,
};

const CRED_ERROR_COPY = {
  [REASON.NOT_FOUND]:         'No Claude Code credentials found. Launch Claude Code and sign in.',
  [REASON.UNREADABLE]:        'Credentials file exists but couldn’t be read.',
  [REASON.MALFORMED]:         'Credentials file is unreadable or corrupt.',
  [REASON.EXPIRED]:           'Token expired. Open Claude Code to refresh it.',
  [REASON.LOCKED_KEYCHAIN]:   'Keychain access denied. Press Re-check, then click “Always Allow”.',
  [REASON.PERMISSION_DENIED]: 'Permission denied reading credentials file.',
};

const GEMINI_CRED_ERROR_COPY = {
  [REASON.NOT_FOUND]:         'No Gemini credentials found. Sign into Gemini CLI or Antigravity, or set GEMINI_API_KEY.',
  [REASON.UNREADABLE]:        'Gemini credentials file exists but couldn’t be read.',
  [REASON.MALFORMED]:         'Gemini credentials file is unreadable or corrupt.',
  [REASON.EXPIRED]:           'Gemini token expired. Open Gemini CLI or Antigravity to sign in again.',
  [REASON.LOCKED_KEYCHAIN]:   'Keychain access denied for Gemini credentials.',
  [REASON.PERMISSION_DENIED]: 'Permission denied reading Gemini credentials file.',
};

async function loadCredentials() {
  const result = await readCredentials();
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

async function loadGeminiCredentials() {
  const result = await readGeminiCredentials();
  if (result.ok) {
    cachedGeminiCreds = result;
    state.geminiCredentialError = null;
    return;
  }
  cachedGeminiCreds = null;
  state.geminiCredentialError = { reason: result.reason, pathsTried: result.pathsTried || [] };
  state.geminiErrorMessage = GEMINI_CRED_ERROR_COPY[result.reason] || 'Could not read Gemini credentials.';
}

function popupVisible() {
  return Boolean(popup && !popup.isDestroyed() && popup.isVisible());
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
  getGeminiCreds: () => cachedGeminiCreds,
  setGeminiCreds: (c) => { cachedGeminiCreds = c; },
  loadCredentials,
  loadGeminiCredentials,
  pushToWindow,
  refreshTray: () => refreshTray(),
  popupVisible,
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayImage(percent) {
  // macOS tints template images itself. Other desktops need a contrasting colour.
  const level = !isMac && nativeTheme.shouldUseDarkColors ? 255 : 0;
  const { buffer, width, height, scaleFactor } = drawTrayIcon(percent, { level });
  const img = nativeImage.createFromBitmap(buffer, { width, height, scaleFactor });
  if (isMac) img.setTemplateImage(true);
  return img;
}

let lastIconStamp = null;
let lastTitle = null;
let lastTooltip = null;

function refreshTray() {
  if (!tray) return;

  const percent = Math.round(combinedWorstPercent(state));
  const stamp = `${percent}:${nativeTheme.shouldUseDarkColors}`;
  if (stamp !== lastIconStamp) {
    tray.setImage(trayImage(percent));
    lastIconStamp = stamp;
  }

  const title = buildTitle();
  if (isMac && title !== lastTitle) {
    tray.setTitle(' ' + title);
    lastTitle = title;
  }

  const tooltip = buildTooltip();
  if (tooltip !== lastTooltip) {
    tray.setToolTip(tooltip);
    lastTooltip = tooltip;
  }
}

function buildTitle() {
  const parts = [];
  if (state.usage) parts.push(`C ${Math.round(sessionPercent(state))}%`);
  if (state.geminiUsage) parts.push(`G ${Math.round(geminiSessionPercent(state))}%`);
  return parts.join(' · ') || '--';
}

function buildTooltip() {
  const describe = (name, rows) => `${name}: ${rows.map((r) => `${r.short} ${Math.round(r.percent)}%`).join(' · ')}`;
  const lines = [];
  const cRows = claudeLimits(state);
  const gRows = geminiLimits(state);
  if (cRows.length) lines.push(describe('Claude', cRows));
  if (gRows.length) lines.push(describe('Gemini', gRows));
  return lines.join('\n') || 'Claude & Gemini Usage: loading…';
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open', click: () => togglePopup() },
    { label: 'Refresh', click: () => poller.refresh({ manual: true }) },
    { label: 'Re-read credentials', click: () => poller.refresh({ forceSource: true, manual: true }) },
    { type: 'separator' },
    { label: 'Open Anthropic console', click: () => shell.openExternal('https://console.anthropic.com/') },
    { label: 'Open Google AI Studio', click: () => shell.openExternal('https://aistudio.google.com/') },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

function setupTray() {
  tray = new Tray(trayImage(0));
  refreshTray();
  tray.on('click', () => togglePopup());
  if (process.platform === 'linux') {
    // Most Linux desktops send no tray clicks. The menu is the only way in.
    tray.setContextMenu(buildContextMenu());
  } else {
    tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
  }
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

// Clicking the tray while the popup is open blurs it first, which hides it.
// That same click must then close the popup, not open it again.
const BLUR_CLICK_GUARD_MS = 250;
let lastBlurHideAt = 0;

function windowBackground() {
  if (isMac) return '#00000000';
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#fcfcfd';
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
    fullscreenable: false,
    transparent: isMac,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Open on the current Space and over full-screen apps, like a menu.
  popup.setAlwaysOnTop(true, 'pop-up-menu');
  popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

  const page = path.join(__dirname, 'renderer', 'index.html');
  const { webContents } = popup;
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (e) => e.preventDefault());
  webContents.on('did-finish-load', () => pushToWindow());
  webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') popup.loadFile(page);
  });

  popup.on('blur', () => {
    if (popupVisible()) {
      popup.hide();
      lastBlurHideAt = Date.now();
    }
  });
  popup.loadFile(page);
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
    if (isMac) {
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
    return;
  }
  if (Date.now() - lastBlurHideAt < BLUR_CLICK_GUARD_MS) return;
  positionPopup();
  popup.show();
  popup.focus();
  pushToWindow();
  poller.popupOpened();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// handle() for anything that returns a value or whose completion the renderer
// awaits; on() for fire-and-forget commands.
ipcMain.handle('get-state', () => snapshotForRenderer(state));
ipcMain.handle('refresh', () => poller.refresh({ manual: true }));
ipcMain.handle('refresh-force', () => poller.refresh({ forceSource: true, manual: true }));

ipcMain.on('hide', () => { if (popup) popup.hide(); });
ipcMain.on('quit', () => app.quit());
ipcMain.on('set-height', (_e, h) => {
  if (!popup || popup.isDestroyed()) return;
  // A popup taller than the screen scrolls instead of running off the edge.
  const maxHeight = screen.getDisplayMatching(popup.getBounds()).workArea.height - 8;
  const want = Math.max(220, Math.min(maxHeight, Math.round(Number(h) || 0)));
  const [w] = popup.getSize();
  popup.setSize(w, want, false);
  if (popup.isVisible()) positionPopup();
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// A tray app stays alive with no windows open.
app.on('window-all-closed', () => {});

if (isMac && app.dock) app.dock.hide();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePopup());

  app.whenReady().then(async () => {
    createPopup();
    setupTray();
    nativeTheme.on('updated', () => {
      if (popup && !popup.isDestroyed()) popup.setBackgroundColor(windowBackground());
      refreshTray();
    });
    powerMonitor.on('resume', () => poller.wake());
    await poller.start();
  }).catch((e) => console.error('[main] startup failed:', e));
}

app.on('before-quit', () => { poller.stop(); });
