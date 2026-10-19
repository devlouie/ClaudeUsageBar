'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  // states
  empty: $('empty-state'),
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
  tokToday: $('tok-today'),
  tokWeek: $('tok-week'),
  tokMonth: $('tok-month'),
  burnRow: $('burn-row'),
  burnVal: $('burn-val'),
  burnProjected: $('burn-projected'),
  modelBarWrap: $('model-bar-wrap'),
  modelBar: $('model-bar'),
  modelLegend: $('model-legend'),

  // extra
  extraSection: $('extra-section'),
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
// Which limit row the user has pinned to the headline (null = auto = worst)
let pinnedHeadline = null;

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
      // call out projected exhaustion
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

function pickHeadline(snap) {
  // Priority: user pin -> worst-of-four -> session as default.
  const candidates = {
    session: { key: 'session', label: 'Session', tag: snap.fiveHourResetIn || '', percent: snap.sessionPercent },
    weekly:  { key: 'weekly',  label: 'Weekly',  tag: snap.sevenDayResetIn || '', percent: snap.weeklyPercent },
    fable:   { key: 'fable',   label: 'Fable 7d', tag: snap.sevenDayResetIn || '', percent: snap.fablePercent },
    opus:    { key: 'opus',    label: 'Opus 7d', tag: snap.sevenDayResetIn || '', percent: snap.opusPercent },
  };
  if (pinnedHeadline && candidates[pinnedHeadline]) return candidates[pinnedHeadline];
  // Auto: worst nonzero
  const arr = Object.values(candidates);
  arr.sort((a, b) => b.percent - a.percent);
  return arr[0];
}

function render(snap) {
  lastSnapshot = snap;
  if (!routeState(snap)) return;       // returned early into a non-content view
  renderStaleStrip(snap);
  const head = pickHeadline(snap);
  renderHeadline(snap, head);
  renderRows(snap, head.key);
  renderLocal(snap, head.key);
  renderExtra(snap);
  renderFooter(snap);
  startUpdatedTicker();
}

// Decide which top-level view to show (loading / empty / error / content).
// Returns true if the content view is active and the rest of render() should
// run; false if we routed into a placeholder and there's nothing else to do.
function routeState(snap) {
  if (!snap.hasLoaded && !snap.errorMessage && snap.isLoading) {
    show('loading');
    return false;
  }
  // Credential errors get the friendlier "empty" view with a sign-in CTA.
  const isCredError = !!snap.credentialError;
  if (!snap.hasLoaded && isCredError) {
    show('empty');
    els.emptyText.textContent = snap.errorMessage;
    return false;
  }
  if (!snap.hasLoaded && snap.errorMessage) {
    show('error');
    els.errorText.textContent = snap.errorMessage;
    return false;
  }
  if (!snap.hasLoaded) {
    show('loading');
    return false;
  }
  show('content');
  return true;
}

function renderStaleStrip(snap) {
  if (snap.errorMessage) {
    els.stale.textContent = snap.errorMessage;
    els.stale.classList.remove('hidden');
  } else {
    els.stale.classList.add('hidden');
  }
}

function renderHeadline(snap, head) {
  const cls = statusClass(head.percent);
  els.headline.classList.remove('status-low', 'status-med', 'status-high');
  els.headline.classList.add('status-' + cls);
  els.headlineLabel.textContent = head.label;
  els.headlineTag.textContent = head.tag || '';
  els.headlineTag.style.display = head.tag ? '' : 'none';
  els.headlinePct.textContent = Math.round(head.percent);
  els.headlineBarFill.style.width = Math.min(100, Math.max(0, head.percent)) + '%';

  if (head.key === 'session') {
    renderSessionTickAndProjection(snap);
    els.headlineReset.textContent = snap.fiveHourResetIn ? capitalize(snap.fiveHourResetIn) : '';
  } else {
    els.headlineBarTick.style.display = 'none';
    els.headlineBarProjected.classList.remove('active');
    els.headlineElapsed.textContent = '';
    els.headlineReset.textContent = (head.key === 'weekly' || head.key === 'fable' || head.key === 'opus')
      ? (snap.sevenDayResetIn ? capitalize(snap.sevenDayResetIn) : '')
      : '';
  }

  renderVerdict(snap, head);
}

function renderSessionTickAndProjection(snap) {
  const elapsed = Math.min(100, Math.max(0, snap.sessionElapsedPercent));
  els.headlineBarTick.style.left = elapsed + '%';
  els.headlineBarTick.style.display = '';
  els.headlineElapsed.textContent = 'Window ' + Math.round(elapsed) + '% elapsed';

  const proj = snap.projectedSessionPercent;
  const sessionPct = snap.sessionPercent;
  if (proj != null && proj > sessionPct + 1 && proj < 200 && elapsed > 5 && elapsed < 99) {
    els.headlineBarProjected.style.left = Math.min(100, proj) + '%';
    els.headlineBarProjected.classList.add('active');
  } else {
    els.headlineBarProjected.classList.remove('active');
  }
}

let lastVerdictSig = null;

