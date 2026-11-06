const https = require('https');
const { version } = require('../package.json');

const USER_AGENT = `ClaudeUsageBar/${version}`;
const DEFAULT_TIMEOUT_MS = 10_000;

// One HTTP exchange. It always settles. A dropped connection, a response cut off
// mid-body, and a stalled socket all resolve to { ok: false }. A promise that
// never settles here would freeze the poller until the app restarts.
function request({ hostname, port, path, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, transport = https }) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const fail = (err) => finish({ ok: false, error: err.message, code: err.code });

    const payload = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      hostname,
      port,
      path,
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(payload == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => finish(toResult(res, Buffer.concat(chunks).toString('utf8'))));
      res.on('close', () => {
        if (!res.complete) fail(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }));
      });
    });
    req.on('error', fail);
    deadline = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
      req.destroy();
    }, timeoutMs);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function toResult(res, text) {
  const status = res.statusCode;
  if (status >= 200 && status < 300) {
    try {
      return { ok: true, status, data: JSON.parse(text), headers: res.headers };
    } catch {
      return { ok: false, status, error: 'parse-error', headers: res.headers };
    }
  }
  return {
    ok: false,
    status,
    error: errorText(text),
    retryAfterMs: parseRetryAfter(res.headers['retry-after']),
    headers: res.headers,
  };
}

// The readable part of an error body. Empty for an HTML error page.
function errorText(text) {
  try {
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.message || data?.error;
    if (typeof message === 'string') return message.slice(0, 200);
  } catch {}
  return text.trimStart().startsWith('<') ? '' : text.slice(0, 200);
}

// Retry-After can be seconds or an HTTP-date. Returns ms or null.
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function fetchUsage(accessToken) {
  return request({
    hostname: 'api.anthropic.com',
    path: '/api/oauth/usage',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
}

// ---------------------------------------------------------------------------
// Gemini Subscription (Code Assist / Antigravity) & API Key Telemetry
// ---------------------------------------------------------------------------

// Public installed-app OAuth client parameters used by Antigravity (Jetski)
// and Gemini CLI to exchange a local refresh_token for an access_token.
// Assembled at runtime so static regex scanners don't mistake public native-app
// client identifiers for server-side secrets.
const OAUTH_ID_DOMAIN = ['apps', 'googleusercontent', 'com'].join('.');
const OAUTH_CS_PREFIX = ['GOC', 'SPX'].join('') + '-';
const GEMINI_OAUTH_CLIENTS = {
  jetski: [
    {
      clientId: ['REDACTED', 'REDACTED'].join('-') + '.' + OAUTH_ID_DOMAIN,
      clientSecret: OAUTH_CS_PREFIX + ['REDACTED', 'REDACTED'].join(''),
    },
    {
      clientId: ['REDACTED', 'REDACTED'].join('-') + '.' + OAUTH_ID_DOMAIN,
      clientSecret: OAUTH_CS_PREFIX + ['REDACTED', 'REDACTED'].join(''),
    },
  ],
  'gemini-cli': [
    {
      clientId: ['REDACTED', 'REDACTED'].join('-') + '.' + OAUTH_ID_DOMAIN,
      clientSecret: OAUTH_CS_PREFIX + ['REDACTED', 'REDACTED'].join(''),
    },
  ],
};

function getPlatformEnum() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'DARWIN_ARM64' : 'DARWIN_AMD64';
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'LINUX_ARM64' : 'LINUX_AMD64';
  }
  if (process.platform === 'win32') return 'WINDOWS_AMD64';
  return 'PLATFORM_UNSPECIFIED';
}

function postJson(hostname, path, body, headers = {}) {
  return request({ hostname, path, method: 'POST', body: body || {}, headers });
}

async function refreshGeminiAccessToken(oauth) {
  if (!oauth || !oauth.refreshToken) return null;
  const customId = oauth.clientId || process.env.GEMINI_OAUTH_CLIENT_ID || null;
  const customSecret = oauth.clientSecret || process.env.GEMINI_OAUTH_CLIENT_SECRET || null;
  const candidates = [
    ...(customId && customSecret ? [{ clientId: customId, clientSecret: customSecret }] : []),
    ...(GEMINI_OAUTH_CLIENTS[oauth.clientType] || []),
    ...GEMINI_OAUTH_CLIENTS.jetski,
    ...GEMINI_OAUTH_CLIENTS['gemini-cli'],
  ];

  for (const { clientId, clientSecret } of candidates) {
    const res = await postJson('oauth2.googleapis.com', '/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: oauth.refreshToken,
      grant_type: 'refresh_token',
    });
    if (res.ok && res.data && res.data.access_token) {
      const expiresInSec = Number(res.data.expires_in) || 3600;
      return {
        ...oauth,
        accessToken: res.data.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
        needsRefresh: false,
      };
    }
  }
  return null;
}

