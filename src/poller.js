// Polling orchestration: local JSONL re-parse + the provider usage endpoints.
//
// One timer drives the API loop. Every refresh, whatever started it, re-arms
// that timer when it ends. Throttling is one timestamp + one counter:
//
//   nextAutoAt    next time an auto-scheduled poll is eligible. On 429
//                 Retry-After this also gates manual refresh (we set
//                 `hardLock` to true so manual can't skip past it).
//   errorStep     0 on success; incremented on each failure. Drives the
//                 exponential backoff multiplier.
//
// Manual refreshes can fire before `nextAutoAt` unless `hardLock` is set.
// Only one refresh runs at a time, so a result is never handled twice.

const api = require('./api');
const logs = require('./localUsageClient');
const { REASON } = require('./credentials');

const LOCAL_INTERVAL_MS    = 30 * 1000;
const API_INTERVAL_HIDDEN  = 5  * 60 * 1000;
const API_INTERVAL_VISIBLE = 90 * 1000;
const API_MIN_GAP_MS       = 45 * 1000;
const API_MAX_BACKOFF_MS   = 15 * 60 * 1000;
const API_FIRST_FETCH_DELAY_MS = 400;
const NET_RETRY_MS         = 30 * 1000;
const NET_MAX_RETRY_MS     = 5 * 60 * 1000;
const WAKE_DELAY_MS        = 5 * 1000; // the network needs a moment after sleep
const TIMER_SLOP_MS        = 100;      // timers can fire a hair early

const OFFLINE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
]);

function describeFailure(result, name) {
  if (result.status === 429) return `${name} API throttled. Using local data.`;
  if (result.status >= 500) return `${name} API unavailable (${result.status}).`;
  if (result.error === 'timeout') return `${name} request timed out.`;
  if (result.status == null && OFFLINE_CODES.has(result.code)) return 'Offline.';
  if (result.error) return `${name} API error: ${result.error}`;
  return `${name} API error (HTTP ${result.status ?? '?'}).`;
}

