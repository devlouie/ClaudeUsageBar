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
  headlinePct: $('headline-pct'),
  headlineVerdict: $('headline-verdict'),
  headlineBarFill: $('headline-bar-fill'),
  headlineBarTick: $('headline-bar-tick'),
  headlineBarProjected: $('headline-bar-projected'),
  headlineElapsed: $('headline-elapsed'),
  headlineReset: $('headline-reset'),

  // limit rows
  limits: $('limits'),

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

function loadPref(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) return saved;
  } catch {}
  return fallback;
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const PROVIDERS = ['claude', 'gemini', 'combined'];
const PERIODS = ['today', 'week', 'month'];
const METRICS = ['cost', 'tokens'];

let lastSnapshot = null;
let lastUpdatedIso = null;
let updatedTimer = null;
let hasChosenProvider = false;
let activeProvider = loadPref('cub.provider', PROVIDERS, 'claude');
let activityPeriod = loadPref('cub.activityPeriod', PERIODS, 'month');
let activityMetric = loadPref('cub.activityMetric', METRICS, 'cost');
let selectedDay = null; // 'YYYY-MM-DD' when a specific day bar is pinned
let hoveredDay = null;  // 'YYYY-MM-DD' while hovering a day bar

// Per-provider pinned headline row key (null = auto = highest)
const pinnedByProvider = { claude: null, gemini: null, combined: null };

function rerender() {
  if (lastSnapshot) render(lastSnapshot);
}

function setActivityPeriod(period) {
  activityPeriod = period;
  selectedDay = null;
  savePref('cub.activityPeriod', period);
  rerender();
}

function setActivityMetric(metric) {
  activityMetric = metric;
  savePref('cub.activityMetric', metric);
  rerender();
}

function setActiveProvider(p, { focusTab = false } = {}) {
  activeProvider = p;
  savePref('cub.provider', p);
  updateTabUI(focusTab);
  rerender();
}

function updateTabUI(focusTab = false) {
  const tabs = { claude: els.tabClaude, gemini: els.tabGemini, combined: els.tabCombined };
  for (const key of PROVIDERS) {
    const el = tabs[key];
    const isSel = key === activeProvider;
    el.classList.toggle('active', isSel);
    el.setAttribute('aria-selected', isSel ? 'true' : 'false');
    el.setAttribute('tabindex', isSel ? '0' : '-1');
    if (focusTab && isSel) el.focus();
  }
}

// ============ FORMATTERS ============

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
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function fmtRate(tokPerMin) {
  if (tokPerMin == null) return '--';
  return fmtTok(Math.max(0, tokPerMin)) + '/min';
}

