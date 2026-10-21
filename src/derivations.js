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

// ---------------------------------------------------------------------------
// Gemini derivations
// ---------------------------------------------------------------------------

function geminiSessionPercent(state) {
  return clamp(state.geminiUsage?.five_hour?.utilization);
}

function geminiWeeklyPercent(state) {
  return clamp(state.geminiUsage?.seven_day?.utilization);
}

function geminiProPercent(state) {
  return clamp(
    state.geminiUsage?.pro_five_hour?.utilization
    ?? state.geminiUsage?.five_hour?.utilization
  );
}

function geminiFlashPercent(state) {
  return clamp(
    state.geminiUsage?.flash_five_hour?.utilization
    ?? state.geminiUsage?.five_hour?.utilization
  );
}

function geminiSessionElapsedPercent(state) {
  const resetStr = state.geminiUsage?.five_hour?.resets_at;
  if (!resetStr) return 0;
  const reset = new Date(resetStr);
  if (Number.isNaN(reset.getTime())) return 0;
  const remainingMs = reset.getTime() - Date.now();
  if (remainingMs <= 0) return 100;
  const windowMs = 5 * 3600 * 1000;
  const elapsed = windowMs - remainingMs;
  return Math.max(0, Math.min(100, (elapsed / windowMs) * 100));
}

function geminiWorstWindow(state) {
  const candidates = [
    { tag: 'S', percent: geminiSessionPercent(state) },
    { tag: 'W', percent: geminiWeeklyPercent(state) },
    { tag: 'P', percent: geminiProPercent(state) },
    { tag: 'Fl', percent: geminiFlashPercent(state) },
  ];
  return candidates.reduce((a, b) => (b.percent > a.percent ? b : a));
}

function geminiPlanDisplayName(state) {
  const tierName = state.geminiUsage?.tierName || '';
  const tierId = (state.geminiUsage?.tierId || '').toLowerCase();
  const hasApiKey = Boolean(state.geminiUsage?.apiKeyInfo?.configured);

  let base = '';
  if (tierId.includes('ultra') || /ultra/i.test(tierName)) base = 'Google AI Ultra';
  else if (tierId.includes('pro') || /ai pro/i.test(tierName)) base = 'Google AI Pro';
  else if (tierId.includes('standard')) base = 'Code Assist Standard';
  else if (tierName && tierName !== 'API Key') base = tierName;
  else if (tierId === 'free-tier') base = 'Gemini Free';

  if (base && hasApiKey) return `${base} + API Key`;
  if (base) return base;
  if (hasApiKey) return 'Gemini API Key';
  if (state.geminiLocalCosts && state.geminiLocalCosts.monthTokens > 0) return 'Gemini Local';
  return 'Unknown';
}

function computeGeminiBurnRate(state) {
  if (!state.geminiLocalCosts) return null;
  const su = state.geminiLocalCosts.sessionUsage;
  const totalTokens = su.input + su.output + su.cacheRead + su.cacheWrite;
  const elapsedPct = geminiSessionElapsedPercent(state);
  if (elapsedPct > 0.5) {
    const elapsedMin = (elapsedPct / 100) * (5 * 60);
    if (elapsedMin > 0) return totalTokens <= 0 ? 0 : totalTokens / elapsedMin;
  }
  if (totalTokens <= 0) return 0;
  return totalTokens / (5 * 60);
}

function geminiProjectedSessionPercent(state) {
  const sp = geminiSessionPercent(state);
  const ep = geminiSessionElapsedPercent(state);
  if (ep <= 1) return sp;
  return Math.max(0, Math.min(999, (sp / ep) * 100));
}

function geminiPaceVerdict(state) {
  const sp = geminiSessionPercent(state);
  const ep = geminiSessionElapsedPercent(state);
  if (ep < 2) return 'fresh';
  const ratio = sp / ep;
  if (ratio >= 1.5)  return 'burning';
  if (ratio >= 1.15) return 'fast';
  if (ratio <= 0.5)  return 'idle';
  return 'pace';
}

