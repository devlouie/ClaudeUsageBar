// Pure(-ish) functions that turn the raw `state` object into the shape the
// renderer + tray expect. No IPC, no timers, no Electron. Keep it that way
// so this file stays trivially testable.

const SESSION_MS = 5 * 3600 * 1000;

function clamp(v) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

// ---------------------------------------------------------------------------
// Windows. A window is { utilization, resets_at }.
// ---------------------------------------------------------------------------

function resetTime(win) {
  const t = Date.parse(win?.resets_at ?? '');
  return Number.isFinite(t) ? t : null;
}

// Once a window's reset time passes, its last reading is history. A failed or
// delayed poll must not keep a limit pinned at a number that no longer applies.
function windowPercent(win) {
  const reset = resetTime(win);
  if (reset != null && reset <= Date.now()) return 0;
  return clamp(win?.utilization);
}

function windowElapsedPercent(win, lengthMs) {
  const reset = resetTime(win);
  if (reset == null) return 0;
  const remaining = reset - Date.now();
  if (remaining <= 0) return 0;
  return clamp(((lengthMs - remaining) / lengthMs) * 100);
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

// How the session is tracking against the clock. Too early to judge in the
// first 15 minutes (5% of the window). A ratio above 1 runs out before reset.
function sessionPace(win) {
  const percent = windowPercent(win);
  const elapsedPct = windowElapsedPercent(win, SESSION_MS);
  const ratio = elapsedPct > 0 ? percent / elapsedPct : 0;
  let verdict = 'pace';
  if (elapsedPct < 5) verdict = 'fresh';
  else if (ratio >= 1.5) verdict = 'burning';
  else if (ratio >= 1.02) verdict = 'fast';
  else if (ratio <= 0.5) verdict = 'idle';
  const projectedPct = elapsedPct <= 1 ? percent : Math.min(999, ratio * 100);
  return { elapsedPct, projectedPct, verdict };
}

function limitRow(key, label, short, win, { paced = false } = {}) {
  return {
    key,
    label,
    short,
    percent: windowPercent(win),
    resetIn: timeUntilReset(win?.resets_at),
    pace: paced ? sessionPace(win) : null,
  };
}

function worstPercent(rows) {
  return rows.reduce((max, r) => Math.max(max, r.percent), 0);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

// Anthropic reports per-model weekly meters through a `limits[]` array (kind
// `weekly_scoped`, carrying `scope.model.display_name`). Whichever models the
// plan meters show up here, so we list them rather than assume. The legacy
// top-level `seven_day_*` objects now come back null, and are read only as a
// fallback for older API shapes.
function scopedLimits(usage) {
  const found = new Map();
  for (const l of Array.isArray(usage?.limits) ? usage.limits : []) {
    if (l?.group !== 'weekly' && l?.kind !== 'weekly_scoped') continue;
    const name = l?.scope?.model?.display_name || l?.scope?.model?.id;
    if (!name) continue;
    found.set(String(name).toLowerCase(), { name, win: { utilization: l.percent, resets_at: l.resets_at } });
  }
  const legacy = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet' };
  for (const [key, name] of Object.entries(legacy)) {
    const win = usage?.[`seven_day_${key}`];
    if (win && !found.has(key)) found.set(key, { name, win });
  }
  return [...found.entries()].map(([key, v]) => ({ key, ...v }));
}

function claudeLimits(state) {
  const u = state.usage;
  if (!u) return [];
  const rows = [limitRow('session', 'Session', 'Session', u.five_hour, { paced: true })];
  if (u.seven_day) rows.push(limitRow('weekly', 'Weekly', 'Weekly', u.seven_day));
  for (const { key, name, win } of scopedLimits(u)) {
    rows.push(limitRow(key, `${name} 7d`, name, win));
  }
  return rows;
}

function sessionPercent(state) {
  return windowPercent(state.usage?.five_hour);
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

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// used_credits and monthly_limit are in minor units. `decimal_places` says how
// many, so 1234 with 2 places is $12.34.
function claudeExtraUsage(state) {
  const ex = state.usage?.extra_usage;
  if (!ex?.is_enabled || ex.used_credits == null) return null;
  const scale = 10 ** (Number.isInteger(ex.decimal_places) ? ex.decimal_places : 2);
  const currency = ex.currency || 'USD';
  const used = Number(ex.used_credits) / scale;
  if (!Number.isFinite(used)) return null;
  const limit = ex.monthly_limit == null ? null : Number(ex.monthly_limit) / scale;
  if (limit > 0) {
    return {
      label: 'Extra usage',
      percent: clamp((used / limit) * 100),
      text: `${formatMoney(used, currency)} / ${formatMoney(limit, currency)}`,
    };
  }
  return { label: 'Extra usage', percent: null, text: `${formatMoney(used, currency)} used` };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

function geminiLimits(state) {
  const u = state.geminiUsage;
  if (!u) return [];
  const rows = [];
  if (u.five_hour) rows.push(limitRow('session', 'Gemini 5h', 'Session 5h', u.five_hour, { paced: true }));
  if (u.seven_day) rows.push(limitRow('weekly', 'Gemini 7d', 'Weekly 7d', u.seven_day));

  // Per-model buckets usually repeat the session number. Show one only when it
  // says something the session row does not.
  const session = Math.round(windowPercent(u.five_hour));
  if (u.pro_five_hour && Math.round(windowPercent(u.pro_five_hour)) !== session) {
    rows.push(limitRow('pro', 'Gemini Pro', 'Pro', u.pro_five_hour));
  }
  if (u.flash_five_hour && Math.round(windowPercent(u.flash_five_hour)) !== session) {
    rows.push(limitRow('flash', 'Gemini Flash', 'Flash', u.flash_five_hour));
  }

  // Partner models (Claude and GPT inside Antigravity) have their own quota.
  if (u.third_party_five_hour) {
    rows.push(limitRow('partner5h', 'Partner models 5h', 'Partner 5h', u.third_party_five_hour));
  }
  if (u.third_party_seven_day) {
    rows.push(limitRow('partner7d', 'Partner models 7d', 'Partner 7d', u.third_party_seven_day));
  }
  return rows;
}

function geminiSessionPercent(state) {
  return windowPercent(state.geminiUsage?.five_hour);
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

function geminiExtraUsage(state) {
  const credits = state.geminiUsage?.availableCredits;
  if (Array.isArray(credits) && credits.length > 0) {
    const c = credits[0];
    const rem = Number(c.creditAmount ?? c.remainingAmount);
    if (Number.isFinite(rem) && rem > 0) {
      return { label: 'AI credits', percent: null, text: `${rem} credits available` };
    }
  }
  if (state.geminiUsage?.apiKeyInfo?.configured) {
    const usd = state.geminiLocalCosts?.monthCost ?? 0;
    const status = state.geminiUsage.apiKeyInfo.status || 'valid';
    return { label: 'API key spend', percent: null, text: `$${usd.toFixed(2)} est. (30d · ${status})` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local costs
// ---------------------------------------------------------------------------

// Tokens per minute across the current session. With `fallback`, a provider
// that reports no session clock averages over the last 5 hours instead.
function burnRate(localCosts, sessionWindow, { fallback = false } = {}) {
  if (!localCosts) return null;
  const su = localCosts.sessionUsage;
  const totalTokens = su.input + su.output + su.cacheRead + su.cacheWrite;
  const elapsedPct = windowElapsedPercent(sessionWindow, SESSION_MS);
  if (elapsedPct > 0.5) return totalTokens / ((elapsedPct / 100) * (SESSION_MS / 60000));
  return fallback ? totalTokens / (SESSION_MS / 60000) : null; // no clock, or just reset
}

function mergeMaps(a, b) {
  const out = {};
  for (const m of [a, b]) {
    if (m) for (const [k, v] of Object.entries(m)) out[k] = (out[k] || 0) + v;
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

  return {
    todayTokens: (c?.todayTokens || 0) + (g?.todayTokens || 0),
    todayCost:   (c?.todayCost || 0) + (g?.todayCost || 0),
    weekTokens:  (c?.weekTokens || 0) + (g?.weekTokens || 0),
    weekCost:    (c?.weekCost || 0) + (g?.weekCost || 0),
    monthTokens: (c?.monthTokens || 0) + (g?.monthTokens || 0),
    monthCost:   (c?.monthCost || 0) + (g?.monthCost || 0),
    modelBreakdown: mergeMaps(c?.modelBreakdown, g?.modelBreakdown),
    todayModelBreakdown: mergeMaps(c?.todayModelBreakdown, g?.todayModelBreakdown),
    weekModelBreakdown: mergeMaps(c?.weekModelBreakdown, g?.weekModelBreakdown),
    todayModelTokens: mergeMaps(c?.todayModelTokens, g?.todayModelTokens),
    weekModelTokens: mergeMaps(c?.weekModelTokens, g?.weekModelTokens),
    monthModelTokens: mergeMaps(c?.monthModelTokens, g?.monthModelTokens),
    daily,
  };
}

// ---------------------------------------------------------------------------
// Combined + snapshot
// ---------------------------------------------------------------------------

// Every limit from both providers, so the worst number on the tab badge always
// has a row to match it.
function combinedLimits(state) {
  const windows = { session: ['session', '5h'], weekly: ['weekly', '7d'] };
  const claudeRows = claudeLimits(state).map((r) => {
    const w = windows[r.key];
    return {
      ...r,
      key: `claude:${r.key}`,
      label: `Claude ${w ? w[0] : r.label}`,
      short: `Claude ${w ? w[1] : r.short}`,
    };
  });
  const geminiRows = geminiLimits(state).map((r) => {
    const w = windows[r.key];
    return {
      ...r,
      key: `gemini:${r.key}`,
      label: w ? `Gemini ${w[0]}` : r.label,
      short: w ? `Gemini ${w[1]}` : r.label === `Gemini ${r.short}` ? r.label : r.short,
    };
  });
  return [...claudeRows, ...geminiRows];
}

function combinedWorstPercent(state) {
  return Math.max(worstPercent(claudeLimits(state)), worstPercent(geminiLimits(state)));
}

function iso(d) {
  return d ? d.toISOString() : null;
}

function snapshotForRenderer(state) {
  const cLimits = claudeLimits(state);
  const gLimits = geminiLimits(state);
  const cBurn = burnRate(state.localCosts, state.usage?.five_hour);
  const gBurn = burnRate(state.geminiLocalCosts, state.geminiUsage?.five_hour, { fallback: true });
  const cPlan = planDisplayName(state);
  const gPlan = geminiPlanDisplayName(state);

  const planParts = [];
  if (state.usage || cPlan !== 'Unknown') planParts.push(`Claude ${cPlan}`);
  if (state.geminiUsage || gPlan !== 'Unknown') planParts.push(gPlan);

  // The combined view is only as fresh as its older provider.
  const fetchedAt = [state.usage && state.lastUpdated, state.geminiUsage && state.geminiLastUpdated].filter(Boolean);
  const oldest = fetchedAt.length ? new Date(Math.min(...fetchedAt.map((d) => d.getTime()))) : null;

  return {
    hasLoaded: Boolean(state.hasLoaded),
    isLoading: Boolean(state.isLoading),
    errorMessage: state.errorMessage,
    credentialError: state.credentialError || null,
    lastUpdated: iso(state.lastUpdated),
    limits: cLimits,
    worstPercent: cLimits.length ? worstPercent(cLimits) : null,
    extraUsage: claudeExtraUsage(state),
    planName: cPlan,
    burnRate: cBurn,
    localCosts: formatLocalCosts(state.localCosts),

    gemini: {
      hasLoaded: Boolean(state.geminiHasLoaded),
      errorMessage: state.geminiErrorMessage || null,
      credentialError: state.geminiCredentialError || null,
      lastUpdated: iso(state.geminiLastUpdated),
      limits: gLimits,
      worstPercent: gLimits.length ? worstPercent(gLimits) : null,
      extraUsage: geminiExtraUsage(state),
      planName: gPlan,
      burnRate: gBurn,
      localCosts: formatLocalCosts(state.geminiLocalCosts),
    },

    combined: {
      hasLoaded: Boolean(state.hasLoaded || state.geminiHasLoaded),
      lastUpdated: iso(oldest),
      limits: combinedLimits(state),
      worstPercent: cLimits.length || gLimits.length ? combinedWorstPercent(state) : null,
      burnRate: cBurn != null || gBurn != null ? (cBurn || 0) + (gBurn || 0) : null,
      planName: planParts.join(' · ') || 'Unknown',
      localCosts: combinedLocalCosts(state),
    },
  };
}

module.exports = {
  snapshotForRenderer,
  claudeLimits,
  geminiLimits,
  sessionPercent,
  geminiSessionPercent,
  combinedWorstPercent,
};
