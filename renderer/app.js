'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  // tabs
  tabClaude: $('tab-claude'),
  tabGemini: $('tab-gemini'),
  tabCombined: $('tab-combined'),
  tabBadgeClaude: $('tab-badge-claude'),
  tabBadgeGemini: $('tab-badge-gemini'),
  tabBadgeCombined: $('tab-badge-combined'),

  // states
  empty: $('empty-state'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  emptyRetry: $('empty-retry'),
  errorState: $('error-state'),
  errorText: $('error-text'),
  errorRetry: $('error-retry'),
  errorReread: $('error-reread'),
  loading: $('loading'),
  content: $('content'),
  stale: $('stale'),

  // headline
  headline: $('headline'),
  headlineLabel: $('headline-label'),
  headlineTag: $('headline-tag'),
  headlinePct: $('headline-pct'),
  headlineVerdict: $('headline-verdict'),
  headlineBarFill: $('headline-bar-fill'),
  headlineBarTick: $('headline-bar-tick'),
  headlineBarProjected: $('headline-bar-projected'),
  headlineElapsed: $('headline-elapsed'),
  headlineReset: $('headline-reset'),

  // rows
  rowSession: $('row-session'),
  rowWeekly: $('row-weekly'),
  rowFable: $('row-fable'),
  rowOpus: $('row-opus'),
  nameSession: $('name-session'),
  nameWeekly: $('name-weekly'),
  nameFable: $('name-fable'),
  nameOpus: $('name-opus'),
  barSession: $('bar-session'),
  barWeekly: $('bar-weekly'),
  barFable: $('bar-fable'),
  barOpus: $('bar-opus'),
  pctSession: $('pct-session'),
  pctWeekly: $('pct-weekly'),
  pctFable: $('pct-fable'),
  pctOpus: $('pct-opus'),

  // local
  localSection: $('local-section'),
  dayChip: $('day-chip'),
  localApprox: $('local-approx'),
  metricCost: $('metric-cost'),
  metricTokens: $('metric-tokens'),
  cellToday: $('cell-today'),
  cellWeek: $('cell-week'),
  cellMonth: $('cell-month'),
  tokToday: $('tok-today'),
  tokWeek: $('tok-week'),
  tokMonth: $('tok-month'),
  costToday: $('cost-today'),
  costWeek: $('cost-week'),
  costMonth: $('cost-month'),
  dailyCmp: $('daily-cmp'),
  dailyBars: $('daily-bars'),
  dailyMeta: $('daily-meta'),
  burnRow: $('burn-row'),
  burnVal: $('burn-val'),
  burnProjected: $('burn-projected'),
  modelBarWrap: $('model-bar-wrap'),
  modelBar: $('model-bar'),
  modelLegend: $('model-legend'),

  // extra
  extraSection: $('extra-section'),
  extraLabel: $('extra-label'),
  extraBar: $('extra-bar'),
  extraFill: $('extra-fill'),
  extraVal: $('extra-val'),

  // footer
  plan: $('plan'),
  updated: $('updated'),
  refresh: $('refresh'),
  quit: $('quit'),
};

let lastSnapshot = null;
let updatedTimer = null;
let activeProvider = (() => {
  try {
    const saved = localStorage.getItem('cub.provider');
    if (saved === 'claude' || saved === 'gemini' || saved === 'combined') return saved;
  } catch {}
  return 'claude';
})();
// Per-provider pinned headline row key (null = auto = worst)
const pinnedByProvider = { claude: null, gemini: null, combined: null };

let activityPeriod = (() => {
  try {
    const saved = localStorage.getItem('cub.activityPeriod');
    if (saved === 'today' || saved === 'week' || saved === 'month') return saved;
  } catch {}
  return 'month';
})();

let activityMetric = (() => {
  try {
    const saved = localStorage.getItem('cub.activityMetric');
    if (saved === 'cost' || saved === 'tokens') return saved;
  } catch {}
  return 'cost';
})();

let selectedDay = null; // 'YYYY-MM-DD' when a specific day bar is pinned
let hoveredDay = null;  // 'YYYY-MM-DD' while hovering a day bar

function setActivityPeriod(period) {
  if (period !== 'today' && period !== 'week' && period !== 'month') return;
  activityPeriod = period;
  selectedDay = null;
  try { localStorage.setItem('cub.activityPeriod', period); } catch {}
  if (lastSnapshot) render(lastSnapshot);
}

function setActivityMetric(metric) {
  if (metric !== 'cost' && metric !== 'tokens') return;
  activityMetric = metric;
  try { localStorage.setItem('cub.activityMetric', metric); } catch {}
  if (lastSnapshot) render(lastSnapshot);
}

function setActiveProvider(p, { focusTab = false } = {}) {
  if (p !== 'claude' && p !== 'gemini' && p !== 'combined') return;
  activeProvider = p;
  try { localStorage.setItem('cub.provider', p); } catch {}
  updateTabUI(focusTab);
  if (lastSnapshot) render(lastSnapshot);
}

function updateTabUI(focusTab = false) {
  const tabs = [
    { el: els.tabClaude, key: 'claude' },
    { el: els.tabGemini, key: 'gemini' },
    { el: els.tabCombined, key: 'combined' },
  ];
  for (const { el, key } of tabs) {
    if (!el) continue;
    const isSel = key === activeProvider;
    el.classList.toggle('active', isSel);
    el.setAttribute('aria-selected', isSel ? 'true' : 'false');
    el.setAttribute('tabindex', isSel ? '0' : '-1');
    if (focusTab && isSel) el.focus();
  }
}

