const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// macOS may show an "Always Allow" prompt while this runs. Give the user time
// to answer it. The read is async, so a slow answer never blocks the main thread.
const KEYCHAIN_TIMEOUT_MS = 60_000;
const SECURITY_BIN = '/usr/bin/security';

// Reasons returned alongside a failure so the UI can show targeted copy + CTA
// instead of one flat "credentials not found" string.
const REASON = {
  OK:                 'ok',
  NOT_FOUND:          'not_found',
  UNREADABLE:         'unreadable',          // file exists but EACCES / EISDIR / etc.
  MALFORMED:          'malformed',           // file/keychain payload didn't parse
  EXPIRED:            'expired',             // expiresAt < now
  LOCKED_KEYCHAIN:    'locked_keychain',     // macOS keychain access denied
  PERMISSION_DENIED:  'permission_denied',   // generic EACCES
};

// Returns { ok, reason, oauth?, pathsTried } where:
//   ok          - true if a usable oauth payload was found
//   reason      - one of REASON.*; even on ok=true this is 'ok'
//   oauth       - parsed credential payload when ok=true
//   pathsTried  - per-source diagnostic: [{ source, status, detail? }]
//                 source = 'keychain' | absolute file path
//                 status = 'ok' | 'not_found' | 'unreadable' | 'malformed' | 'locked'
async function readCredentials() {
  const pathsTried = [];

  if (process.platform === 'darwin') {
    const km = await readMacKeychain();
    pathsTried.push(km.diag);
    if (km.ok) return success(km.oauth, pathsTried);
    // If keychain is locked, surface that as the headline reason. Falling
    // through silently to file scanning masks the real problem.
    if (km.diag.status === 'locked') {
      return fail(REASON.LOCKED_KEYCHAIN, pathsTried);
    }
  }

  const file = readCredentialsFile(pathsTried);
  if (file.ok) return success(file.oauth, pathsTried);
  return fail(file.reason || REASON.NOT_FOUND, pathsTried);
}

function success(oauth, pathsTried) {
  // Check expiry as a final gate. expiresAt is ms-since-epoch in Claude Code's
  // payload; treat 0/null as "no claim made" → assume valid.
  if (oauth.expiresAt && Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now()) {
    return { ok: false, reason: REASON.EXPIRED, oauth, pathsTried };
  }
  return { ok: true, reason: REASON.OK, oauth, pathsTried };
}

function fail(reason, pathsTried) {
  return { ok: false, reason, pathsTried };
}

// Resolves { status, value?, detail? }, where status is 'ok', 'not_found',
// 'locked', or 'unreadable'. `security` gives no structured errors, so we read
// the exit code and sniff the message text.
function readKeychainItem(service) {
  return new Promise((resolve) => {
    execFile(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: 'ok', value: stdout.trim() });
        const msg = String(stderr || err.message || '');
        if (err.code === 44 || /not be found/i.test(msg)) return resolve({ status: 'not_found' });
        if (err.killed || /interaction is not allowed|denied|cancel|passphrase|access/i.test(msg)) {
          return resolve({ status: 'locked' });
        }
        return resolve({ status: 'unreadable', detail: msg });
      }
    );
  });
}

async function readMacKeychain() {
  const source = 'keychain';
  const item = await readKeychainItem('Claude Code-credentials');
  if (item.status !== 'ok') {
    return { ok: false, diag: { source, status: item.status, ...(item.detail ? { detail: item.detail } : {}) } };
  }
  const oauth = parseCredentialPayload(item.value);
  if (!oauth) return { ok: false, diag: { source, status: 'malformed' } };
  return { ok: true, oauth, diag: { source, status: 'ok' } };
}