function geminiExtraUsage(state) {
  const credits = state.geminiUsage?.availableCredits;
  if (Array.isArray(credits) && credits.length > 0) {
    const c = credits[0];
    const rem = Number(c.creditAmount ?? c.remainingAmount);
    if (Number.isFinite(rem) && rem > 0) {
      return {
        is_enabled: true,
        label: 'AI Credits',
        used_credits: null,
        monthly_limit: null,
        display_text: `${rem} credits available`,
      };
    }
  }
  const tp5h = state.geminiUsage?.third_party_five_hour?.utilization;
  const tp7d = state.geminiUsage?.third_party_seven_day?.utilization;
  if ((Number.isFinite(tp5h) && tp5h > 0) || (Number.isFinite(tp7d) && tp7d > 0)) {
    return {
      is_enabled: true,
      label: '3P Partner Quota',
      used_credits: null,
      monthly_limit: null,
      display_text: `${Math.round(tp5h || 0)}% 5h · ${Math.round(tp7d || 0)}% 7d`,
    };
  }
  if (state.geminiUsage?.apiKeyInfo?.configured) {
    const cost = state.geminiLocalCosts?.monthCost ?? 0;
    const status = state.geminiUsage.apiKeyInfo.status || 'valid';
    return {
      is_enabled: true,
      label: 'API Key Spend',
      used_credits: null,
      monthly_limit: null,
      display_text: `$${cost.toFixed(2)} est. (30d · ${status})`,
    };
  }
  return null;
}