function statusClass(percent) {
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'med';
  return 'low';
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '--';
  return Math.round(v) + '%';
}

function fmtTok(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

function fmtRate(tokPerMin) {
  if (tokPerMin == null) return '--';
  if (tokPerMin <= 0) return '0/min';
  if (tokPerMin >= 1000) return (tokPerMin / 1000).toFixed(1) + 'K/min';
  return Math.round(tokPerMin) + '/min';
}

function modelColor(model) {
  const m = String(model || '');
  if (m.startsWith('Fable') || m.startsWith('Mythos')) return '#ff9f0a';
  if (m.startsWith('Opus')) return '#bf5af2';
  if (m.startsWith('Sonnet')) return '#0a84ff';
  if (m.startsWith('Haiku')) return '#64d2ff';
  if (m.includes('Argon') || m.includes('Ultra')) return '#30d158';
  if (m.startsWith('Gemini') && m.includes('Pro')) return '#5e5ce6';
  if (m.startsWith('Gemini') && m.includes('Lite')) return '#ffd60a';
  if (m.startsWith('Gemini') && m.includes('Flash')) return '#32ade6';
  if (m.startsWith('Gemini')) return '#64d2ff';
  return '#98989f';
}

function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function verdictText(verdict, projectedPct, sessionPct, fiveHourResetIn) {
  switch (verdict) {
    case 'burning':
      if (projectedPct >= 100 && fiveHourResetIn) {
        return 'Burning fast - on track to hit limit';
      }
      return 'Burning fast';
    case 'fast':
      return 'Slightly ahead of pace';
    case 'pace':
      return 'On pace';
    case 'idle':
      return 'Plenty of headroom';
    case 'fresh':
      return 'Fresh window';
    default:
      return '';
  }
}

let hasAutoSelectedProvider = false;

function setBadge(badgeEl, hasLoaded, percent) {
  if (!badgeEl) return;
  badgeEl.classList.remove('high', 'med', 'low');
  if (!hasLoaded || percent == null || !Number.isFinite(percent)) {
    badgeEl.textContent = '--';
    return;
  }
  const cls = statusClass(percent);
  badgeEl.classList.add(cls);
  badgeEl.textContent = fmtPct(percent);
}

function updateTabBadges(snap) {
  const cPct = snap.worstWindowPercent ?? snap.sessionPercent ?? 0;
  const g = snap.gemini || {};
  const gPct = g.worstWindowPercent ?? g.sessionPercent ?? 0;
  const comb = snap.combined || {};
  const combPct = comb.worstPercent ?? Math.max(cPct, gPct);

  setBadge(els.tabBadgeClaude, snap.hasLoaded, cPct);
  setBadge(els.tabBadgeGemini, Boolean(g.hasLoaded), gPct);
  setBadge(els.tabBadgeCombined, Boolean(comb.hasLoaded || snap.hasLoaded || g.hasLoaded), combPct);

  if (!hasAutoSelectedProvider && (snap.hasLoaded || g.hasLoaded || snap.errorMessage || g.errorMessage)) {
    hasAutoSelectedProvider = true;
    let hasSaved = false;
    try { hasSaved = Boolean(localStorage.getItem('cub.provider')); } catch {}
    if (!hasSaved && !snap.hasLoaded && snap.credentialError && g.hasLoaded) {
      activeProvider = 'gemini';
      updateTabUI(false);
    }
  }
}

function buildViewContext(snap) {
  const g = snap.gemini || {};
  const c = snap.combined || {};

  if (activeProvider === 'gemini') {
    const fReset = g.fiveHourResetIn ? capitalize(g.fiveHourResetIn) : '';
    const wReset = g.sevenDayResetIn ? capitalize(g.sevenDayResetIn) : '';
    return {
      provider: 'gemini',
      hasLoaded: Boolean(g.hasLoaded),
      isLoading: Boolean(g.isLoading ?? snap.isLoading),
      errorMessage: g.errorMessage || null,
      credentialError: g.credentialError || null,
      emptyTitle: 'Sign in to Gemini / Antigravity',
      rows: {
        session: {
          key: 'session',
          label: 'Gemini 5h',
          rowLabel: 'Session 5h',
          tag: g.fiveHourResetIn || '',
          resetText: fReset,
          percent: g.sessionPercent ?? 0,
          isSessionWindow: true,
          elapsedPct: g.sessionElapsedPercent ?? 0,
          projectedPct: g.projectedSessionPercent,
          verdict: g.paceVerdict || 'pace',
          fiveHourResetIn: g.fiveHourResetIn,
        },
        weekly: {
          key: 'weekly',
          label: 'Gemini 7d',
          rowLabel: 'Weekly 7d',
          tag: g.sevenDayResetIn || '',
          resetText: wReset,
          percent: g.weeklyPercent ?? 0,
          isSessionWindow: false,
        },
        fable: {
          key: 'fable',
          label: 'Gemini Pro 5h',
          rowLabel: 'Pro 5h',
          tag: g.fiveHourResetIn || '',
          resetText: fReset,
          percent: g.proPercent ?? 0,
          isSessionWindow: false,
        },
        opus: {
          key: 'opus',
          label: 'Gemini Flash 5h',
          rowLabel: 'Flash 5h',
          tag: g.fiveHourResetIn || '',
          resetText: fReset,
          percent: g.flashPercent ?? 0,
          isSessionWindow: false,
        },
      },
      localCosts: g.localCosts || null,
      burnRate: g.burnRate ?? null,
      extraUsage: g.extraUsage || null,
      planName: g.planName || '--',
      lastUpdated: snap.lastUpdated,
    };
  }

  if (activeProvider === 'combined') {
    const cfReset = snap.fiveHourResetIn ? capitalize(snap.fiveHourResetIn) : '';
    const cwReset = snap.sevenDayResetIn ? capitalize(snap.sevenDayResetIn) : '';
    const gfReset = g.fiveHourResetIn ? capitalize(g.fiveHourResetIn) : '';
    const gwReset = g.sevenDayResetIn ? capitalize(g.sevenDayResetIn) : '';
    const anyLoaded = Boolean(c.hasLoaded || snap.hasLoaded || g.hasLoaded);
    const staleErr = (snap.errorMessage && g.errorMessage)
      ? `${snap.errorMessage} · ${g.errorMessage}`
      : (!anyLoaded ? (snap.errorMessage || g.errorMessage) : null);
    return {
      provider: 'combined',
      hasLoaded: anyLoaded,
      isLoading: Boolean(snap.isLoading),
      errorMessage: staleErr,
      credentialError: !anyLoaded ? (snap.credentialError || g.credentialError) : null,
      emptyTitle: 'Sign in to Claude or Gemini',
      rows: {
        session: {
          key: 'session',
          label: 'Claude Session',
          rowLabel: 'Claude 5h',
          tag: snap.fiveHourResetIn || '',
          resetText: cfReset,
          percent: snap.sessionPercent ?? 0,
          isSessionWindow: true,
          elapsedPct: snap.sessionElapsedPercent ?? 0,
          projectedPct: snap.projectedSessionPercent,
          verdict: snap.paceVerdict || 'pace',
          fiveHourResetIn: snap.fiveHourResetIn,
        },
        weekly: {
          key: 'weekly',
          label: 'Claude Weekly',
          rowLabel: 'Claude 7d',
          tag: snap.sevenDayResetIn || '',
          resetText: cwReset,
          percent: snap.weeklyPercent ?? 0,
          isSessionWindow: false,
        },
        fable: {
          key: 'fable',
          label: 'Gemini Session',
          rowLabel: 'Gemini 5h',
          tag: g.fiveHourResetIn || '',
          resetText: gfReset,
          percent: g.sessionPercent ?? 0,
          isSessionWindow: true,
          elapsedPct: g.sessionElapsedPercent ?? 0,
          projectedPct: g.projectedSessionPercent,
          verdict: g.paceVerdict || 'pace',
          fiveHourResetIn: g.fiveHourResetIn,
        },
        opus: {
          key: 'opus',
          label: 'Gemini Weekly',
          rowLabel: 'Gemini 7d',
          tag: g.sevenDayResetIn || '',
          resetText: gwReset,
          percent: g.weeklyPercent ?? 0,
          isSessionWindow: false,
        },
      },
      localCosts: c.localCosts || null,
      burnRate: c.burnRate ?? null,
      extraUsage: snap.extraUsage || g.extraUsage || null,
      planName: c.planName || '--',
      lastUpdated: snap.lastUpdated,
    };
  }

  // Default: Claude
  const fReset = snap.fiveHourResetIn ? capitalize(snap.fiveHourResetIn) : '';
  const wReset = snap.sevenDayResetIn ? capitalize(snap.sevenDayResetIn) : '';
  return {
    provider: 'claude',
    hasLoaded: Boolean(snap.hasLoaded),
    isLoading: Boolean(snap.isLoading),
    errorMessage: snap.errorMessage || null,
    credentialError: snap.credentialError || null,
    emptyTitle: 'Sign in to Claude Code',
    rows: {
      session: {
        key: 'session',
        label: 'Session',
        rowLabel: 'Session',
        tag: snap.fiveHourResetIn || '',
        resetText: fReset,
        percent: snap.sessionPercent ?? 0,
        isSessionWindow: true,
        elapsedPct: snap.sessionElapsedPercent ?? 0,
        projectedPct: snap.projectedSessionPercent,
        verdict: snap.paceVerdict || 'pace',
        fiveHourResetIn: snap.fiveHourResetIn,
      },
      weekly: {
        key: 'weekly',
        label: 'Weekly',
        rowLabel: 'Weekly',
        tag: snap.sevenDayResetIn || '',
        resetText: wReset,
        percent: snap.weeklyPercent ?? 0,
        isSessionWindow: false,
      },
      fable: {
        key: 'fable',
        label: 'Fable 7d',
        rowLabel: 'Fable',
        tag: snap.sevenDayResetIn || '',
        resetText: wReset,
        percent: snap.fablePercent ?? 0,
        isSessionWindow: false,
      },
      opus: {
        key: 'opus',
        label: 'Opus 7d',
        rowLabel: 'Opus',
        tag: snap.sevenDayResetIn || '',
        resetText: wReset,
        percent: snap.opusPercent ?? 0,
        isSessionWindow: false,
      },
    },
    localCosts: snap.localCosts || null,
    burnRate: snap.burnRate ?? null,
    extraUsage: snap.extraUsage || null,
    planName: snap.planName || '--',
    lastUpdated: snap.lastUpdated,
  };
}

function pickHeadline(ctx) {
  const candidates = ctx.rows;
  const pinned = pinnedByProvider[ctx.provider];
  if (pinned && candidates[pinned]) return candidates[pinned];
  const arr = Object.values(candidates);
  arr.sort((a, b) => b.percent - a.percent);
  return arr[0];
}

function render(snap) {
  lastSnapshot = snap;
  updateTabBadges(snap);
  updateTabUI(false);
  const ctx = buildViewContext(snap);
  if (!routeState(ctx)) return;
  renderStaleStrip(ctx);
  const head = pickHeadline(ctx);
  renderHeadline(ctx, head);
  renderRows(ctx, head.key);
  renderLocal(ctx, head);
  renderExtra(ctx);
  renderFooter(ctx);
  startUpdatedTicker();
}

function routeState(ctx) {
  if (!ctx.hasLoaded && !ctx.errorMessage && ctx.isLoading) {
    show('loading');
    return false;
  }
  const isCredError = !!ctx.credentialError;
  if (!ctx.hasLoaded && isCredError) {
    show('empty');
    if (els.emptyTitle) els.emptyTitle.textContent = ctx.emptyTitle;
    els.emptyText.textContent = ctx.errorMessage;
    return false;
  }
  if (!ctx.hasLoaded && ctx.errorMessage) {
    show('error');
    els.errorText.textContent = ctx.errorMessage;
    return false;
  }
  if (!ctx.hasLoaded) {
    show('loading');
    return false;
  }
  show('content');
  return true;
}

function renderStaleStrip(ctx) {
  if (ctx.errorMessage) {
    els.stale.textContent = ctx.errorMessage;
    els.stale.classList.remove('hidden');
  } else {
    els.stale.classList.add('hidden');
  }
}

function renderHeadline(ctx, head) {
  const cls = statusClass(head.percent);
  els.headline.classList.remove('status-low', 'status-med', 'status-high');
  els.headline.classList.add('status-' + cls);
  els.headlineLabel.textContent = head.label;
  els.headlineTag.textContent = head.tag || '';
  els.headlineTag.style.display = head.tag ? '' : 'none';
  els.headlinePct.textContent = Math.round(head.percent);
  els.headlineBarFill.style.width = Math.min(100, Math.max(0, head.percent)) + '%';

  if (head.isSessionWindow) {
    renderSessionTickAndProjection(head);
    els.headlineReset.textContent = head.resetText || '';
  } else {
    els.headlineBarTick.style.display = 'none';
    els.headlineBarProjected.classList.remove('active');
    els.headlineElapsed.textContent = '';
    els.headlineReset.textContent = head.resetText || '';
  }

  renderVerdict(head);
}

function renderSessionTickAndProjection(head) {
  const elapsed = Math.min(100, Math.max(0, head.elapsedPct || 0));
  els.headlineBarTick.style.left = elapsed + '%';
  els.headlineBarTick.style.display = '';
  els.headlineElapsed.textContent = 'Window ' + Math.round(elapsed) + '% elapsed';

  const proj = head.projectedPct;
  const sessionPct = head.percent;
  if (proj != null && proj > sessionPct + 1 && proj < 200 && elapsed > 5 && elapsed < 99) {
    els.headlineBarProjected.style.left = Math.min(100, proj) + '%';
    els.headlineBarProjected.classList.add('active');
  } else {
    els.headlineBarProjected.classList.remove('active');
  }
}

let lastVerdictSig = null;

function renderVerdict(head) {
  const verdict = head.isSessionWindow ? (head.verdict || 'pace') : 'pace';
  const text = head.isSessionWindow
    ? verdictText(verdict, head.projectedPct, head.percent, head.fiveHourResetIn)
    : 'Worst-pressure limit right now';
  const sig = verdict + '\u0000' + text;
  if (sig === lastVerdictSig) return;
  lastVerdictSig = sig;

  els.headlineVerdict.className = 'headline-verdict verdict-' + verdict;
  els.headlineVerdict.innerHTML = '<span class="verdict-dot"></span>' + escapeHtml(text);
}

function renderRows(ctx, headKey) {
  const r = ctx.rows;
  if (els.nameSession) els.nameSession.textContent = r.session.rowLabel;
  if (els.nameWeekly)  els.nameWeekly.textContent  = r.weekly.rowLabel;
  if (els.nameFable)   els.nameFable.textContent   = r.fable.rowLabel;
  if (els.nameOpus)    els.nameOpus.textContent    = r.opus.rowLabel;

  setRow(els.rowSession, els.barSession, els.pctSession, r.session.percent, headKey === 'session');
  setRow(els.rowWeekly,  els.barWeekly,  els.pctWeekly,  r.weekly.percent,  headKey === 'weekly');
  setRow(els.rowFable,   els.barFable,   els.pctFable,   r.fable.percent,   headKey === 'fable');
  setRow(els.rowOpus,    els.barOpus,    els.pctOpus,    r.opus.percent,    headKey === 'opus');
}

function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 10) return '$' + n.toFixed(2);
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(dayKeyStr) {
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderLocal(ctx, head) {
  const lc = ctx.localCosts;
  if (!lc) {
    els.localSection.classList.add('hidden');
    return;
  }
  els.localSection.classList.remove('hidden');

  // Metric toggle UI
  const isCost = activityMetric === 'cost';
  if (els.metricCost) {
    els.metricCost.classList.toggle('active', isCost);
    els.metricCost.setAttribute('aria-pressed', isCost ? 'true' : 'false');
  }
  if (els.metricTokens) {
    els.metricTokens.classList.toggle('active', !isCost);
    els.metricTokens.setAttribute('aria-pressed', !isCost ? 'true' : 'false');
  }

  // Period cards: show both tokens and dollar cost on every card, emphasizing active metric
  const periods = [
    { key: 'today', cell: els.cellToday, primaryEl: els.tokToday, subEl: els.costToday, tokens: lc.todayTokens || 0, cost: lc.todayCost || 0 },
    { key: 'week',  cell: els.cellWeek,  primaryEl: els.tokWeek,  subEl: els.costWeek,  tokens: lc.weekTokens || 0,  cost: lc.weekCost || 0 },
    { key: 'month', cell: els.cellMonth, primaryEl: els.tokMonth, subEl: els.costMonth, tokens: lc.monthTokens || 0, cost: lc.monthCost || 0 },
  ];
  for (const p of periods) {
    const tokStr = '~' + fmtTok(p.tokens);
    const costStr = '$' + p.cost.toFixed(2);
    if (p.primaryEl) p.primaryEl.textContent = isCost ? costStr : tokStr;
    if (p.subEl) p.subEl.textContent = isCost ? tokStr : costStr;
    if (p.cell) {
      const isAct = !selectedDay && activityPeriod === p.key;
      p.cell.classList.toggle('active', isAct);
      p.cell.setAttribute('aria-pressed', isAct ? 'true' : 'false');
    }
  }

  // Validate selectedDay still exists in current window
  const daily = lc.daily || {};
  if (selectedDay && !daily[selectedDay]) {
    selectedDay = null;
  }

  // Day chip badge when a single day is pinned
  if (els.dayChip) {
    if (selectedDay) {
      els.dayChip.textContent = formatShortDate(selectedDay) + ' \u00d7';
      els.dayChip.classList.remove('hidden');
    } else {
      els.dayChip.classList.add('hidden');
    }
  }

  // Determine filtered cost, tokens, and model breakdowns for active selection
  let activeCost = lc.monthCost || 0;
  let activeTokens = lc.monthTokens || 0;
  let activeScopeLabel = '30d';
  let activeCostModels = lc.modelBreakdown || {};
  let activeTokenModels = lc.monthModelTokens || {};

  if (selectedDay && daily[selectedDay]) {
    const dBucket = daily[selectedDay];
    activeCost = dBucket.cost || 0;
    activeTokens = dBucket.tokens || 0;
    activeScopeLabel = formatShortDate(selectedDay);
    activeCostModels = dBucket.models || {};
    activeTokenModels = dBucket.modelTokens || {};
  } else if (activityPeriod === 'today') {
    activeCost = lc.todayCost || 0;
    activeTokens = lc.todayTokens || 0;
    activeScopeLabel = 'today';
    activeCostModels = lc.todayModelBreakdown || {};
    activeTokenModels = lc.todayModelTokens || {};
  } else if (activityPeriod === 'week') {
    activeCost = lc.weekCost || 0;
    activeTokens = lc.weekTokens || 0;
    activeScopeLabel = '7d';
    activeCostModels = lc.weekModelBreakdown || {};
    activeTokenModels = lc.weekModelTokens || {};
  }

  if (els.localApprox) {
    els.localApprox.textContent = `~$${activeCost.toFixed(2)} \u00b7 ~${fmtTok(activeTokens)} (${activeScopeLabel})`;
  }

  renderDailyComparison(ctx, lc);
  renderBurnRow(ctx, head);
  renderModelBar(activeCostModels, activeTokenModels);
}

let lastDailyBarsSig = null;

function renderDailyComparison(ctx, lc) {
  if (!els.dailyCmp || !els.dailyBars || !els.dailyMeta) return;
  const daily = lc.daily || {};
  const numDays = activityPeriod === 'month' ? 14 : 7;
  const now = new Date();
  const todayKey = localDayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterdayKey = localDayKey(yesterdayDate);

  const days = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = localDayKey(d);
    const bucket = daily[key] || { tokens: 0, cost: 0, models: {}, modelTokens: {} };
    days.push({
      key,
      shortLabel: i === 0 ? 'Today' : String(d.getDate()),
      fullLabel: i === 0 ? `Today (${formatShortDate(key)})` : (i === 1 ? `Yest (${formatShortDate(key)})` : formatShortDate(key)),
      cost: bucket.cost || 0,
      tokens: bucket.tokens || 0,
      claudeCost: bucket.claudeCost,
      geminiCost: bucket.geminiCost,
      claudeTokens: bucket.claudeTokens,
      geminiTokens: bucket.geminiTokens,
      models: bucket.models || {},
      modelTokens: bucket.modelTokens || {},
    });
  }

  const isCost = activityMetric === 'cost';
  const maxVal = Math.max(
    1e-9,
    ...days.map((d) => (isCost ? d.cost : d.tokens))
  );

  const sig = [
    ctx.provider,
    activityPeriod,
    activityMetric,
    selectedDay || '',
    days.map((d) => `${d.key}:${d.cost.toFixed(3)}:${d.tokens}`).join(','),
  ].join('|');

  if (sig !== lastDailyBarsSig) {
    lastDailyBarsSig = sig;
    els.dailyBars.innerHTML = days.map((d) => {
      const val = isCost ? d.cost : d.tokens;
      const totalPct = val > 0 ? Math.max(8, Math.min(100, (val / maxVal) * 100)) : 0;
      const modelMap = isCost ? d.models : d.modelTokens;
      const modelEntries = Object.entries(modelMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const modelSum = modelEntries.reduce((s, [, v]) => s + v, 0);

      let segHtml = '';
      if (totalPct > 0 && modelSum > 0) {
        segHtml = modelEntries.map(([m, mv]) => {
          const h = (mv / modelSum) * totalPct;
          return `<div class="day-seg" style="height:${h.toFixed(1)}%;background:${modelColor(m)}"></div>`;
        }).join('');
      } else if (totalPct > 0) {
        segHtml = `<div class="day-seg" style="height:${totalPct.toFixed(1)}%;background:var(--blue)"></div>`;
      }

      const isAct = selectedDay === d.key;
      const titleText = `${d.fullLabel}: $${d.cost.toFixed(2)} \u00b7 ~${fmtTok(d.tokens)}`;
      return `<button type="button" class="day-col${isAct ? ' active' : ''}" data-day="${d.key}" aria-pressed="${isAct ? 'true' : 'false'}" title="${escapeHtml(titleText)}">` +
        `<div class="day-bar-track">${segHtml}</div>` +
        `<span class="day-lbl">${escapeHtml(d.shortLabel)}</span>` +
        `</button>`;
    }).join('');
  } else {
    // Keep active state synced even when bar heights haven't changed
    const btns = els.dailyBars.querySelectorAll('.day-col');
    for (const btn of btns) {
      const isAct = btn.getAttribute('data-day') === selectedDay;
      btn.classList.toggle('active', isAct);
      btn.setAttribute('aria-pressed', isAct ? 'true' : 'false');
    }
  }

  // Daily comparison metadata row for hovered / selected / today
  const focusKey = hoveredDay || selectedDay || todayKey;
  const focusObj = days.find((d) => d.key === focusKey) || days[days.length - 1];
  const leftText = `${focusObj.fullLabel}: $${focusObj.cost.toFixed(2)} \u00b7 ~${fmtTok(focusObj.tokens)}`;

  // Compute comparison right-hand text:
  // In Combined tab, show Claude vs Gemini split on that day; otherwise compare vs 7d daily avg / yesterday
  let rightHtml = '';
  if (ctx.provider === 'combined' && (focusObj.claudeCost != null || focusObj.geminiCost != null)) {
    if (isCost) {
      rightHtml = `C ${fmtUsd(focusObj.claudeCost || 0)} \u00b7 G ${fmtUsd(focusObj.geminiCost || 0)}`;
    } else {
      rightHtml = `C ~${fmtTok(focusObj.claudeTokens || 0)} \u00b7 G ~${fmtTok(focusObj.geminiTokens || 0)}`;
    }
  } else {
    const last7 = days.slice(-7);
    const avg7Cost = last7.reduce((s, d) => s + d.cost, 0) / Math.max(1, last7.length);
    const avg7Tok = last7.reduce((s, d) => s + d.tokens, 0) / Math.max(1, last7.length);
    const focusVal = isCost ? focusObj.cost : focusObj.tokens;
    const avgVal = isCost ? avg7Cost : avg7Tok;
    if (avgVal > 0 && focusVal > 0) {
      const diffPct = Math.round(((focusVal - avgVal) / avgVal) * 100);
      const sign = diffPct > 0 ? '+' : '';
      const cls = diffPct > 15 ? 'up' : (diffPct < -15 ? 'down' : '');
      const avgLabel = isCost ? fmtUsd(avg7Cost) : ('~' + fmtTok(avg7Tok));
      rightHtml = `<span class="daily-delta ${cls}">${sign}${diffPct}%</span> vs 7d avg (${avgLabel}/d)`;
    } else {
      const yest = daily[yesterdayKey];
      const yestLabel = isCost ? fmtUsd(yest?.cost || 0) : ('~' + fmtTok(yest?.tokens || 0));
      rightHtml = `Yest: ${yestLabel}`;
    }
  }

  els.dailyMeta.innerHTML =
    `<span class="daily-meta-left">${escapeHtml(leftText)}</span>` +
    `<span class="daily-meta-right">${rightHtml}</span>`;
}

function renderBurnRow(ctx, head) {
  if (ctx.burnRate == null) {
    els.burnRow.classList.add('hidden');
    return;
  }
  els.burnRow.classList.remove('hidden');
  els.burnVal.textContent = fmtRate(ctx.burnRate);
  const proj = head.projectedPct;
  if (proj != null && proj > 1 && head.isSessionWindow && (head.elapsedPct || 0) > 5) {
    els.burnProjected.textContent = '-> ' + Math.round(Math.min(999, proj)) + '% by reset';
    els.burnProjected.classList.remove('high', 'med');
    if (proj >= 100) els.burnProjected.classList.add('high');
    else if (proj >= 80) els.burnProjected.classList.add('med');
  } else {
    els.burnProjected.textContent = '';
  }
}

function renderExtra(ctx) {
  const ex = ctx.extraUsage;
  if (!ex || !ex.is_enabled) {
    els.extraSection.classList.add('hidden');
    return;
  }
  if (els.extraLabel) els.extraLabel.textContent = ex.label || 'Extra usage';
  if (ex.used_credits != null && ex.monthly_limit != null && ex.monthly_limit > 0) {
    els.extraSection.classList.remove('hidden');
    if (els.extraBar) els.extraBar.classList.remove('hidden');
    const pct = Math.min(100, (ex.used_credits / ex.monthly_limit) * 100);
    els.extraFill.style.width = pct + '%';
    els.extraVal.textContent = '$' + ex.used_credits.toFixed(2) + ' / $' + ex.monthly_limit.toFixed(2);
  } else if (ex.display_text) {
    els.extraSection.classList.remove('hidden');
    if (els.extraBar) els.extraBar.classList.add('hidden');
    els.extraVal.textContent = ex.display_text;
  } else {
    els.extraSection.classList.add('hidden');
  }
}

function renderFooter(ctx) {
  els.plan.textContent = ctx.planName || '--';
  els.updated.textContent = relativeTime(ctx.lastUpdated);
  els.refresh.classList.toggle('spinning', !!ctx.isLoading);
}

// Tick the "Ns ago" footer once a second while visible. The renderer process
// keeps running when the window is hidden, so we gate on visibilityState to
// avoid a no-op DOM write every second forever.
function startUpdatedTicker() {
  if (updatedTimer) clearInterval(updatedTimer);
  if (document.visibilityState !== 'visible') return;
  updatedTimer = setInterval(() => {
    if (lastSnapshot) els.updated.textContent = relativeTime(lastSnapshot.lastUpdated);
  }, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (updatedTimer) { clearInterval(updatedTimer); updatedTimer = null; }
  } else if (lastSnapshot) {
    render(lastSnapshot);
  }
});