function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
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
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const s = Math.floor(Math.max(0, Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function verdictText(pace) {
  switch (pace.verdict) {
    case 'burning':
      return pace.projectedPct >= 100 ? 'Burning fast. On track to hit the limit.' : 'Burning fast';
    case 'fast':
      return pace.projectedPct >= 100 ? 'Ahead of pace. On track to hit the limit.' : 'Ahead of pace';
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

function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(dayKeyStr) {
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============ VIEW CONTEXT ============

function setBadge(el, percent) {
  el.classList.remove('badge-med', 'badge-high');
  if (percent == null || !Number.isFinite(percent)) {
    el.textContent = '--';
    return;
  }
  const cls = statusClass(percent);
  if (cls !== 'low') el.classList.add('badge-' + cls);
  el.textContent = fmtPct(percent);
}

function updateTabBadges(snap) {
  setBadge(els.tabBadgeClaude, snap.worstPercent);
  setBadge(els.tabBadgeGemini, snap.gemini.worstPercent);
  setBadge(els.tabBadgeCombined, snap.combined.worstPercent);

  // First run with no saved tab: land on the provider that actually has data.
  if (!hasChosenProvider && (snap.hasLoaded || snap.gemini.hasLoaded)) {
    hasChosenProvider = true;
    let hasSaved = false;
    try { hasSaved = Boolean(localStorage.getItem('cub.provider')); } catch {}
    if (!hasSaved && !snap.hasLoaded && snap.gemini.hasLoaded) {
      activeProvider = 'gemini';
      updateTabUI(false);
    }
  }
}

function buildViewContext(snap) {
  const g = snap.gemini;
  const c = snap.combined;

  if (activeProvider === 'gemini') {
    return {
      provider: 'gemini',
      hasLoaded: g.hasLoaded,
      isLoading: snap.isLoading,
      errorMessage: g.errorMessage,
      credentialError: g.credentialError,
      emptyTitle: 'Sign in to Gemini or Antigravity',
      rows: g.limits,
      localCosts: g.localCosts,
      burnRate: g.burnRate,
      extraUsage: g.extraUsage,
      planName: g.planName,
      lastUpdated: g.lastUpdated,
    };
  }

  if (activeProvider === 'combined') {
    // A provider that never loaded is noise here once the other one has data.
    const errors = [];
    if (snap.errorMessage && (snap.hasLoaded || !g.hasLoaded)) errors.push(snap.errorMessage);
    if (g.errorMessage && (g.hasLoaded || !snap.hasLoaded)) errors.push(g.errorMessage);
    return {
      provider: 'combined',
      hasLoaded: c.hasLoaded,
      isLoading: snap.isLoading,
      errorMessage: errors.join(' · ') || null,
      credentialError: c.hasLoaded ? null : (snap.credentialError || g.credentialError),
      emptyTitle: 'Sign in to Claude or Gemini',
      rows: c.limits,
      localCosts: c.localCosts,
      burnRate: c.burnRate,
      extraUsage: snap.extraUsage || g.extraUsage,
      planName: c.planName,
      lastUpdated: c.lastUpdated,
    };
  }

  return {
    provider: 'claude',
    hasLoaded: snap.hasLoaded,
    isLoading: snap.isLoading,
    errorMessage: snap.errorMessage,
    credentialError: snap.credentialError,
    emptyTitle: 'Sign in to Claude Code',
    rows: snap.limits,
    localCosts: snap.localCosts,
    burnRate: snap.burnRate,
    extraUsage: snap.extraUsage,
    planName: snap.planName,
    lastUpdated: snap.lastUpdated,
  };
}

function pickHeadline(ctx) {
  const pinned = pinnedByProvider[ctx.provider];
  const pinnedRow = ctx.rows.find((r) => r.key === pinned);
  if (pinnedRow) return pinnedRow;
  return ctx.rows.reduce((best, r) => (!best || r.percent > best.percent ? r : best), null);
}

// ============ RENDER ============

function render(snap) {
  lastSnapshot = snap;
  updateTabBadges(snap);
  updateTabUI(false);
  const ctx = buildViewContext(snap);
  lastUpdatedIso = ctx.lastUpdated;
  if (!routeState(ctx)) return;
  renderStaleStrip(ctx);
  const head = pickHeadline(ctx);
  renderHeadline(ctx, head);
  renderRows(ctx, head);
  renderLocal(ctx, head);
  renderExtra(ctx);
  renderFooter(ctx);
  startUpdatedTicker();
}

function routeState(ctx) {
  const waiting = ctx.isLoading && !ctx.errorMessage;
  if (waiting && !ctx.rows.length) {
    show('loading');
    return false;
  }
  if (!ctx.hasLoaded && ctx.credentialError) {
    show('empty');
    els.emptyTitle.textContent = ctx.emptyTitle;
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

function show(state) {
  els.loading.classList.toggle('hidden', state !== 'loading');
  els.empty.classList.toggle('hidden', state !== 'empty');
  els.errorState.classList.toggle('hidden', state !== 'error');
  els.content.classList.toggle('hidden', state !== 'content');
}

function renderStaleStrip(ctx) {
  els.stale.textContent = ctx.errorMessage || '';
  els.stale.classList.toggle('hidden', !ctx.errorMessage);
}

function renderHeadline(ctx, head) {
  els.headline.classList.toggle('hidden', !head);
  if (!head) return;

  els.headline.classList.remove('status-low', 'status-med', 'status-high');
  els.headline.classList.add('status-' + statusClass(head.percent));
  els.headlineLabel.textContent = head.label;
  els.headlinePct.textContent = Math.round(head.percent);
  els.headlineBarFill.style.width = Math.min(100, Math.max(0, head.percent)) + '%';
  els.headlineReset.textContent = capitalize(head.resetIn || '');

  renderPaceMarkers(head);
  renderVerdict(ctx, head);
}

function renderPaceMarkers(head) {
  const elapsed = head.pace ? head.pace.elapsedPct : 0;
  els.headlineBarTick.style.display = elapsed > 0 ? '' : 'none';
  els.headlineElapsed.textContent = elapsed > 0 ? 'Window ' + Math.round(elapsed) + '% elapsed' : '';
  if (elapsed > 0) els.headlineBarTick.style.left = elapsed + '%';

  const proj = head.pace ? head.pace.projectedPct : null;
  const showProj = proj != null && proj > head.percent + 1 && proj < 200 && elapsed > 5 && elapsed < 99;
  if (showProj) els.headlineBarProjected.style.left = Math.min(100, proj) + '%';
  els.headlineBarProjected.classList.toggle('active', Boolean(showProj));
}

function renderVerdict(ctx, head) {
  const pinned = pinnedByProvider[ctx.provider] === head.key;
  const verdict = head.pace ? head.pace.verdict : 'pace';
  let text = head.pace ? verdictText(head.pace) : 'Highest limit right now';
  if (!head.pace && pinned) text = 'Pinned';

  const el = els.headlineVerdict;
  el.className = 'headline-verdict verdict-' + verdict;
  el.innerHTML = '<span class="verdict-dot"></span>' + escapeHtml(text);
}

function createRowEl(key) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'limit-row';
  row.dataset.key = key;
  row.innerHTML = '<span class="lr-name"></span>'
    + '<span class="lr-bar"><span class="lr-fill"></span></span>'
    + '<span class="lr-pct"></span>';
  return row;
}

// Keyed so a bar keeps its element between renders and its width animates.
function renderRows(ctx, head) {
  const section = els.limits;
  section.classList.toggle('hidden', ctx.rows.length === 0);
  const existing = new Map([...section.children].map((el) => [el.dataset.key, el]));

  ctx.rows.forEach((row, i) => {
    const el = existing.get(row.key) || createRowEl(row.key);
    existing.delete(row.key);
    if (section.children[i] !== el) section.insertBefore(el, section.children[i] || null);
    setRow(el, row, ctx, head && row.key === head.key);
  });
  for (const el of existing.values()) el.remove();
}

function setRow(el, row, ctx, isHead) {
  const cls = statusClass(row.percent);
  const name = el.children[0];
  const fill = el.children[1].firstChild;
  const pct = el.children[2];
  const pinned = pinnedByProvider[ctx.provider] === row.key;

  name.textContent = row.short;
  el.title = row.resetIn ? `${row.label}: ${row.resetIn}` : row.label;
  fill.style.width = Math.min(100, Math.max(0, row.percent)) + '%';
  fill.className = 'lr-fill fill-' + cls;
  pct.className = 'lr-pct pct-' + cls;
  pct.textContent = fmtPct(row.percent);
  el.classList.toggle('zero', row.percent <= 0);
  el.classList.toggle('active', Boolean(isHead));
  el.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  el.setAttribute('aria-label', `${row.label} ${fmtPct(row.percent)}. ${pinned ? 'Unpin from' : 'Pin as'} headline.`);
}

function activitySelection(lc, daily) {
  if (selectedDay && daily[selectedDay]) {
    const d = daily[selectedDay];
    return { cost: d.cost || 0, tokens: d.tokens || 0, costModels: d.models || {}, tokenModels: d.modelTokens || {}, label: null };
  }
  if (activityPeriod === 'today') {
    return { cost: lc.todayCost || 0, tokens: lc.todayTokens || 0, costModels: lc.todayModelBreakdown || {}, tokenModels: lc.todayModelTokens || {}, label: 'today' };
  }
  if (activityPeriod === 'week') {
    return { cost: lc.weekCost || 0, tokens: lc.weekTokens || 0, costModels: lc.weekModelBreakdown || {}, tokenModels: lc.weekModelTokens || {}, label: '7d' };
  }
  return { cost: lc.monthCost || 0, tokens: lc.monthTokens || 0, costModels: lc.modelBreakdown || {}, tokenModels: lc.monthModelTokens || {}, label: '30d' };
}

function renderLocal(ctx, head) {
  const lc = ctx.localCosts;
  els.localSection.classList.toggle('hidden', !lc);
  if (!lc) return;

  const isCost = activityMetric === 'cost';
  els.metricCost.classList.toggle('active', isCost);
  els.metricCost.setAttribute('aria-pressed', isCost ? 'true' : 'false');
  els.metricTokens.classList.toggle('active', !isCost);
  els.metricTokens.setAttribute('aria-pressed', !isCost ? 'true' : 'false');

  // Validate selectedDay still exists in the current data.
  const daily = lc.daily || {};
  if (selectedDay && !daily[selectedDay]) selectedDay = null;

  // Period cards show both tokens and dollars, with the active metric on top.
  const cards = [
    { key: 'today', cell: els.cellToday, primaryEl: els.tokToday, subEl: els.costToday, tokens: lc.todayTokens || 0, cost: lc.todayCost || 0 },
    { key: 'week',  cell: els.cellWeek,  primaryEl: els.tokWeek,  subEl: els.costWeek,  tokens: lc.weekTokens || 0,  cost: lc.weekCost || 0 },
    { key: 'month', cell: els.cellMonth, primaryEl: els.tokMonth, subEl: els.costMonth, tokens: lc.monthTokens || 0, cost: lc.monthCost || 0 },
  ];
  for (const p of cards) {
    const tokStr = '~' + fmtTok(p.tokens);
    const costStr = fmtUsd(p.cost);
    p.primaryEl.textContent = isCost ? costStr : tokStr;
    p.subEl.textContent = isCost ? tokStr : costStr;
    const isAct = !selectedDay && activityPeriod === p.key;
    p.cell.classList.toggle('active', isAct);
    p.cell.setAttribute('aria-pressed', isAct ? 'true' : 'false');
  }

  // Day chip when a single day is pinned. It names the scope, so the summary
  // beside it does not have to.
  els.dayChip.classList.toggle('hidden', !selectedDay);
  if (selectedDay) els.dayChip.textContent = formatShortDate(selectedDay) + ' ×';

  const sel = activitySelection(lc, daily);
  const scope = sel.label ? ` (${sel.label})` : '';
  els.localApprox.textContent = `~${fmtUsd(sel.cost)} · ~${fmtTok(sel.tokens)}${scope}`;

  renderDailyComparison(ctx, lc);
  renderBurnRow(ctx, head);
  renderModelBar(sel.costModels, sel.tokenModels);
}

let lastDailyBarsSig = null;

function buildDays(daily, numDays) {
  const now = new Date();
  const days = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDayKey(d);
    const bucket = daily[key] || {};
    const shortDate = formatShortDate(key);
    days.push({
      key,
      shortLabel: i === 0 ? 'Today' : String(d.getDate()),
      metaLabel: i === 0 ? 'Today' : (i === 1 ? 'Yesterday' : shortDate),
      fullLabel: i === 0 ? `Today (${shortDate})` : (i === 1 ? `Yesterday (${shortDate})` : shortDate),
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
  return days;
}

function dayBarHtml(d, isCost, maxVal) {
  const val = isCost ? d.cost : d.tokens;
  const totalPct = val > 0 ? Math.max(8, Math.min(100, (val / maxVal) * 100)) : 0;
  const entries = Object.entries(isCost ? d.models : d.modelTokens)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((s, [, v]) => s + v, 0);

  let segHtml = '';
  if (totalPct > 0 && sum > 0) {
    segHtml = entries.map(([m, v]) =>
      `<div class="day-seg" style="height:${((v / sum) * totalPct).toFixed(1)}%;background:${modelColor(m)}"></div>`).join('');
  } else if (totalPct > 0) {
    segHtml = `<div class="day-seg" style="height:${totalPct.toFixed(1)}%;background:var(--accent)"></div>`;
  }

  const isAct = selectedDay === d.key;
  const title = `${d.fullLabel}: ${fmtUsd(d.cost)} · ~${fmtTok(d.tokens)}`;
  return `<button type="button" class="day-col${isAct ? ' active' : ''}" data-day="${d.key}" aria-pressed="${isAct ? 'true' : 'false'}" title="${escapeHtml(title)}">`
    + `<div class="day-bar-track">${segHtml}</div>`
    + `<span class="day-lbl">${escapeHtml(d.shortLabel)}</span>`
    + '</button>';
}

function renderDailyComparison(ctx, lc) {
  const daily = lc.daily || {};
  const days = buildDays(daily, activityPeriod === 'month' ? 14 : 7);
  const isCost = activityMetric === 'cost';
  const maxVal = Math.max(1e-9, ...days.map((d) => (isCost ? d.cost : d.tokens)));

  const sig = [
    ctx.provider,
    activityPeriod,
    activityMetric,
    selectedDay || '',
    days.map((d) => `${d.key}:${d.cost.toFixed(3)}:${d.tokens}`).join(','),
  ].join('|');

  if (sig !== lastDailyBarsSig) {
    lastDailyBarsSig = sig;
    // Rebuilding the bars must not drop keyboard focus from the one in use.
    const focusedDay = document.activeElement?.closest?.('.day-col')?.dataset.day;
    els.dailyBars.innerHTML = days.map((d) => dayBarHtml(d, isCost, maxVal)).join('');
    if (focusedDay) els.dailyBars.querySelector(`[data-day="${focusedDay}"]`)?.focus();
  }

  const focusObj = days.find((d) => d.key === (hoveredDay || selectedDay)) || days[days.length - 1];
  const leftText = `${focusObj.metaLabel}: ${fmtUsd(focusObj.cost)} · ~${fmtTok(focusObj.tokens)}`;

  els.dailyMeta.innerHTML =
    `<span class="daily-meta-left">${escapeHtml(leftText)}</span>`
    + `<span class="daily-meta-right">${dailyComparisonHtml(ctx, days, focusObj, isCost)}</span>`;
}

// Combined shows the Claude and Gemini split for the day. Single-provider tabs
// compare the day with the 7-day average. Only formatter output reaches this
// HTML, so nothing here needs escaping.
function dailyComparisonHtml(ctx, days, focusObj, isCost) {
  if (ctx.provider === 'combined') {
    return isCost
      ? `C ${fmtUsd(focusObj.claudeCost)} · G ${fmtUsd(focusObj.geminiCost)}`
      : `C ~${fmtTok(focusObj.claudeTokens || 0)} · G ~${fmtTok(focusObj.geminiTokens || 0)}`;
  }
  const last7 = days.slice(-7);
  const avg = last7.reduce((s, d) => s + (isCost ? d.cost : d.tokens), 0) / last7.length;
  const val = isCost ? focusObj.cost : focusObj.tokens;
  if (avg > 0 && val > 0) {
    const diffPct = Math.round(((val - avg) / avg) * 100);
    const cls = diffPct > 15 ? 'up' : (diffPct < -15 ? 'down' : '');
    return `<span class="daily-delta ${cls}">${diffPct > 0 ? '+' : ''}${diffPct}%</span> vs 7d avg`;
  }
  return avg > 0 ? `7d avg ${isCost ? fmtUsd(avg) : '~' + fmtTok(avg)}/day` : '';
}

function renderBurnRow(ctx, head) {
  els.burnRow.classList.toggle('hidden', ctx.burnRate == null);
  if (ctx.burnRate == null) return;
  els.burnVal.textContent = fmtRate(ctx.burnRate);

  const pace = head && head.pace;
  const proj = pace ? pace.projectedPct : null;
  const showProj = proj != null && proj > 1 && pace.elapsedPct > 5;
  els.burnProjected.textContent = showProj ? '→ ' + Math.round(proj) + '% by reset' : '';
  els.burnProjected.classList.toggle('high', Boolean(showProj && proj >= 100));
  els.burnProjected.classList.toggle('med', Boolean(showProj && proj >= 80 && proj < 100));
}

function renderExtra(ctx) {
  const ex = ctx.extraUsage;
  els.extraSection.classList.toggle('hidden', !ex);
  if (!ex) return;
  els.extraLabel.textContent = ex.label;
  els.extraVal.textContent = ex.text;
  els.extraBar.classList.toggle('hidden', ex.percent == null);
  if (ex.percent != null) els.extraFill.style.width = ex.percent + '%';
}

function renderFooter(ctx) {
  els.plan.textContent = ctx.planName || '--';
  els.plan.title = ctx.planName || '';
  renderUpdated();
  els.refresh.classList.toggle('spinning', Boolean(ctx.isLoading));
}

// How old the limit numbers are. Local spend refreshes on its own every 30s
// and does not count, or the footer would say "just now" during an outage.
function renderUpdated() {
  els.updated.textContent = lastUpdatedIso ? 'Updated ' + relativeTime(lastUpdatedIso) : 'Local logs only';
}

// Tick the footer once a second while visible. The renderer process keeps
// running when the window is hidden, so we gate on visibilityState to avoid a
// no-op DOM write every second forever.
function startUpdatedTicker() {
  clearInterval(updatedTimer);
  updatedTimer = null;
  if (document.visibilityState === 'visible') updatedTimer = setInterval(renderUpdated, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearInterval(updatedTimer);
    updatedTimer = null;
  } else {
    rerender();
  }
});

let lastModelSig = null;

function renderModelBar(costBreakdown, tokenBreakdown) {
  const isCost = activityMetric === 'cost';
  const names = new Set([...Object.keys(costBreakdown), ...Object.keys(tokenBreakdown)]);
  const entries = [];
  for (const model of names) {
    const cost = Number(costBreakdown[model]) || 0;
    const tokens = Number(tokenBreakdown[model]) || 0;
    if (cost > 0 || tokens > 0) entries.push({ model, cost, tokens, primary: isCost ? cost : tokens });
  }

  const sig = activityMetric + '|' + entries.map((e) => `${e.model}:${e.cost.toFixed(4)}:${e.tokens}`).sort().join('|');
  if (sig === lastModelSig) return;
  lastModelSig = sig;

  els.modelBarWrap.classList.toggle('empty', !entries.length);
  entries.sort((a, b) => b.primary - a.primary);
  const total = entries.reduce((s, e) => s + e.primary, 0) || 1;

  const shown = collapseSmallModels(entries, total);

  els.modelBar.innerHTML = shown.map((e) =>
    `<div class="seg" style="width:${((e.primary / total) * 100).toFixed(2)}%;background:${modelColor(e.model)}"></div>`).join('');

  els.modelLegend.innerHTML = shown.map((e) => {
    const value = isCost ? fmtUsd(e.cost) : `~${fmtTok(e.tokens)}`;
    const title = `${(e.members || [e.model]).join(', ')}: ${fmtUsd(e.cost)} · ~${fmtTok(e.tokens)} tokens`;
    return `<span class="leg" title="${escapeHtml(title)}">`
      + `<span class="swatch" style="background:${modelColor(e.model)}"></span>`
      + `<span class="leg-name">${escapeHtml(e.model)}</span>`
      + `<span>${escapeHtml(value)}</span>`
      + '</span>';
  }).join('');
}

// Models under 1% of the total are invisible in the bar and crowd the legend.
// Fold two or more of them into one "Other" entry. Its tooltip names them.
function collapseSmallModels(entries, total) {
  const small = entries.filter((e) => e.primary / total < 0.01);
  if (small.length < 2) return entries;
  const other = { model: 'Other', members: small.map((e) => e.model), cost: 0, tokens: 0, primary: 0 };
  for (const e of small) {
    other.cost += e.cost;
    other.tokens += e.tokens;
    other.primary += e.primary;
  }
  return [...entries.filter((e) => e.primary / total >= 0.01), other];
}

// ============ WIRING ============

// Provider switcher tabs (click + ARIA tablist keyboard interactions).
function wireTabs() {
  const tabs = { claude: els.tabClaude, gemini: els.tabGemini, combined: els.tabCombined };
  for (const key of PROVIDERS) {
    tabs[key].addEventListener('click', () => setActiveProvider(key));
    tabs[key].addEventListener('keydown', (e) => {
      const idx = PROVIDERS.indexOf(activeProvider);
      const n = PROVIDERS.length;
      const target = {
        ArrowRight: PROVIDERS[(idx + 1) % n],
        ArrowLeft: PROVIDERS[(idx - 1 + n) % n],
        Home: PROVIDERS[0],
        End: PROVIDERS[n - 1],
      }[e.key];
      if (!target) return;
      e.preventDefault();
      setActiveProvider(target, { focusTab: true });
    });
  }
  updateTabUI(false);
}
wireTabs();

// Click a limit row to pin it as the headline. Click again to unpin.
els.limits.addEventListener('click', (e) => {
  const key = e.target.closest('.limit-row')?.dataset.key;
  if (!key) return;
  const cur = pinnedByProvider[activeProvider];
  pinnedByProvider[activeProvider] = cur === key ? null : key;
  rerender();
});

els.cellToday.addEventListener('click', () => setActivityPeriod('today'));
els.cellWeek.addEventListener('click', () => setActivityPeriod('week'));
els.cellMonth.addEventListener('click', () => setActivityPeriod('month'));
els.metricCost.addEventListener('click', () => setActivityMetric('cost'));
els.metricTokens.addEventListener('click', () => setActivityMetric('tokens'));

els.dayChip.addEventListener('click', () => {
  selectedDay = null;
  rerender();
});

function setHoveredDay(day) {
  if (day === hoveredDay) return;
  hoveredDay = day;
  rerender();
}

els.dailyBars.addEventListener('click', (e) => {
  const day = e.target.closest('.day-col')?.dataset.day;
  if (!day) return;
  selectedDay = selectedDay === day ? null : day;
  rerender();
});
const hoverTarget = (e) => {
  const day = e.target.closest('.day-col')?.dataset.day;
  if (day) setHoveredDay(day);
};
els.dailyBars.addEventListener('mouseover', hoverTarget);
els.dailyBars.addEventListener('focusin', hoverTarget);
els.dailyBars.addEventListener('mouseleave', () => setHoveredDay(null));
els.dailyBars.addEventListener('focusout', () => setHoveredDay(null));

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
  const root = $('app');
  let lastH = 0;
  let pending = false;
  const send = () => {
    pending = false;
    const h = Math.ceil(root.getBoundingClientRect().height);
    if (h <= 0 || Math.abs(h - lastH) < 2) return;
    lastH = h;
    window.claudeBar.setHeight(h);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(send);
  };
  new ResizeObserver(schedule).observe(root);
  schedule();
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.claudeBar.hide();
    return;
  }
  // Avoid hijacking when modifier keys are involved. A held key must not repeat.
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const tab = { 1: 'claude', 2: 'gemini', 3: 'combined' }[e.key];
  if (tab) setActiveProvider(tab);
  else if (e.key === 'r' || e.key === 'R') window.claudeBar.refresh();
  else if (e.key === 'q' || e.key === 'Q') window.claudeBar.quit();
});