function readCredentialsFile(pathsTried) {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude-code', 'credentials.json'),
    path.join(home, '.config', 'claude', 'credentials.json'),
  ];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'claude', 'credentials.json'));
      candidates.push(path.join(process.env.APPDATA, 'Claude', 'credentials.json'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'claude', 'credentials.json'));
    }
  }

  let sawAnyFile = false;
  let lastReason = REASON.NOT_FOUND;

  for (const p of candidates) {
    let exists;
    try { exists = fs.existsSync(p); } catch { exists = false; }
    if (!exists) {
      pathsTried.push({ source: p, status: 'not_found' });
      continue;
    }
    sawAnyFile = true;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      pathsTried.push({ source: p, status: 'unreadable', detail: e.code || e.message });
      lastReason = e.code === 'EACCES' ? REASON.PERMISSION_DENIED : REASON.UNREADABLE;
      continue;
    }
    const parsed = parseCredentialPayload(raw);
    if (!parsed) {
      pathsTried.push({ source: p, status: 'malformed' });
      lastReason = REASON.MALFORMED;
      continue;
    }
    pathsTried.push({ source: p, status: 'ok' });
    return { ok: true, oauth: parsed };
  }

  return { ok: false, reason: sawAnyFile ? lastReason : REASON.NOT_FOUND };
}

function parseCredentialPayload(raw) {
  try {
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth || data;
    if (!oauth || typeof oauth !== 'object') return null;
    if (!oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken ?? null,
      expiresAt: oauth.expiresAt ?? null,
      subscriptionType: oauth.subscriptionType ?? '',
      rateLimitTier: oauth.rateLimitTier ?? '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini credentials (OAuth via Antigravity / Gemini CLI + Gemini API Key)
// ---------------------------------------------------------------------------

async function readGeminiCredentials() {
  const pathsTried = [];
  let oauth = null;
  let oauthReason = REASON.NOT_FOUND;

  // 1. Check local OAuth files first (Antigravity tokens, then ~/.gemini/oauth_creds.json)
  // and macOS Keychain (gemini-cli-oauth).
  const fileRes = readGeminiOAuthFiles(pathsTried);
  if (fileRes.ok) {
    oauth = fileRes.oauth;
  } else {
    oauthReason = fileRes.reason || REASON.NOT_FOUND;
    if (process.platform === 'darwin') {
      const km = await readGeminiMacKeychain();
      pathsTried.push(km.diag);
      if (km.ok) {
        oauth = km.oauth;
      } else if (km.diag.status === 'locked') {
        oauthReason = REASON.LOCKED_KEYCHAIN;
      }
    }
  }

  // Check expiry on OAuth token. If a refreshToken is available, mark
  // needsRefresh=true rather than failing so api.js can mint a fresh token.
  if (oauth) {
    const expired = oauth.expiresAt && Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now();
    if (expired && !oauth.refreshToken) {
      oauth = null;
      oauthReason = REASON.EXPIRED;
    } else if (expired) {
      oauth.needsRefresh = true;
    }
  }

  // 2. Check Gemini API Key (env vars, keychain, ~/.gemini/.env, ~/.gemini/api_key)
  const apiKey = await readGeminiApiKey(pathsTried);

  if (oauth || apiKey) {
    return {
      ok: true,
      reason: REASON.OK,
      oauth,
      apiKey,
      pathsTried,
    };
  }

  return {
    ok: false,
    reason: oauthReason,
    oauth: null,
    apiKey: null,
    pathsTried,
  };
}

function readGeminiOAuthFiles(pathsTried) {
  const home = os.homedir();
  const candidates = [
    { path: path.join(home, '.gemini', 'jetski-standalone-oauth-token'), clientType: 'jetski' },
    { path: path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), clientType: 'jetski' },
    { path: path.join(home, '.gemini', 'oauth_creds.json'), clientType: 'gemini-cli' },
    { path: path.join(home, '.config', 'gemini', 'oauth_creds.json'), clientType: 'gemini-cli' },
  ];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push({
      path: path.join(process.env.APPDATA, 'gemini', 'oauth_creds.json'),
      clientType: 'gemini-cli',
    });
  }

  let sawAny = false;
  let lastReason = REASON.NOT_FOUND;

  for (const { path: p, clientType } of candidates) {
    let exists;
    try { exists = fs.existsSync(p); } catch { exists = false; }
    if (!exists) {
      pathsTried.push({ source: p, status: 'not_found' });
      continue;
    }
    sawAny = true;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      pathsTried.push({ source: p, status: 'unreadable', detail: e.code || e.message });
      lastReason = e.code === 'EACCES' ? REASON.PERMISSION_DENIED : REASON.UNREADABLE;
      continue;
    }
    const parsed = parseGeminiOAuthPayload(raw, clientType, p);
    if (!parsed) {
      pathsTried.push({ source: p, status: 'malformed' });
      lastReason = REASON.MALFORMED;
      continue;
    }
    pathsTried.push({ source: p, status: 'ok' });
    return { ok: true, oauth: parsed };
  }

  return { ok: false, reason: sawAny ? lastReason : REASON.NOT_FOUND };
}