function setRow(rowEl, barEl, pctEl, percent, isActive) {
  const cls = statusClass(percent);
  barEl.style.width = Math.min(100, Math.max(0, percent)) + '%';
  barEl.classList.remove('fill-low', 'fill-med', 'fill-high');
  barEl.classList.add('fill-' + cls);
  pctEl.classList.remove('pct-low', 'pct-med', 'pct-high');
  pctEl.classList.add('pct-' + cls);
  pctEl.textContent = fmtPct(percent);
  rowEl.classList.toggle('zero', percent <= 0);
  rowEl.classList.toggle('active', !!isActive);
}

let lastModelSig = null;

function renderModelBar(costBreakdown = {}, tokenBreakdown = {}) {
  const isCost = activityMetric === 'cost';
  const primaryMap = isCost ? costBreakdown : tokenBreakdown;
  const allModels = new Set([
    ...Object.keys(costBreakdown || {}),
    ...Object.keys(tokenBreakdown || {}),
  ]);
  const entries = [];
  for (const m of allModels) {
    const cVal = Number(costBreakdown?.[m]) || 0;
    const tVal = Number(tokenBreakdown?.[m]) || 0;
    const pVal = isCost ? cVal : tVal;
    if (pVal > 0 || cVal > 0 || tVal > 0) {
      entries.push({ model: m, primary: pVal > 0 ? pVal : cVal, cost: cVal, tokens: tVal });
    }
  }

  const sig = activityMetric + '|' + entries.map((e) => `${e.model}:${e.cost.toFixed(4)}:${e.tokens}`).sort().join('|');
  if (sig === lastModelSig) return;
  lastModelSig = sig;

  if (!entries.length) {
    els.modelBarWrap.classList.add('empty');
    els.modelBar.innerHTML = '';
    els.modelLegend.innerHTML = '';
    return;
  }
  els.modelBarWrap.classList.remove('empty');
  entries.sort((a, b) => b.primary - a.primary);
  const total = entries.reduce((s, e) => s + e.primary, 0) || 1;
  els.modelBar.innerHTML = buildModelSegments(entries, total);
  els.modelLegend.innerHTML = buildModelLegend(entries, isCost);
}

