// Pure(-ish) functions that turn the raw `state` object into the shape the
// renderer + tray expect. No IPC, no timers, no Electron. Keep it that way
// so this file stays trivially testable.

const { bucketTotal } = require('./localUsage');

function clamp(v) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function sessionPercent(state) { return clamp(state.usage?.five_hour?.utilization); }
function weeklyPercent(state)  { return clamp(state.usage?.seven_day?.utilization); }

// As of the 2026-07 weekly-limits rollout, Anthropic exposes per-model weekly
// meters through a `limits[]` array (kind `weekly_scoped`, carrying a
// `scope.model.display_name`) rather than the legacy top-level
// `seven_day_opus` / `seven_day_sonnet` objects. Those now come back `null`.
// Fable in particular has its own weekly allocation ("up to 50% of weekly
// limits" through 2026-07-19, then metered usage credits). We read the scoped
// limit first and fall back to the legacy field so older/newer API shapes both
// light up.
function scopedWeeklyPercent(state, modelName) {
  const limits = state.usage?.limits;
  if (Array.isArray(limits)) {
    const wanted = modelName.toLowerCase();
    for (const l of limits) {
      if (l?.group !== 'weekly' && l?.kind !== 'weekly_scoped') continue;
      const dn = (l?.scope?.model?.display_name || '').toLowerCase();
      const id = (l?.scope?.model?.id || '').toLowerCase();
      if (dn.includes(wanted) || id.includes(wanted)) return clamp(l.percent);
    }
  }
  return null;
}

function fablePercent(state) {
  const scoped = scopedWeeklyPercent(state, 'fable');
  if (scoped != null) return scoped;
  // Mythos shares Fable-tier metering; check it too before the legacy fallback.
  const mythos = scopedWeeklyPercent(state, 'mythos');
  if (mythos != null) return mythos;
  return clamp(state.usage?.seven_day_fable?.utilization);
}

function opusPercent(state) {
  const scoped = scopedWeeklyPercent(state, 'opus');
  if (scoped != null) return scoped;
  return clamp(state.usage?.seven_day_opus?.utilization);
}

function sonnetPercent(state) {
  const scoped = scopedWeeklyPercent(state, 'sonnet');
  if (scoped != null) return scoped;
  return clamp(state.usage?.seven_day_sonnet?.utilization);
}

function sessionElapsedPercent(state) {
  const resetStr = state.usage?.five_hour?.resets_at;
  if (!resetStr) return 0;
  const reset = new Date(resetStr);
  if (Number.isNaN(reset.getTime())) return 0;
  const remainingMs = reset.getTime() - Date.now();
  if (remainingMs <= 0) return 100;
  const windowMs = 5 * 3600 * 1000;
  const elapsed = windowMs - remainingMs;
  return Math.max(0, Math.min(100, (elapsed / windowMs) * 100));
}

function worstWindow(state) {
  const candidates = [
    { tag: 'S', percent: sessionPercent(state) },
    { tag: 'W', percent: weeklyPercent(state) },
    { tag: 'F', percent: fablePercent(state) },
    { tag: 'O', percent: opusPercent(state) },
  ];
  return candidates.reduce((a, b) => (b.percent > a.percent ? b : a));
}

function planDisplayName(state) {
  const sub = (state.subscriptionType || '').toLowerCase();
  const tier = state.rateLimitTier || '';
  if (sub === 'max') {
    if (tier.includes('20x')) return 'Max 20x';
    if (tier.includes('5x'))  return 'Max 5x';
    return 'Max';
  }
  if (sub === 'pro')  return 'Pro';
  if (sub === 'free') return 'Free';
  return state.subscriptionType
    ? state.subscriptionType[0].toUpperCase() + state.subscriptionType.slice(1)
    : 'Unknown';
}

function timeUntilReset(isoString) {
  if (!isoString) return null;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return null;
  const interval = t - Date.now();
  if (interval <= 0) return 'resetting…';
  const totalMin = Math.floor(interval / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor(totalMin / 60) % 24;
  const minutes = totalMin % 60;
  if (days > 0)  return hours > 0 ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${Math.max(1, minutes)}m`;
}

function computeBurnRate(state) {
  // Tokens/min across the current 5h session, derived from local logs.
  if (!state.localCosts) return null;
  const elapsedPct = sessionElapsedPercent(state);
  if (elapsedPct <= 0.5) return null; // avoid div-by-~0 right after reset
  const elapsedMin = (elapsedPct / 100) * (5 * 60);
  if (elapsedMin <= 0) return null;
  const su = state.localCosts.sessionUsage;
  const totalTokens = su.input + su.output + su.cacheRead + su.cacheWrite;
  if (totalTokens <= 0) return 0;
  return totalTokens / elapsedMin;
}

function projectedSessionPercent(state) {
  const sp = sessionPercent(state);
  const ep = sessionElapsedPercent(state);
  if (ep <= 1) return sp;
  return Math.max(0, Math.min(999, (sp / ep) * 100));
}

function paceVerdict(state) {
  const sp = sessionPercent(state);
  const ep = sessionElapsedPercent(state);
  if (ep < 2) return 'fresh';
  const ratio = sp / ep;
  if (ratio >= 1.5)  return 'burning';
  if (ratio >= 1.15) return 'fast';
  if (ratio <= 0.5)  return 'idle';
  return 'pace';
}

function snapshotForRenderer(state) {
  return {
    hasLoaded: state.hasLoaded,
    isLoading: state.isLoading,
    errorMessage: state.errorMessage,
    credentialError: state.credentialError || null,
    lastUpdated: state.lastUpdated ? state.lastUpdated.toISOString() : null,
    sessionPercent: sessionPercent(state),
    sessionElapsedPercent: sessionElapsedPercent(state),
    weeklyPercent: weeklyPercent(state),
    fablePercent: fablePercent(state),
    opusPercent: opusPercent(state),
    sonnetPercent: sonnetPercent(state),
    fiveHourResetIn: timeUntilReset(state.usage?.five_hour?.resets_at),
    sevenDayResetIn: timeUntilReset(state.usage?.seven_day?.resets_at),
    extraUsage: state.usage?.extra_usage ?? null,
    planName: planDisplayName(state),
    burnRate: computeBurnRate(state),
    projectedSessionPercent: projectedSessionPercent(state),
    paceVerdict: paceVerdict(state),
    worstWindowTag: state.hasLoaded ? worstWindow(state).tag : null,
    worstWindowPercent: state.hasLoaded ? worstWindow(state).percent : 0,
    localCosts: state.localCosts ? {
      todayTokens: state.localCosts.todayTokens,
      weekTokens: state.localCosts.weekTokens,
      monthTokens: state.localCosts.monthTokens,
      sessionTotal:  bucketTotal(state.localCosts.sessionUsage),
      sessionInput:  state.localCosts.sessionUsage.input + state.localCosts.sessionUsage.cacheRead + state.localCosts.sessionUsage.cacheWrite,
      sessionOutput: state.localCosts.sessionUsage.output,
      weeklyTotal:   bucketTotal(state.localCosts.weeklyUsage),
      weeklyInput:   state.localCosts.weeklyUsage.input + state.localCosts.weeklyUsage.cacheRead + state.localCosts.weeklyUsage.cacheWrite,
      weeklyOutput:  state.localCosts.weeklyUsage.output,
      modelBreakdown: state.localCosts.modelBreakdown,
    } : null,
  };
}

module.exports = {
  snapshotForRenderer,
  worstWindow,
  sessionPercent,
  weeklyPercent,
  fablePercent,
  opusPercent,
};