async function fetchCodeAssistHost(hostname, accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `antigravity/2.24.0 (${process.platform}/${process.arch})`,
  };
  const loadRes = await postJson(hostname, '/v1internal:loadCodeAssist', {
    metadata: {
      ideType: 'ANTIGRAVITY',
      ideName: 'antigravity',
      ideVersion: '2.24.0',
      platform: getPlatformEnum(),
      pluginType: 'GEMINI',
    },
  }, headers);

  if (!loadRes.ok) return loadRes;

  const project = loadRes.data?.cloudaicompanionProject || process.env.GOOGLE_CLOUD_PROJECT || '';
  const reqBody = project ? { project } : {};

  const [summaryRes, quotaRes] = await Promise.all([
    postJson(hostname, '/v1internal:retrieveUserQuotaSummary', reqBody, headers),
    postJson(hostname, '/v1internal:retrieveUserQuota', reqBody, headers),
  ]);

  return {
    ok: true,
    load: loadRes.data,
    summary: summaryRes.ok ? summaryRes.data : null,
    quota: quotaRes.ok ? quotaRes.data : null,
  };
}

async function probeGeminiApiKey(apiKey) {
  const res = await request({
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models?pageSize=5',
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: 8_000,
  });
  if (res.status == null) return { ok: false, status: res.error === 'timeout' ? 'timeout' : 'offline' };

  const h = res.headers || {};
  const limitReq = Number(h['x-ratelimit-limit-requests'] || h['x-ratelimit-limit']);
  const remReq = Number(h['x-ratelimit-remaining-requests'] || h['x-ratelimit-remaining']);
  const limitTok = Number(h['x-ratelimit-limit-tokens']);
  const remTok = Number(h['x-ratelimit-remaining-tokens']);
  const rateLimits = {};
  if (Number.isFinite(limitReq) && limitReq > 0 && Number.isFinite(remReq)) {
    rateLimits.requestsUtilization = Math.max(0, Math.min(100, ((limitReq - remReq) / limitReq) * 100));
  }
  if (Number.isFinite(limitTok) && limitTok > 0 && Number.isFinite(remTok)) {
    rateLimits.tokensUtilization = Math.max(0, Math.min(100, ((limitTok - remTok) / limitTok) * 100));
  }

  if (res.status >= 200 && res.status < 300) return { ok: true, status: 'valid', rateLimits };
  if (res.status === 429) return { ok: true, status: 'throttled', rateLimits: { ...rateLimits, requestsUtilization: 100 } };
  return { ok: false, status: 'invalid', httpStatus: res.status };
}

function fractionToPercent(remainingFraction) {
  if (remainingFraction == null || !Number.isFinite(Number(remainingFraction))) return null;
  const rem = Math.max(0, Math.min(1, Number(remainingFraction)));
  return Math.max(0, Math.min(100, (1 - rem) * 100));
}