function buildModelSegments(entries, total) {
  return entries.map((e) => {
    const w = (e.primary / total) * 100;
    const c = modelColor(e.model);
    return '<div class="seg" style="width:' + w.toFixed(2) + '%;background:' + c + '"></div>';
  }).join('');
}

function buildModelLegend(entries, isCost) {
  return entries.map((e) => {
    const c = modelColor(e.model);
    const valText = isCost
      ? ('$' + e.cost.toFixed(2))
      : ('~' + fmtTok(e.tokens) + ' ($' + e.cost.toFixed(2) + ')');
    const titleText = `${e.model}: $${e.cost.toFixed(2)} \u00b7 ~${fmtTok(e.tokens)} tokens`;
    return '<span class="leg" title="' + escapeHtml(titleText) + '">' +
      '<span class="swatch" style="background:' + c + '"></span>' +
      '<span class="leg-name">' + escapeHtml(e.model) + '</span>' +
      '<span>' + escapeHtml(valText) + '</span>' +
      '</span>';
  }).join('');
}

function show(state) {
  els.loading.classList.toggle('hidden', state !== 'loading');
  els.empty.classList.toggle('hidden', state !== 'empty');
  els.errorState.classList.toggle('hidden', state !== 'error');
  els.content.classList.toggle('hidden', state !== 'content');
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============ WIRING ============

// Provider switcher tabs (click + ARIA tablist keyboard interactions).
const TAB_ORDER = ['claude', 'gemini', 'combined'];
function wireTabs() {
  const map = {
    claude: els.tabClaude,
    gemini: els.tabGemini,
    combined: els.tabCombined,
  };
  for (const key of TAB_ORDER) {
    const el = map[key];
    if (!el) continue;
    el.addEventListener('click', () => setActiveProvider(key));
    el.addEventListener('keydown', (e) => {
      const idx = TAB_ORDER.indexOf(activeProvider);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setActiveProvider(TAB_ORDER[(idx + 1) % TAB_ORDER.length], { focusTab: true });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setActiveProvider(TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length], { focusTab: true });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveProvider(TAB_ORDER[0], { focusTab: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveProvider(TAB_ORDER[TAB_ORDER.length - 1], { focusTab: true });
      }
    });
  }
  updateTabUI(false);
}
wireTabs();

// Click (or Enter on keydown / Space on keyup) a limit row to pin it as the
// headline; again to unpin.
function wireRow(rowEl, key) {
  const toggle = () => {
    const cur = pinnedByProvider[activeProvider];
    pinnedByProvider[activeProvider] = (cur === key) ? null : key;
    if (lastSnapshot) render(lastSnapshot);
  };
  rowEl.addEventListener('click', toggle);
  rowEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      toggle();
    } else if (e.key === ' ') {
      e.preventDefault();
    }
  });
  rowEl.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}