function mergeMaps(a, b) {
  const out = {};
  if (a) {
    for (const [k, v] of Object.entries(a)) out[k] = (out[k] || 0) + v;
  }
  if (b) {
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function formatLocalCosts(lc) {
  if (!lc) return null;
  return {
    todayTokens: lc.todayTokens,
    todayCost: lc.todayCost ?? 0,
    weekTokens: lc.weekTokens,
    weekCost: lc.weekCost ?? 0,
    monthTokens: lc.monthTokens,
    monthCost: lc.monthCost ?? 0,
    sessionTotal:  bucketTotal(lc.sessionUsage),
    sessionInput:  lc.sessionUsage.input + lc.sessionUsage.cacheRead + lc.sessionUsage.cacheWrite,
    sessionOutput: lc.sessionUsage.output,
    weeklyTotal:   bucketTotal(lc.weeklyUsage),
    weeklyInput:   lc.weeklyUsage.input + lc.weeklyUsage.cacheRead + lc.weeklyUsage.cacheWrite,
    weeklyOutput:  lc.weeklyUsage.output,
    modelBreakdown: lc.modelBreakdown || {},
    todayModelBreakdown: lc.todayModelBreakdown || {},
    weekModelBreakdown: lc.weekModelBreakdown || {},
    todayModelTokens: lc.todayModelTokens || {},
    weekModelTokens: lc.weekModelTokens || {},
    monthModelTokens: lc.monthModelTokens || {},
    daily: lc.daily || {},
  };
}

function combinedLocalCosts(state) {
  const c = state.localCosts;
  const g = state.geminiLocalCosts;
  if (!c && !g) return null;

  const daily = {};
  const dayKeys = new Set([
    ...Object.keys(c?.daily || {}),
    ...Object.keys(g?.daily || {}),
  ]);
  for (const k of dayKeys) {
    const cd = c?.daily?.[k];
    const gd = g?.daily?.[k];
    daily[k] = {
      tokens: (cd?.tokens || 0) + (gd?.tokens || 0),
      cost: (cd?.cost || 0) + (gd?.cost || 0),
      claudeTokens: cd?.tokens || 0,
      geminiTokens: gd?.tokens || 0,
      claudeCost: cd?.cost || 0,
      geminiCost: gd?.cost || 0,
      models: mergeMaps(cd?.models, gd?.models),
      modelTokens: mergeMaps(cd?.modelTokens, gd?.modelTokens),
    };
  }

  const cSu = c?.sessionUsage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const gSu = g?.sessionUsage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cWu = c?.weeklyUsage  || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const gWu = g?.weeklyUsage  || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    todayTokens: (c?.todayTokens || 0) + (g?.todayTokens || 0),
    todayCost:   (c?.todayCost || 0) + (g?.todayCost || 0),
    weekTokens:  (c?.weekTokens || 0) + (g?.weekTokens || 0),
    weekCost:    (c?.weekCost || 0) + (g?.weekCost || 0),
    monthTokens: (c?.monthTokens || 0) + (g?.monthTokens || 0),
    monthCost:   (c?.monthCost || 0) + (g?.monthCost || 0),
    sessionTotal: bucketTotal(cSu) + bucketTotal(gSu),
    sessionInput: cSu.input + cSu.cacheRead + cSu.cacheWrite + gSu.input + gSu.cacheRead + gSu.cacheWrite,
    sessionOutput: cSu.output + gSu.output,
    weeklyTotal: bucketTotal(cWu) + bucketTotal(gWu),
    weeklyInput: cWu.input + cWu.cacheRead + cWu.cacheWrite + gWu.input + gWu.cacheRead + gWu.cacheWrite,
    weeklyOutput: cWu.output + gWu.output,
    modelBreakdown: mergeMaps(c?.modelBreakdown, g?.modelBreakdown),
    todayModelBreakdown: mergeMaps(c?.todayModelBreakdown, g?.todayModelBreakdown),
    weekModelBreakdown: mergeMaps(c?.weekModelBreakdown, g?.weekModelBreakdown),
    todayModelTokens: mergeMaps(c?.todayModelTokens, g?.todayModelTokens),
    weekModelTokens: mergeMaps(c?.weekModelTokens, g?.weekModelTokens),
    monthModelTokens: mergeMaps(c?.monthModelTokens, g?.monthModelTokens),
    daily,
  };
}

function combinedWorstPercent(state) {
  const cPct = state.hasLoaded ? worstWindow(state).percent : 0;
  const gPct = state.geminiHasLoaded ? geminiWorstWindow(state).percent : 0;
  return Math.max(cPct, gPct);
}

function snapshotForRenderer(state) {
  const cBurn = computeBurnRate(state);
  const gBurn = computeGeminiBurnRate(state);
  const combinedBurn = (cBurn != null || gBurn != null) ? (cBurn || 0) + (gBurn || 0) : null;

  const cPlan = planDisplayName(state);
  const gPlan = geminiPlanDisplayName(state);
  const combinedPlanParts = [];
  if (state.hasLoaded || cPlan !== 'Unknown') combinedPlanParts.push(`Claude ${cPlan}`);
  if (state.geminiHasLoaded || gPlan !== 'Unknown') combinedPlanParts.push(gPlan);

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
    planName: cPlan,
    burnRate: cBurn,
    projectedSessionPercent: projectedSessionPercent(state),
    paceVerdict: paceVerdict(state),
    worstWindowTag: state.hasLoaded ? worstWindow(state).tag : null,
    worstWindowPercent: state.hasLoaded ? worstWindow(state).percent : 0,
    localCosts: formatLocalCosts(state.localCosts),

    gemini: {
      hasLoaded: Boolean(state.geminiHasLoaded),
      isLoading: Boolean(state.isLoading),
      errorMessage: state.geminiErrorMessage || null,
      credentialError: state.geminiCredentialError || null,
      sessionPercent: geminiSessionPercent(state),
      sessionElapsedPercent: geminiSessionElapsedPercent(state),
      weeklyPercent: geminiWeeklyPercent(state),
      proPercent: geminiProPercent(state),
      flashPercent: geminiFlashPercent(state),
      fiveHourResetIn: timeUntilReset(state.geminiUsage?.five_hour?.resets_at),
      sevenDayResetIn: timeUntilReset(state.geminiUsage?.seven_day?.resets_at),
      extraUsage: geminiExtraUsage(state),
      planName: gPlan,
      burnRate: gBurn,
      projectedSessionPercent: geminiProjectedSessionPercent(state),
      paceVerdict: geminiPaceVerdict(state),
      worstWindowTag: state.geminiHasLoaded ? geminiWorstWindow(state).tag : null,
      worstWindowPercent: state.geminiHasLoaded ? geminiWorstWindow(state).percent : 0,
      localCosts: formatLocalCosts(state.geminiLocalCosts),
    },

    combined: {
      hasLoaded: Boolean(state.hasLoaded || state.geminiHasLoaded),
      burnRate: combinedBurn,
      planName: combinedPlanParts.join(' · ') || 'Unknown',
      worstPercent: combinedWorstPercent(state),
      localCosts: combinedLocalCosts(state),
    },
  };
}

module.exports = {
  snapshotForRenderer,
  worstWindow,
  sessionPercent,
  weeklyPercent,
  fablePercent,
  opusPercent,
  geminiSessionPercent,
  geminiWeeklyPercent,
  geminiProPercent,
  geminiFlashPercent,
  geminiWorstWindow,
  combinedWorstPercent,
};