function createPoller({
  state,
  getToken,
  setToken,
  getGeminiCreds = () => null,
  setGeminiCreds = () => {},
  loadCredentials,
  loadGeminiCredentials = async () => {},
  pushToWindow,
  refreshTray,
  popupVisible,
  fetchUsage = api.fetchUsage,
  fetchGeminiUsage = api.fetchGeminiUsage,
  parseLogs = logs.parseLocalLogsAsync,
  stopLogs = logs.stop,
}) {
  let apiTimer = null;
  let localTimer = null;
  let wakeTimer = null;
  let stopped = false;
  let running = null;      // the refresh in flight, if any
  let runningApi = false;  // that refresh is fetching, or was asked to
  let nextAutoAt = 0;
  let lastApiAt = 0;
  let hardLock = false;    // set on 429. Blocks manual too
  let errorStep = 0;

  function notify() {
    try {
      pushToWindow();
      refreshTray();
    } catch (e) {
      console.warn('[poller] notify failed:', e.message);
    }
  }

  function validDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function resetKey() {
    return `${state.usage?.five_hour?.resets_at}|${state.geminiUsage?.five_hour?.resets_at}`;
  }

  // Never rejects. A bad tick keeps the last numbers and the loop carries on.
  async function refreshLocal() {
    try {
      const parsed = await parseLogs({
        sessionResetAt: validDate(state.usage?.five_hour?.resets_at),
        geminiSessionResetAt: validDate(state.geminiUsage?.five_hour?.resets_at),
      });
      state.localCosts = parsed.claude;
      state.geminiLocalCosts = parsed.gemini;
      // Local spend is worth showing even before a provider answers.
      if (parsed.claude.monthTokens > 0) state.hasLoaded = true;
      if (parsed.gemini.monthTokens > 0) state.geminiHasLoaded = true;
    } catch (e) {
      console.warn('[poller] local parse failed:', e.message);
    }
    notify();
  }

  function refresh(opts = {}) {
    if (running) {
      // A forced re-read, or a manual press during a local-only pass, still
      // needs its own run. Anything else shares the run in flight.
      const needsOwnRun = opts.forceSource || (opts.manual && !runningApi);
      return needsOwnRun ? running.then(() => refresh(opts)) : running;
    }
    runningApi = Boolean(opts.manual || opts.forceSource);
    running = runRefresh(opts)
      .catch((e) => console.warn('[poller] refresh failed:', e.message))
      .finally(() => {
        running = null;
        runningApi = false;
        state.isLoading = false;
        notify();
        scheduleApiPoll();
      });
    return running;
  }

  async function runRefresh({ forceSource = false, manual = false }) {
    // A locked keychain prompts the user on every read. Only retry when asked.
    const shouldRead = (missing, credError) =>
      forceSource || (missing && (manual || credError?.reason !== REASON.LOCKED_KEYCHAIN));
    // A Gemini token past its expiry that the app cannot renew is as good as
    // missing. Antigravity or Gemini CLI may have written a new one since.
    const gem = getGeminiCreds();
    const gemExpired = Boolean(gem?.oauth?.expiresAt < Date.now() && !gem.oauth.needsRefresh);
    await Promise.all([
      shouldRead(!getToken(), state.credentialError) ? loadCredentials() : null,
      shouldRead(!gem?.ok || gemExpired, state.geminiCredentialError) ? loadGeminiCredentials() : null,
    ]);

    const hasClaude = Boolean(getToken());
    const gemCreds = getGeminiCreds();
    const hasGemini = Boolean(gemCreds?.ok);

    // Auto polls always wait. Manual polls skip the soft wait but still
    // respect a hard lock (429 Retry-After).
    const waiting = nextAutoAt - Date.now() > TIMER_SLOP_MS && (manual ? hardLock : true);
    if ((!hasClaude && !hasGemini) || waiting) {
      await refreshLocal();
      return;
    }

    runningApi = true;
    lastApiAt = Date.now();
    state.isLoading = true;
    notify();

    const resetsBefore = resetKey();
    const [apiResult, geminiResult] = await Promise.all([
      hasClaude ? fetchClaude() : null,
      hasGemini ? fetchGemini(gemCreds) : null,
      refreshLocal(),
    ]);

    if (apiResult) handleApiResult(apiResult);
    if (geminiResult) handleGeminiResult(geminiResult);
    updateThrottle(apiResult || geminiResult);

    // Session totals are measured from the reset time, so a new one means
    // the local numbers we just parsed used the wrong window.
    if (resetKey() !== resetsBefore) await refreshLocal();
  }

  // Claude Code rotates its access token every few hours. A rejected token is
  // usually just an old one, so re-read and retry right away with the new one.
  async function fetchClaude() {
    const previous = getToken();
    const first = await fetchUsage(previous);
    if (first.status !== 401 && first.status !== 403) return first;
    setToken(null);
    await loadCredentials();
    const next = getToken();
    return next && next !== previous ? fetchUsage(next) : first;
  }

  // Same for Gemini: a rejected token may have been replaced on disk.
  async function fetchGemini(creds) {
    const first = await fetchGeminiUsage(creds);
    if (first.status !== 401 && first.status !== 403) return first;
    await loadGeminiCredentials();
    const next = getGeminiCreds();
    const replaced = next?.ok && next.oauth?.accessToken && next.oauth.accessToken !== creds.oauth?.accessToken;
    return replaced ? fetchGeminiUsage(next) : first;
  }

  function handleApiResult(result) {
    if (result.ok) {
      state.usage = result.data;
      state.hasLoaded = true;
      state.lastUpdated = new Date();
      state.errorMessage = null;
    } else if (result.status === 401 || result.status === 403) {
      // A failed re-read has already set the more specific message.
      if (!state.credentialError) state.errorMessage = 'Token rejected. Open Claude Code to sign in again.';
    } else {
      state.errorMessage = describeFailure(result, 'Anthropic');
    }
  }

  function handleGeminiResult(result) {
    if (result.refreshedOauth) {
      const prev = getGeminiCreds();
      if (prev) setGeminiCreds({ ...prev, oauth: result.refreshedOauth });
    }
    if (result.ok) {
      state.geminiUsage = result.data;
      state.geminiHasLoaded = true;
      state.geminiLastUpdated = new Date();
      state.geminiErrorMessage = null;
    } else if (result.status === 401 || result.status === 403) {
      // A failed re-read has already set the more specific message.
      if (!state.geminiCredentialError) {
        state.geminiErrorMessage = 'Gemini token rejected. Open Antigravity or Gemini CLI to sign in again.';
      }
    } else {
      state.geminiErrorMessage = describeFailure(result, 'Gemini');
    }
  }

  // The primary provider sets the pace, so both share one request budget.
  function updateThrottle(result) {
    const now = Date.now();
    if (result.ok) {
      errorStep = 0;
      hardLock = false;
      nextAutoAt = now + baseCadenceMs();
    } else if (result.status === 429) {
      // Honour Retry-After as a floor. Repeat 429s still back off.
      const explicit = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : null;
      const backoff = explicit == null
        ? exponentialBackoff()
        : Math.max(API_MIN_GAP_MS, explicit, errorStep > 0 ? exponentialBackoff() : 0);
      nextAutoAt = now + backoff;
      hardLock = true;
      errorStep += 1;
    } else if (result.status == null) {
      // No answer at all. Recovery should be quick, and retrying costs no quota.
      errorStep += 1;
      hardLock = false;
      nextAutoAt = now + Math.min(NET_MAX_RETRY_MS, NET_RETRY_MS * 2 ** (errorStep - 1));
    } else {
      errorStep += 1;
      hardLock = false; // soft errors don't block manual
      nextAutoAt = now + exponentialBackoff();
    }
  }

  function baseCadenceMs() {
    return popupVisible() ? API_INTERVAL_VISIBLE : API_INTERVAL_HIDDEN;
  }

  function exponentialBackoff() {
    const base = baseCadenceMs();
    if (errorStep === 0) return base;
    const exp = Math.min(errorStep, 5);
    const backoff = Math.min(API_MAX_BACKOFF_MS, base * 2 ** (exp - 1));
    const jitter = Math.random() * Math.min(5_000, backoff * 0.1);
    return backoff + jitter;
  }

  function scheduleApiPoll() {
    if (stopped || running) return; // a running refresh re-arms when it ends
    clearTimeout(apiTimer);
    if (nextAutoAt <= Date.now()) nextAutoAt = Date.now() + baseCadenceMs();
    apiTimer = setTimeout(() => refresh(), nextAutoAt - Date.now());
  }

  function scheduleLocalPoll() {
    if (stopped) return;
    localTimer = setTimeout(async () => {
      await refreshLocal();
      scheduleLocalPoll();
    }, LOCAL_INTERVAL_MS);
  }

  async function start() {
    state.isLoading = true; // show the skeleton until the first API answer
    await refreshLocal();
    scheduleLocalPoll();
    // Defer the first API call so quick re-launches don't burst rate limits.
    nextAutoAt = Date.now() + API_FIRST_FETCH_DELAY_MS;
    scheduleApiPoll();
  }

  function stop() {
    stopped = true;
    clearTimeout(apiTimer);
    clearTimeout(localTimer);
    clearTimeout(wakeTimer);
    stopLogs();
  }

  // Opening the popup should show current numbers. The hidden cadence is
  // 5 minutes, so pull the next poll forward to the minimum gap.
  function popupOpened() {
    if (!hardLock && errorStep === 0) {
      nextAutoAt = Math.min(nextAutoAt, lastApiAt + API_MIN_GAP_MS);
    }
    return refresh();
  }

  // Timers do not fire during sleep. Refresh on wake once the network is back.
  function wake() {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      if (!hardLock) nextAutoAt = 0;
      refresh();
    }, WAKE_DELAY_MS);
  }

  return { start, stop, refresh, refreshLocal, popupOpened, wake };
}

module.exports = { createPoller };