wireRow(els.rowSession, 'session');
wireRow(els.rowWeekly,  'weekly');
wireRow(els.rowFable,   'fable');
wireRow(els.rowOpus,    'opus');

// Activity period filter cards (Today / 7D / 30D), metric toggle ($ / Tok), and daily comparison bars
if (els.cellToday) els.cellToday.addEventListener('click', () => setActivityPeriod('today'));
if (els.cellWeek)  els.cellWeek.addEventListener('click',  () => setActivityPeriod('week'));
if (els.cellMonth) els.cellMonth.addEventListener('click', () => setActivityPeriod('month'));

if (els.metricCost)   els.metricCost.addEventListener('click',   () => setActivityMetric('cost'));
if (els.metricTokens) els.metricTokens.addEventListener('click', () => setActivityMetric('tokens'));

if (els.dayChip) {
  els.dayChip.addEventListener('click', () => {
    selectedDay = null;
    if (lastSnapshot) render(lastSnapshot);
  });
}

if (els.dailyBars) {
  els.dailyBars.addEventListener('click', (e) => {
    const btn = e.target.closest('.day-col');
    if (!btn) return;
    const day = btn.getAttribute('data-day');
    if (!day) return;
    selectedDay = (selectedDay === day) ? null : day;
    if (lastSnapshot) render(lastSnapshot);
  });
  els.dailyBars.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.day-col');
    const day = btn ? btn.getAttribute('data-day') : null;
    if (day && day !== hoveredDay) {
      hoveredDay = day;
      if (lastSnapshot) render(lastSnapshot);
    }
  });
  els.dailyBars.addEventListener('mouseleave', () => {
    if (hoveredDay !== null) {
      hoveredDay = null;
      if (lastSnapshot) render(lastSnapshot);
    }
  });
  els.dailyBars.addEventListener('focusin', (e) => {
    const btn = e.target.closest('.day-col');
    const day = btn ? btn.getAttribute('data-day') : null;
    if (day && day !== hoveredDay) {
      hoveredDay = day;
      if (lastSnapshot) render(lastSnapshot);
    }
  });
  els.dailyBars.addEventListener('focusout', () => {
    if (hoveredDay !== null) {
      hoveredDay = null;
      if (lastSnapshot) render(lastSnapshot);
    }
  });
}