function renderVerdict(snap, head) {
  const verdict = head.key === 'session' ? (snap.paceVerdict || 'pace') : 'pace';
  const text = head.key === 'session'
    ? verdictText(verdict, snap.projectedSessionPercent, head.percent, snap.fiveHourResetIn)
    : 'Worst-pressure limit right now';
  const sig = verdict + '\u0000' + text;
  if (sig === lastVerdictSig) return;
  lastVerdictSig = sig;

  els.headlineVerdict.className = 'headline-verdict verdict-' + verdict;
  els.headlineVerdict.innerHTML = '<span class="verdict-dot"></span>' + escapeHtml(text);
}

function renderRows(snap, headKey) {
  setRow(els.rowSession, els.barSession, els.pctSession, snap.sessionPercent, headKey === 'session');
  setRow(els.rowWeekly,  els.barWeekly,  els.pctWeekly,  snap.weeklyPercent,  headKey === 'weekly');
  setRow(els.rowFable,   els.barFable,   els.pctFable,   snap.fablePercent,   headKey === 'fable');
  setRow(els.rowOpus,    els.barOpus,    els.pctOpus,    snap.opusPercent,    headKey === 'opus');
}

function renderLocal(snap, headKey) {
  const lc = snap.localCosts;
  if (!lc) {
    els.localSection.classList.add('hidden');
    return;
  }
  els.localSection.classList.remove('hidden');
  els.tokToday.textContent = '~' + fmtTok(lc.todayTokens);
  els.tokWeek.textContent  = '~' + fmtTok(lc.weekTokens);
  els.tokMonth.textContent = '~' + fmtTok(lc.monthTokens);
  renderBurnRow(snap, headKey);
  renderModelBar(lc.modelBreakdown || {});
}

function renderBurnRow(snap, headKey) {
  if (snap.burnRate == null) {
    els.burnRow.classList.add('hidden');
    return;
  }
  els.burnRow.classList.remove('hidden');
  els.burnVal.textContent = fmtRate(snap.burnRate);
  const proj = snap.projectedSessionPercent;
  if (proj != null && proj > 1 && headKey === 'session' && snap.sessionElapsedPercent > 5) {
    els.burnProjected.textContent = '-> ' + Math.round(Math.min(999, proj)) + '% by reset';
    els.burnProjected.classList.remove('high', 'med');
    if (proj >= 100) els.burnProjected.classList.add('high');
    else if (proj >= 80) els.burnProjected.classList.add('med');
  } else {
    els.burnProjected.textContent = '';
  }
}

function renderExtra(snap) {
  const ex = snap.extraUsage;
  if (ex && ex.is_enabled && ex.used_credits != null && ex.monthly_limit != null && ex.monthly_limit > 0) {
    els.extraSection.classList.remove('hidden');
    const pct = Math.min(100, (ex.used_credits / ex.monthly_limit) * 100);
    els.extraFill.style.width = pct + '%';
    els.extraVal.textContent = '$' + ex.used_credits.toFixed(2) + ' / $' + ex.monthly_limit.toFixed(2);
  } else {
    els.extraSection.classList.add('hidden');
  }
}

function renderFooter(snap) {
  els.plan.textContent = snap.planName || '--';
  els.updated.textContent = relativeTime(snap.lastUpdated);
  els.refresh.classList.toggle('spinning', !!snap.isLoading);
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

function renderModelBar(breakdown) {
  const entries = Object.entries(breakdown).filter(([, v]) => v > 0);
  // Rebuilding this markup on every push re-parses HTML for a bar that rarely
  // changes. Signature-compare first and bail when it's identical.
  const sig = entries.map(([m, c]) => m + ':' + c.toFixed(4)).sort().join('|');
  if (sig === lastModelSig) return;
  lastModelSig = sig;

  if (!entries.length) {
    els.modelBarWrap.classList.add('empty');
    els.modelBar.innerHTML = '';
    els.modelLegend.innerHTML = '';
    return;
  }
  els.modelBarWrap.classList.remove('empty');
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  els.modelBar.innerHTML = buildModelSegments(entries, total);
  els.modelLegend.innerHTML = buildModelLegend(entries);
}

function buildModelSegments(entries, total) {
  return entries.map(([model, cost]) => {
    const w = (cost / total) * 100;
    const c = modelColor(model);
    return '<div class="seg" style="width:' + w.toFixed(2) + '%;background:' + c + '"></div>';
  }).join('');
}

function buildModelLegend(entries) {
  return entries.map(([model, cost]) => {
    const c = modelColor(model);
    return '<span class="leg">' +
      '<span class="swatch" style="background:' + c + '"></span>' +
      '<span class="leg-name">' + escapeHtml(model) + '</span>' +
      '<span>$' + cost.toFixed(2) + '</span>' +
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

// Click (or Enter/Space) a limit row to pin it as the headline; again to unpin.
function wireRow(rowEl, key) {
  const toggle = () => {
    pinnedHeadline = (pinnedHeadline === key) ? null : key;
    if (lastSnapshot) render(lastSnapshot);
  };
  rowEl.addEventListener('click', toggle);
  rowEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}
wireRow(els.rowSession, 'session');
wireRow(els.rowWeekly,  'weekly');
wireRow(els.rowFable,   'fable');
wireRow(els.rowOpus,    'opus');

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
  if (e.key === 'r' || e.key === 'R') {
    window.claudeBar.refresh();
  } else if (e.key === 'q' || e.key === 'Q') {
    window.claudeBar.quit();
  }
});