async function readGeminiMacKeychain() {
  const source = 'keychain:gemini-cli-oauth';
  const item = await readKeychainItem('gemini-cli-oauth');
  if (item.status !== 'ok') {
    return { ok: false, diag: { source, status: item.status, ...(item.detail ? { detail: item.detail } : {}) } };
  }
  const oauth = parseGeminiOAuthPayload(item.value, 'gemini-cli', source);
  if (!oauth) return { ok: false, diag: { source, status: 'malformed' } };
  return { ok: true, oauth, diag: { source, status: 'ok' } };
}

function parseGeminiOAuthPayload(raw, defaultClientType = 'gemini-cli', sourcePath = null) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const tok = (data.token && typeof data.token === 'object')
      ? data.token
      : (data.tokens && typeof data.tokens === 'object')
        ? data.tokens
        : data;
    const accessToken = tok.access_token || tok.accessToken || null;
    const refreshToken = tok.refresh_token || tok.refreshToken || null;
    if (!accessToken && !refreshToken) return null;

    let expiresAt = null;
    if (typeof tok.expiry_date === 'number' && Number.isFinite(tok.expiry_date)) {
      expiresAt = tok.expiry_date;
    } else if (typeof tok.expiresAt === 'number' && Number.isFinite(tok.expiresAt)) {
      expiresAt = tok.expiresAt;
    } else if (typeof tok.expiry === 'string' && tok.expiry) {
      const t = Date.parse(tok.expiry);
      if (Number.isFinite(t)) expiresAt = t;
    }

    return {
      accessToken,
      refreshToken,
      clientId: tok.client_id || tok.clientId || data.client_id || data.clientId || null,
      clientSecret: tok.client_secret || tok.clientSecret || data.client_secret || data.clientSecret || null,
      expiresAt,
      tokenType: tok.token_type || tok.tokenType || 'Bearer',
      authMethod: data.auth_method || data.authMethod || 'oauth',
      clientType: defaultClientType,
      sourcePath,
    };
  } catch {
    return null;
  }
}

async function readGeminiApiKey(pathsTried) {
  const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (envKey) {
    pathsTried.push({ source: 'env:GEMINI_API_KEY', status: 'ok' });
    return envKey;
  }

  if (process.platform === 'darwin') {
    const source = 'keychain:gemini-cli-api-key';
    const item = await readKeychainItem('gemini-cli-api-key');
    if (item.status === 'ok' && item.value) {
      let key = item.value;
      try {
        const parsed = JSON.parse(item.value);
        key = parsed?.token?.accessToken || parsed?.apiKey || parsed?.key || null;
      } catch { /* plain string key */ }
      if (typeof key === 'string' && key) {
        pathsTried.push({ source, status: 'ok' });
        return key.trim();
      }
    }
    pathsTried.push({ source, status: item.status === 'ok' ? 'malformed' : item.status });
  }

  const home = os.homedir();
  const envFile = path.join(home, '.gemini', '.env');
  try {
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*(.+)\s*$/);
        if (m) {
          const val = m[1].replace(/^['"]|['"]$/g, '').trim();
          if (val) {
            pathsTried.push({ source: envFile, status: 'ok' });
            return val;
          }
        }
      }
    }
  } catch {}

  const keyFiles = [
    path.join(home, '.gemini', 'api_key'),
    path.join(home, '.config', 'gemini', 'api_key'),
  ];
  for (const p of keyFiles) {
    try {
      if (fs.existsSync(p)) {
        const val = fs.readFileSync(p, 'utf8').trim();
        if (val) {
          pathsTried.push({ source: p, status: 'ok' });
          return val;
        }
      }
    } catch {}
  }

  return null;
}

module.exports = {
  readCredentials,
  readGeminiCredentials,
  parseGeminiOAuthPayload,
  REASON,
};