els.refresh.addEventListener('click', () => window.claudeBar.refresh());
els.quit.addEventListener('click', () => window.claudeBar.quit());
els.errorRetry.addEventListener('click', () => window.claudeBar.refresh());
els.errorReread.addEventListener('click', () => window.claudeBar.refreshForce());
els.emptyRetry.addEventListener('click', () => window.claudeBar.refreshForce());

window.claudeBar.onState(render);
window.claudeBar.getState().then(render);

// Report content height to main so the popup grows/shrinks with the layout
// instead of clipping. Throttled with rAF + a small minimum-change guard.
(function wireAutoSize() {
  const root = document.getElementById('app') || document.body;
  let lastH = 0;
  let pending = false;
  const send = () => {
    pending = false;
    const h = Math.ceil(root.getBoundingClientRect().height);
    if (h <= 0 || Math.abs(h - lastH) < 2) return;
    lastH = h;
    if (window.claudeBar && window.claudeBar.setHeight) {
      window.claudeBar.setHeight(h);
    }
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(send);
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(root);
  }
  window.addEventListener('load', schedule);
  schedule();
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.claudeBar.hide();
    return;
  }
  // Avoid hijacking when modifier keys are involved.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '1') {
    setActiveProvider('claude');
  } else if (e.key === '2') {
    setActiveProvider('gemini');
  } else if (e.key === '3') {
    setActiveProvider('combined');
  } else if (e.key === 'r' || e.key === 'R') {
    window.claudeBar.refresh();
  } else if (e.key === 'q' || e.key === 'Q') {
    window.claudeBar.quit();
  }
});
