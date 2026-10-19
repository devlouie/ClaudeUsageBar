const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
function readCredentials() {
  const pathsTried = [];

  if (process.platform === 'darwin') {
    const km = readMacKeychain();
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

function readMacKeychain() {
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }
    ).trim();
    const oauth = parseCredentialPayload(out);
    if (!oauth) {
      return { ok: false, diag: { source: 'keychain', status: 'malformed' } };
    }
    return { ok: true, oauth, diag: { source: 'keychain', status: 'ok' } };
  } catch (e) {
    // exit code 44 = item not found; 51 / non-zero with stderr containing
    // "interaction is not allowed" or similar = locked. We don't get rich
    // structured errors from `security`, so sniff the message text.
    const msg = String(e.stderr || e.message || '');
    if (/not be found|exit code 44/i.test(msg) || e.status === 44) {
      return { ok: false, diag: { source: 'keychain', status: 'not_found' } };
    }
    if (/interaction is not allowed|denied|access/i.test(msg)) {
      return { ok: false, diag: { source: 'keychain', status: 'locked' } };
    }
    return { ok: false, diag: { source: 'keychain', status: 'unreadable', detail: msg } };
  }
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

module.exports = { readCredentials, REASON };
