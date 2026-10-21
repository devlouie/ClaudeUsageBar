// Polling orchestration: local JSONL re-parse + Anthropic usage endpoint.
//
// Throttling collapses to one timestamp + one counter (the previous design
// had three overlapping vars (lastApiAttemptAt, apiCooldownUntil,
// consecutiveErrors) doing roughly the same job):
//
//   nextAutoAt    next time an auto-scheduled poll is eligible. On 429
//                 Retry-After this also gates manual refresh (we set
//                 `hardLock` to true so manual can't skip past it).
//   errorStep     0 on success; incremented on each failure. Drives the
//                 exponential backoff multiplier.
//
// Manual refreshes can fire before `nextAutoAt` unless `hardLock` is set.

const { fetchUsage, fetchGeminiUsage } = require('./api');
const { parseLocalLogsAsync, stop: stopWorker } = require('./localUsageClient');

function createPoller({
  state,
  getToken,
  setToken,
  getGeminiCreds = () => null,
  setGeminiCreds = () => {},
  loadCredentials,
  loadGeminiCredentials = () => {},
  pushToWindow,
  refreshTray,
  popupVisible,
}) {
  const LOCAL_INTERVAL_MS    = 30 * 1000;
  const API_INTERVAL_HIDDEN  = 5  * 60 * 1000;
  const API_INTERVAL_VISIBLE = 90 * 1000;
  const API_MIN_GAP_MS       = 45 * 1000;
  const API_MAX_BACKOFF_MS   = 15 * 60 * 1000;
  const API_FIRST_FETCH_DELAY_MS = 400;

  let apiTimer = null;
  let localTimer = null;
  let inflight = null;
  let geminiInflight = null;
  let nextAutoAt = 0;
  let hardLock = false;        // set on 429. Blocks manual too
  let errorStep = 0;

  function validDate(d) {
    if (!d) return null;
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async function refreshLocal() {
    const sessionResetAt = state.usage?.five_hour?.resets_at
      ? new Date(state.usage.five_hour.resets_at) : null;
    const weeklyResetAt = state.usage?.seven_day?.resets_at
      ? new Date(state.usage.seven_day.resets_at) : null;
    const geminiSessionResetAt = state.geminiUsage?.five_hour?.resets_at
      ? new Date(state.geminiUsage.five_hour.resets_at) : null;
    const geminiWeeklyResetAt = state.geminiUsage?.seven_day?.resets_at
      ? new Date(state.geminiUsage.seven_day.resets_at) : null;

    const logs = await parseLocalLogsAsync({
      provider: 'both',
      sessionResetAt: validDate(sessionResetAt),
      weeklyResetAt: validDate(weeklyResetAt),
      geminiSessionResetAt: validDate(geminiSessionResetAt),
      geminiWeeklyResetAt: validDate(geminiWeeklyResetAt),
    });
    if (logs && logs.claude && logs.gemini) {
      state.localCosts = logs.claude;
      state.geminiLocalCosts = logs.gemini;
    } else {
      state.localCosts = logs;
    }
    if (state.geminiLocalCosts && state.geminiLocalCosts.monthTokens > 0 && !state.geminiHasLoaded && !getGeminiCreds()?.ok) {
      state.geminiHasLoaded = true;
    }
    state.lastUpdated = new Date();
    pushToWindow();
    await refreshTray();
  }

  async function refresh({ forceSource = false, manual = false } = {}) {
    state.isLoading = true;
    pushToWindow();

    if (forceSource || !getToken()) loadCredentials();
    if (forceSource || !getGeminiCreds()?.ok) loadGeminiCredentials();

    const hasClaude = Boolean(getToken());
    const gemCreds = getGeminiCreds();
    const hasGemini = Boolean(gemCreds && gemCreds.ok);

    if (!hasClaude && !hasGemini) {
      errorStep += 1;
      await refreshLocal();
      state.isLoading = false;
      pushToWindow();
      await refreshTray();
      return;
    }

    const now = Date.now();
    const waitMs = nextAutoAt - now;
    // Auto polls always wait. Manual polls skip the soft wait but still
    // respect a hard lock (429 Retry-After).
    const skipApi = waitMs > 0 && (manual ? hardLock : true);

    if (skipApi) {
      await refreshLocal();
      state.isLoading = false;
      pushToWindow();
      return;
    }

    if (hasClaude && !inflight) {
      inflight = fetchUsage(getToken()).finally(() => { inflight = null; });
    }
    if (hasGemini && !geminiInflight) {
      geminiInflight = fetchGeminiUsage(gemCreds).finally(() => { geminiInflight = null; });
    }

    const hadResetWindows = Boolean(
      state.usage?.five_hour?.resets_at && state.geminiUsage?.five_hour?.resets_at
    );

    const [apiResult, geminiResult] = await Promise.all([
      hasClaude ? inflight : Promise.resolve(null),
      hasGemini ? geminiInflight : Promise.resolve(null),
      refreshLocal(),
    ]);

    if (apiResult) handleApiResult(apiResult);
    if (geminiResult) handleGeminiApiResult(geminiResult);

    if (!hadResetWindows && (apiResult?.ok || geminiResult?.ok)) {
      await refreshLocal();
    }

    state.isLoading = false;
    pushToWindow();
    await refreshTray();
  }

  function handleGeminiApiResult(geminiResult) {
    if (geminiResult.refreshedOauth) {
      const prev = getGeminiCreds();
      if (prev) setGeminiCreds({ ...prev, oauth: geminiResult.refreshedOauth });
    }
    if (geminiResult.ok) {
      state.geminiUsage = geminiResult.data;
      state.geminiHasLoaded = true;
      state.geminiErrorMessage = null;
      if (!getToken()) onSuccess();
      return;
    }
    if (geminiResult.status === 401 || geminiResult.status === 403) {
      loadGeminiCredentials();
      state.geminiErrorMessage = 'Gemini token expired or unauthorized. Sign in again.';
    } else if (geminiResult.status === 429) {
      state.geminiErrorMessage = 'Gemini API throttled. Using local data.';
    } else if (geminiResult.error === 'timeout') {
      state.geminiErrorMessage = 'Gemini request timed out.';
    } else if (geminiResult.code === 'ENOTFOUND' || geminiResult.code === 'EAI_AGAIN') {
      state.geminiErrorMessage = 'Offline';
    } else {
      state.geminiErrorMessage = geminiResult.error
        ? `Gemini API error: ${geminiResult.error}`
        : `Gemini API error (HTTP ${geminiResult.status ?? '?'})`;
    }
    if (state.geminiLocalCosts && state.geminiLocalCosts.monthTokens > 0) {
      state.geminiHasLoaded = true;
    }
    if (!getToken()) onError();
  }

  function handleApiResult(apiResult) {
    if (apiResult.ok) {
      state.usage = apiResult.data;
      state.hasLoaded = true;
      state.errorMessage = null;
      onSuccess();
      return;
    }

    if (apiResult.status === 401 || apiResult.status === 403) {
      const previous = getToken();
      setToken(null);
      loadCredentials();
      if (getToken() && getToken() !== previous) {
        // Fresh token on disk. Treat like recovery so next poll fires soon.
        state.errorMessage = 'Re-read credentials; retrying soon.';
        onSuccess();
      } else {
        state.errorMessage = getToken()
          ? 'Token rejected. Open Claude Code to sign in again.'
          : 'Token expired. Open Claude Code to sign in again.';
        onError();
      }
      return;
    }

    if (apiResult.status === 429) {
      // Honour Retry-After if present; else exponential backoff.
      const explicit = Number.isFinite(apiResult.retryAfterMs) ? apiResult.retryAfterMs : null;
      const backoff = explicit != null
        ? Math.max(API_MIN_GAP_MS, explicit)
        : exponentialBackoff();
      nextAutoAt = Date.now() + backoff;
      hardLock = true;
      errorStep += 1;
      state.errorMessage = 'API throttled. Using local data';
      return;
    }

    if (apiResult.status >= 500) {
      state.errorMessage = `Anthropic API unavailable (${apiResult.status}).`;
    } else if (apiResult.error === 'timeout') {
      state.errorMessage = 'Request timed out.';
    } else if (apiResult.code === 'ENOTFOUND' || apiResult.code === 'EAI_AGAIN') {
      state.errorMessage = 'Offline';
    } else {
      state.errorMessage = apiResult.error
        ? `API error: ${apiResult.error}`
        : `API error (HTTP ${apiResult.status ?? '?'})`;
    }
    onError();
  }

  function onSuccess() {
    errorStep = 0;
    hardLock = false;
    nextAutoAt = Date.now() + baseCadenceMs();
  }

  function onError() {
    errorStep += 1;
    hardLock = false; // soft errors don't block manual
    nextAutoAt = Date.now() + exponentialBackoff();
  }

  function baseCadenceMs() {
    return popupVisible() ? API_INTERVAL_VISIBLE : API_INTERVAL_HIDDEN;
  }

  function exponentialBackoff() {
    const base = baseCadenceMs();
    if (errorStep === 0) return base;
    const exp = Math.min(errorStep, 5);
    const backoff = Math.min(API_MAX_BACKOFF_MS, base * Math.pow(2, exp - 1));
    const jitter = Math.random() * Math.min(5_000, backoff * 0.1);
    return backoff + jitter;
  }

  function scheduleApiPoll() {
    if (apiTimer) clearTimeout(apiTimer);
    const wait = Math.max(0, nextAutoAt - Date.now());
    apiTimer = setTimeout(async () => {
      await refresh();
      scheduleApiPoll();
    }, wait || baseCadenceMs());
  }

  function scheduleLocalPoll() {
    if (localTimer) clearTimeout(localTimer);
    localTimer = setTimeout(async () => {
      await refreshLocal();
      scheduleLocalPoll();
    }, LOCAL_INTERVAL_MS);
  }

  async function start() {
    await refreshLocal();
    scheduleLocalPoll();
    // Defer the first API call so quick re-launches don't burst rate limits.
    nextAutoAt = Date.now() + API_FIRST_FETCH_DELAY_MS;
    apiTimer = setTimeout(async () => {
      await refresh();
      scheduleApiPoll();
    }, API_FIRST_FETCH_DELAY_MS);
  }

  function stop() {
    if (apiTimer) clearTimeout(apiTimer);
    if (localTimer) clearTimeout(localTimer);
    apiTimer = null;
    localTimer = null;
    stopWorker();
  }

  // Called by main when the popup is toggled (cadence changes) or the system
  // wakes from sleep. Re-anchors the auto schedule and triggers an immediate
  // refresh on the user's behalf.
  function nudge({ immediate = false } = {}) {
    if (immediate) {
      nextAutoAt = 0;
      refresh({ manual: true });
    }
    scheduleApiPoll();
  }

  return { start, stop, refresh, refreshLocal, nudge };
}

module.exports = { createPoller };