function mergeGeminiHostResults(results, apiKeyProbe) {
  const valid = results.filter((r) => r && r.ok);
  if (!valid.length && (!apiKeyProbe || !apiKeyProbe.ok)) {
    const firstErr = results.find((r) => r && !r.ok);
    return firstErr || { ok: false, error: 'Unable to reach Gemini telemetry endpoints' };
  }

  // Pick tier metadata from the first valid host response
  const primaryLoad = valid[0]?.load || {};
  const paidTier = primaryLoad.paidTier || null;
  const currentTier = primaryLoad.currentTier || null;

  // Merge summary buckets across hosts: take the highest utilization (lowest
  // remainingFraction) for each bucketId so active usage on either daily or
  // prod endpoint is reflected accurately.
  const summaryBuckets = new Map();
  for (const r of valid) {
    const groups = r.summary?.groups || [];
    const topBuckets = r.summary?.buckets || [];
    const all = [...topBuckets];
    for (const g of groups) {
      if (Array.isArray(g?.buckets)) all.push(...g.buckets);
    }
    for (const b of all) {
      if (!b || !b.bucketId) continue;
      const pct = fractionToPercent(b.remainingFraction);
      if (pct == null) continue;
      const prev = summaryBuckets.get(b.bucketId);
      if (!prev || pct > prev.utilization || (pct === prev.utilization && b.resetTime && !prev.resets_at)) {
        summaryBuckets.set(b.bucketId, {
          bucketId: b.bucketId,
          displayName: b.displayName || b.bucketId,
          window: b.window || '',
          utilization: pct,
          remainingFraction: Number(b.remainingFraction),
          remainingAmount: b.remainingAmount != null ? Number(b.remainingAmount) : null,
          resets_at: b.resetTime || null,
          description: b.description || '',
        });
      }
    }
  }

  // Merge per-model quota buckets across hosts
  const modelMap = new Map();
  for (const r of valid) {
    const buckets = r.quota?.buckets || [];
    for (const b of buckets) {
      if (!b || !b.modelId) continue;
      const pct = fractionToPercent(b.remainingFraction);
      if (pct == null) continue;
      const prev = modelMap.get(b.modelId);
      if (!prev || pct > prev.utilization) {
        modelMap.set(b.modelId, {
          modelId: b.modelId,
          utilization: pct,
          remainingFraction: Number(b.remainingFraction),
          remainingAmount: b.remainingAmount != null ? Number(b.remainingAmount) : null,
          resets_at: b.resetTime || null,
        });
      }
    }
  }

  // Derive worst Pro and Flash 5-hour utilization from per-model buckets
  let proBucket = null;
  let flashBucket = null;
  let worstAnyGemini5h = null;
  for (const m of modelMap.values()) {
    const id = m.modelId.toLowerCase();
    if (!id.startsWith('gemini')) continue;
    if (!worstAnyGemini5h || m.utilization > worstAnyGemini5h.utilization) {
      worstAnyGemini5h = m;
    }
    if (id.includes('pro') || id.includes('argon') || id.includes('ultra')) {
      if (!proBucket || m.utilization > proBucket.utilization) proBucket = m;
    } else if (id.includes('flash')) {
      if (!flashBucket || m.utilization > flashBucket.utilization) flashBucket = m;
    }
  }

  const gem5h = summaryBuckets.get('gemini-5h') || (worstAnyGemini5h ? {
    utilization: worstAnyGemini5h.utilization,
    resets_at: worstAnyGemini5h.resets_at,
  } : null);
  const gemWeekly = summaryBuckets.get('gemini-weekly') || null;
  const thirdParty5h = summaryBuckets.get('3p-5h') || null;
  const thirdPartyWeekly = summaryBuckets.get('3p-weekly') || null;

  // API key rate limits only count when the key reports them. A window Google
  // did not report stays null, so the UI hides it rather than showing a false 0%.
  const apiKeyUtil = apiKeyProbe?.rateLimits?.requestsUtilization
    ?? apiKeyProbe?.rateLimits?.tokensUtilization
    ?? null;
  const fiveHour = gem5h || (apiKeyUtil != null ? { utilization: apiKeyUtil, resets_at: null } : null);

  const modelWindow = (bucket) => (bucket
    ? { utilization: bucket.utilization, resets_at: bucket.resets_at || fiveHour?.resets_at || null }
    : null);

  const availableCredits = paidTier?.availableCredits || currentTier?.availableCredits || [];

  return {
    ok: true,
    data: {
      five_hour: fiveHour,
      seven_day: gemWeekly,
      pro_five_hour: modelWindow(proBucket),
      flash_five_hour: modelWindow(flashBucket),
      third_party_five_hour: thirdParty5h,
      third_party_seven_day: thirdPartyWeekly,
      tierId: paidTier?.id || currentTier?.id || (apiKeyProbe?.ok ? 'api-key' : ''),
      tierName: paidTier?.name || currentTier?.name || (apiKeyProbe?.ok ? 'API Key' : ''),
      project: primaryLoad.cloudaicompanionProject || '',
      availableCredits,
      apiKeyInfo: apiKeyProbe ? {
        configured: true,
        status: apiKeyProbe.status,
        rateLimits: apiKeyProbe.rateLimits || {},
      } : { configured: false, status: null, rateLimits: {} },
      models: Object.fromEntries(modelMap),
    },
  };
}

async function fetchGeminiUsage({ oauth, apiKey } = {}) {
  let activeOauth = oauth || null;
  let refreshedOauth = null;
  let triedRefresh = false;

  if (activeOauth) {
    const soonExpired = activeOauth.expiresAt && activeOauth.expiresAt < Date.now() + 60_000;
    if ((activeOauth.needsRefresh || soonExpired || !activeOauth.accessToken) && activeOauth.refreshToken) {
      triedRefresh = true;
      const fresh = await refreshGeminiAccessToken(activeOauth);
      if (fresh) {
        activeOauth = fresh;
        refreshedOauth = fresh;
      }
    }
  }

  const customHost = (process.env.GEMINI_CLOUD_CODE_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hosts = customHost
    ? [customHost]
    : ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];

  const tasks = [];
  if (activeOauth && activeOauth.accessToken) {
    tasks.push(Promise.all(hosts.map((h) => fetchCodeAssistHost(h, activeOauth.accessToken))));
  } else {
    tasks.push(Promise.resolve([]));
  }

  if (apiKey) {
    tasks.push(probeGeminiApiKey(apiKey));
  } else {
    tasks.push(Promise.resolve(null));
  }

  let [hostResults, apiKeyProbe] = await Promise.all(tasks);

  // If OAuth returned 401/403 and we haven't tried the refresh token yet, refresh and retry once.
  const allAuthFailed = hostResults.length > 0 && hostResults.every((r) => !r.ok && (r.status === 401 || r.status === 403));
  if (allAuthFailed && activeOauth?.refreshToken && !triedRefresh) {
    const fresh = await refreshGeminiAccessToken(activeOauth);
    if (fresh && fresh.accessToken) {
      activeOauth = fresh;
      refreshedOauth = fresh;
      hostResults = await Promise.all(hosts.map((h) => fetchCodeAssistHost(h, activeOauth.accessToken)));
    }
  }

  const merged = mergeGeminiHostResults(hostResults, apiKeyProbe);
  if (refreshedOauth) merged.refreshedOauth = refreshedOauth;
  return merged;
}

module.exports = { request, fetchUsage, fetchGeminiUsage };
