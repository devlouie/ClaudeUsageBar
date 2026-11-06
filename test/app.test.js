// Regression tests for the network layer, the poller, derived numbers, and the
// tray icon. Run: node test/app.test.js
//
// No network and no real timers beyond a few ms. Date.now is driven by hand
// where a test depends on the throttle clock.

const assert = require('assert');
const http = require('http');

const fs = require('fs');
const path = require('path');
const { request, refreshGeminiAccessToken } = require('../src/api');
const { createPoller } = require('../src/poller');
const { REASON } = require('../src/credentials');
const { snapshotForRenderer, claudeLimits, geminiLimits, combinedWorstPercent, sessionPercent } = require('../src/derivations');
const { drawTrayIcon } = require('../src/trayIcon');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
}

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(server.address().port));
      } catch (e) {
        reject(e);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  });
}

const local = (port, opts = {}) => request({ transport: http, hostname: '127.0.0.1', port, path: '/', ...opts });

const EMPTY_LOGS = {
  claude: { monthTokens: 0, sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  gemini: { monthTokens: 0, sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
};

// A poller with fake providers. `clock` drives Date.now through `at()`.
function harness(over = {}) {
  const state = { usage: null, hasLoaded: false, errorMessage: null, credentialError: null, geminiHasLoaded: false, geminiErrorMessage: null, geminiCredentialError: null };
  const box = { token: 't1', nextToken: 't1', usageCalls: [], gemCalls: 0, loads: 0, logCalls: [], pushes: 0 };
  const poller = createPoller({
    state,
    getToken: () => box.token,
    setToken: (t) => { box.token = t; },
    loadCredentials: async () => { box.loads++; box.token = box.nextToken; },
    pushToWindow: () => { box.pushes++; },
    refreshTray: () => {},
    popupVisible: () => false,
    fetchUsage: async (t) => { box.usageCalls.push(t); return { ok: true, status: 200, data: { five_hour: { utilization: 1 } } }; },
    parseLogs: async (o) => { box.logCalls.push(o); return EMPTY_LOGS; },
    stopLogs: () => {},
    ...over,
  });
  return { state, box, poller };
}

// Runs fn with Date.now at a controllable offset from the real time.
async function withClock(fn) {
  const real = Date.now;
  const t0 = real();
  let offset = 0;
  Date.now = () => t0 + offset;
  try {
    await fn((ms) => { offset = ms; });
  } finally {
    Date.now = real;
  }
}

(async () => {
  // --- request() always settles -------------------------------------------
  await check('request parses a good response', () => withServer(
    (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"a":1}'); },
    async (port) => {
      const r = await local(port);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.data, { a: 1 });
    }));

  await check('a response cut off mid-body resolves instead of hanging', () => withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"partial":');
      setTimeout(() => res.socket.destroy(), 10);
    },
    async (port) => {
      const r = await local(port);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'ECONNRESET');
    }));

  await check('a stalled server hits the deadline', () => withServer(
    () => {},
    async (port) => {
      const r = await local(port, { timeoutMs: 40 });
      assert.deepStrictEqual(r, { ok: false, error: 'timeout' });
    }));

  await check('a refused connection resolves with its code', async () => {
    const port = await withServer(() => {}, async (p) => p); // closed by now
    const r = await local(port);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ECONNREFUSED');
  });

  await check('an error body yields its message and Retry-After', () => withServer(
    (_req, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}');
    },
    async (port) => {
      const r = await local(port);
      assert.strictEqual(r.status, 429);
      assert.strictEqual(r.error, 'Slow down');
      assert.strictEqual(r.retryAfterMs, 120_000);
    }));

  await check('an HTML error page yields no error text', () => withServer(
    (_req, res) => { res.writeHead(502); res.end('<html>Bad gateway</html>'); },
    async (port) => assert.strictEqual((await local(port)).error, '')));

  await check('POST bodies arrive as JSON', () => withServer(
    (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => res.end(JSON.stringify({ got: JSON.parse(body), type: req.headers['content-type'] })));
    },
    async (port) => {
      const r = await local(port, { method: 'POST', body: { x: 1 } });
      assert.deepStrictEqual(r.data, { got: { x: 1 }, type: 'application/json' });
    }));

  // --- Poller -------------------------------------------------------------
  await check('a rotated Claude token retries at once with the new token', async () => {
    const { state, box, poller } = harness({
      fetchUsage: async (t) => {
        box.usageCalls.push(t);
        return t === 't1' ? { ok: false, status: 401, error: 'expired' } : { ok: true, status: 200, data: { ok: 1 } };
      },
    });
    box.nextToken = 't2';
    await poller.refresh({ manual: true });
    poller.stop();
    assert.deepStrictEqual(box.usageCalls, ['t1', 't2']);
    assert.deepStrictEqual(state.usage, { ok: 1 });
    assert.strictEqual(state.errorMessage, null);
  });

  await check('a token rejected twice stops and says so', async () => {
    const { state, box, poller } = harness({
      fetchUsage: async (t) => { box.usageCalls.push(t); return { ok: false, status: 401 }; },
    });
    await poller.refresh({ manual: true });
    poller.stop();
    assert.deepStrictEqual(box.usageCalls, ['t1']);
    assert.match(state.errorMessage, /Token rejected/);
  });

  await check('overlapping refreshes share one fetch and count one failure', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { box, poller } = harness({
      fetchUsage: async (t) => { box.usageCalls.push(t); await gate; return { ok: true, data: {} }; },
    });
    const a = poller.refresh({ manual: true });
    const b = poller.refresh({ manual: true });
    const c = poller.refresh();
    release();
    await Promise.all([a, b, c]);
    poller.stop();
    assert.strictEqual(box.usageCalls.length, 1);
  });

  await check('a forced re-read during a refresh still re-reads', async () => {
    const { box, poller } = harness();
    await Promise.all([poller.refresh({ manual: true }), poller.refresh({ forceSource: true, manual: true })]);
    poller.stop();
    assert.strictEqual(box.loads, 1);
  });

  await check('a failing log parse and a failing window push do not kill the loop', async () => {
    const { state, box, poller } = harness({
      parseLogs: async () => { throw new Error('disk gone'); },
      pushToWindow: () => { throw new Error('frame gone'); },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await poller.refreshLocal();
      await poller.refresh({ manual: true });
    } finally {
      console.warn = warn;
      poller.stop();
    }
    assert.strictEqual(box.usageCalls.length, 1);
    assert.ok(state.usage);
  });

  await check('a thrown fetch clears the spinner and lets the next refresh run', async () => {
    let boom = true;
    const { state, box, poller } = harness({
      fetchUsage: async (t) => {
        box.usageCalls.push(t);
        if (boom) throw new Error('boom');
        return { ok: true, data: {} };
      },
    });
    const warn = console.warn;
    console.warn = () => {};
    await poller.refresh({ manual: true });
    console.warn = warn;
    assert.strictEqual(state.isLoading, false);
    boom = false;
    await poller.refresh({ manual: true });
    poller.stop();
    assert.ok(state.usage);
  });

  await check('local parsing does not move the "updated" time', async () => {
    const { state, poller } = harness();
    await poller.refreshLocal();
    poller.stop();
    assert.ok(!state.lastUpdated);
  });

  await check('a failed fetch does not move the "updated" time', async () => {
    const { state, poller } = harness({ fetchUsage: async () => ({ ok: false, status: 500 }) });
    await poller.refresh({ manual: true });
    poller.stop();
    assert.ok(!state.lastUpdated);
    assert.match(state.errorMessage, /unavailable \(500\)/);
  });

  await check('local spend counts as loaded for a provider with no API answer', async () => {
    const logs = { claude: { ...EMPTY_LOGS.claude, monthTokens: 5 }, gemini: EMPTY_LOGS.gemini };
    const { state, poller } = harness({ parseLogs: async () => logs });
    await poller.refreshLocal();
    poller.stop();
    assert.strictEqual(state.hasLoaded, true);
    assert.strictEqual(state.usage, null);
    assert.strictEqual(state.geminiHasLoaded, false);
  });

  await check('opening the popup refreshes after the minimum gap, not the hidden cadence', () => withClock(async (at) => {
    const { box, poller } = harness();
    at(0);
    await poller.refresh({ manual: true });
    at(10_000);
    await poller.popupOpened();
    assert.strictEqual(box.usageCalls.length, 1, 'inside the gap');
    at(60_000);
    await poller.popupOpened();
    poller.stop();
    assert.strictEqual(box.usageCalls.length, 2, 'past the gap');
  }));

  await check('429 Retry-After blocks manual refresh too, until it passes', () => withClock(async (at) => {
    let answer = { ok: false, status: 429, retryAfterMs: 600_000 };
    const { state, box, poller } = harness({
      fetchUsage: async (t) => { box.usageCalls.push(t); return answer; },
    });
    at(0);
    await poller.refresh({ manual: true });
    assert.match(state.errorMessage, /throttled/);
    at(300_000);
    await poller.refresh({ manual: true });
    await poller.popupOpened();
    assert.strictEqual(box.usageCalls.length, 1, 'inside Retry-After');
    answer = { ok: true, data: {} };
    at(601_000);
    await poller.refresh({ manual: true });
    poller.stop();
    assert.strictEqual(box.usageCalls.length, 2);
    assert.strictEqual(state.errorMessage, null);
  }));

  await check('a soft error lets manual refresh through but holds back auto polls', () => withClock(async (at) => {
    const { box, poller } = harness({
      fetchUsage: async (t) => { box.usageCalls.push(t); return { ok: false, status: 500 }; },
    });
    at(0);
    await poller.refresh({ manual: true });
    at(1_000);
    await poller.refresh();
    assert.strictEqual(box.usageCalls.length, 1);
    await poller.refresh({ manual: true });
    poller.stop();
    assert.strictEqual(box.usageCalls.length, 2);
  }));

  await check('being offline retries in 30 seconds, not 5 minutes', () => withClock(async (at) => {
    const { state, box, poller } = harness({
      fetchUsage: async (t) => { box.usageCalls.push(t); return { ok: false, error: 'getaddrinfo', code: 'ENOTFOUND' }; },
    });
    at(0);
    await poller.refresh({ manual: true });
    assert.strictEqual(state.errorMessage, 'Offline.');
    at(29_000);
    await poller.refresh();
    assert.strictEqual(box.usageCalls.length, 1);
    at(31_000);
    await poller.refresh();
    poller.stop();
    assert.strictEqual(box.usageCalls.length, 2);
  }));

  await check('a new session reset time re-parses local logs with that window', async () => {
    const resets = iso(2 * HOUR);
    const { box, poller } = harness({
      fetchUsage: async () => ({ ok: true, data: { five_hour: { utilization: 5, resets_at: resets } } }),
    });
    await poller.refresh({ manual: true });
    const parsesAfterFirst = box.logCalls.length;
    assert.strictEqual(box.logCalls[parsesAfterFirst - 1].sessionResetAt.toISOString(), resets);
    await poller.refresh({ manual: true });
    poller.stop();
    assert.strictEqual(box.logCalls.length, parsesAfterFirst + 1, 'no extra parse when nothing moved');
  });

  await check('a denied keychain is not re-prompted by auto polls', async () => {
    const { state, box, poller } = harness();
    box.token = null;
    box.nextToken = null;
    state.credentialError = { reason: REASON.LOCKED_KEYCHAIN };
    await poller.refresh();
    assert.strictEqual(box.loads, 0);
    await poller.refresh({ manual: true });
    poller.stop();
    assert.strictEqual(box.loads, 1);
  });

  await check('Gemini carries on alone when Claude has no token', async () => {
    let gemCalls = 0;
    const gem = { ok: true, oauth: { accessToken: 'g' } };
    const { state, box, poller } = harness({
      getGeminiCreds: () => gem,
      fetchGeminiUsage: async () => { gemCalls++; return { ok: true, data: { five_hour: { utilization: 3 } } }; },
    });
    box.token = null;
    box.nextToken = null;
    await poller.refresh({ manual: true });
    poller.stop();
    assert.strictEqual(gemCalls, 1);
    assert.strictEqual(state.geminiUsage.five_hour.utilization, 3);
    assert.ok(state.geminiLastUpdated);
  });

  await check('a rejected Gemini token is re-read from disk and retried', async () => {
    const tokens = [];
    let gem = { ok: true, oauth: { accessToken: 'old' } };
    const { state, poller } = harness({
      getGeminiCreds: () => gem,
      loadGeminiCredentials: async () => { gem = { ok: true, oauth: { accessToken: 'new' } }; },
      fetchGeminiUsage: async (c) => {
        tokens.push(c.oauth.accessToken);
        return c.oauth.accessToken === 'old' ? { ok: false, status: 401 } : { ok: true, data: { five_hour: { utilization: 2 } } };
      },
    });
    await poller.refresh({ manual: true });
    poller.stop();
    assert.deepStrictEqual(tokens, ['old', 'new']);
    assert.strictEqual(state.geminiErrorMessage, null);
  });

  await check('an expired Gemini token is re-read before it is sent', async () => {
    let loads = 0;
    const gem = { ok: true, oauth: { accessToken: 'g', expiresAt: Date.now() - 1000 } };
    const { poller } = harness({
      getGeminiCreds: () => gem,
      loadGeminiCredentials: async () => { loads++; },
      fetchGeminiUsage: async () => ({ ok: true, data: {} }),
    });
    await poller.refresh();
    poller.stop();
    assert.strictEqual(loads, 1);
  });

  // --- Gemini sign-in conduct ---------------------------------------------
  await check('no Google token refresh without a client the user supplies', async () => {
    const saved = [process.env.GEMINI_OAUTH_CLIENT_ID, process.env.GEMINI_OAUTH_CLIENT_SECRET];
    delete process.env.GEMINI_OAUTH_CLIENT_ID;
    delete process.env.GEMINI_OAUTH_CLIENT_SECRET;
    try {
      assert.strictEqual(await refreshGeminiAccessToken({ accessToken: 'a', refreshToken: 'r' }), null);
    } finally {
      if (saved[0] !== undefined) process.env.GEMINI_OAUTH_CLIENT_ID = saved[0];
      if (saved[1] !== undefined) process.env.GEMINI_OAUTH_CLIENT_SECRET = saved[1];
    }
  });

  await check('the source ships no OAuth client secrets and no borrowed identity', () => {
    const dir = path.join(__dirname, '..', 'src');
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const bad of [/GOCSPX/, /'GOC'/, /googleusercontent/, /\.join\('-'\) \+ '\.'/, /ideType: 'ANTIGRAVITY'/, /antigravity\/\d/]) {
        assert.ok(!bad.test(text), `${name} matches ${bad}`);
      }
    }
  });

  // --- Derived numbers ----------------------------------------------------
  const claudeUsage = (over = {}) => ({
    five_hour: null,
    seven_day: { utilization: 9, resets_at: '2099-11-09T17:59:59.522428+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 9, resets_at: iso(DAY), scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 40, resets_at: iso(2 * DAY), scope: { model: { id: null, display_name: 'Fable' } } },
    ],
    ...over,
  });

  await check('rows come from the limits the API reports', () => {
    const rows = claudeLimits({ usage: claudeUsage() });
    assert.deepStrictEqual(rows.map((r) => r.short), ['Session', 'Weekly', 'Fable']);
    assert.strictEqual(rows[1].resetIn.startsWith('resets in'), true); // microsecond timestamp parses
    assert.match(rows[2].resetIn, /^resets in 1d|^resets in 2d/);
  });

  await check('a scoped Sonnet limit counts toward the worst number', () => {
    const usage = claudeUsage();
    usage.limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: 91, resets_at: iso(DAY), scope: { model: { display_name: 'Sonnet' } } });
    assert.strictEqual(combinedWorstPercent({ usage }), 91);
  });

  await check('legacy per-model fields still light up a row', () => {
    const rows = claudeLimits({ usage: { seven_day_opus: { utilization: 33 } } });
    assert.ok(rows.some((r) => r.short === 'Opus' && r.percent === 33));
  });

  await check('a window whose reset has passed reads 0, not its last value', () => {
    const state = { usage: { five_hour: { utilization: 97, resets_at: iso(-60_000) } } };
    assert.strictEqual(sessionPercent(state), 0);
    const [session] = claudeLimits(state);
    assert.strictEqual(session.resetIn, 'resetting…');
    assert.strictEqual(session.pace.verdict, 'fresh');
  });

  await check('pace: above the clock is flagged, and early windows are not judged', () => {
    const verdict = (util, remainingH) => claudeLimits({
      usage: { five_hour: { utilization: util, resets_at: iso(remainingH * HOUR) } },
    })[0].pace;
    assert.strictEqual(verdict(62, 2).verdict, 'fast'); // 60% elapsed, 103% projected
    assert.ok(verdict(62, 2).projectedPct > 100);
    assert.strictEqual(verdict(90, 2).verdict, 'burning');
    assert.strictEqual(verdict(40, 2).verdict, 'pace');
    assert.strictEqual(verdict(10, 2).verdict, 'idle');
    assert.strictEqual(verdict(4, 4.9).verdict, 'fresh'); // 2% elapsed
  });

  await check('a Gemini window Google did not report has no row', () => {
    const rows = geminiLimits({ geminiUsage: { five_hour: { utilization: 5 }, seven_day: null } });
    assert.deepStrictEqual(rows.map((r) => r.key), ['session']);
  });

  await check('Gemini partner quota is a row and counts toward the worst number', () => {
    const state = {
      geminiUsage: {
        five_hour: { utilization: 1 },
        seven_day: { utilization: 44 },
        third_party_five_hour: { utilization: 0 },
        third_party_seven_day: { utilization: 51 },
      },
    };
    assert.deepStrictEqual(geminiLimits(state).map((r) => r.short), ['Session 5h', 'Weekly 7d', 'Partner 5h', 'Partner 7d']);
    assert.strictEqual(combinedWorstPercent(state), 51);
  });

  await check('a provider with only local logs has no limits and no false 0%', () => {
    const snap = snapshotForRenderer({ geminiHasLoaded: true, geminiLocalCosts: { monthTokens: 5, sessionUsage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    assert.strictEqual(snap.gemini.limits.length, 0);
    assert.strictEqual(snap.gemini.worstPercent, null);
    assert.strictEqual(snap.gemini.planName, 'Gemini Local');
    assert.strictEqual(snap.combined.worstPercent, null);
  });

  await check('extra usage converts minor units', () => {
    const extra = (ex) => snapshotForRenderer({ usage: claudeUsage({ extra_usage: { is_enabled: true, ...ex } }) }).extraUsage;
    const capped = extra({ used_credits: 1234, monthly_limit: 5000, decimal_places: 2, currency: 'USD' });
    assert.strictEqual(capped.text, '$12.34 / $50.00');
    assert.ok(Math.abs(capped.percent - 24.68) < 1e-9);
    const open = extra({ used_credits: 1234, monthly_limit: null, decimal_places: 2 });
    assert.strictEqual(open.text, '$12.34 used');
    assert.strictEqual(open.percent, null);
    assert.strictEqual(snapshotForRenderer({ usage: claudeUsage({ extra_usage: { is_enabled: false, used_credits: 5 } }) }).extraUsage, null);
  });

  await check('combined lists every limit, so the badge always has a matching row', () => {
    const state = { usage: claudeUsage(), geminiUsage: { five_hour: { utilization: 1 }, third_party_seven_day: { utilization: 51 } } };
    const snap = snapshotForRenderer(state);
    assert.deepStrictEqual(snap.combined.limits.map((r) => r.short), ['Claude 5h', 'Claude 7d', 'Claude Fable', 'Gemini 5h', 'Partner 7d']);
    assert.strictEqual(Math.max(...snap.combined.limits.map((r) => r.percent)), snap.combined.worstPercent);
    assert.strictEqual(new Set(snap.combined.limits.map((r) => r.key)).size, 5);
  });

  await check('combined "updated" is the older of the two fetches', () => {
    const older = new Date(Date.now() - 600_000);
    const newer = new Date();
    const snap = snapshotForRenderer({ usage: {}, lastUpdated: newer, geminiUsage: {}, geminiLastUpdated: older });
    assert.strictEqual(snap.combined.lastUpdated, older.toISOString());
  });

  // --- Tray icon ----------------------------------------------------------
  const inked = ({ buffer }) => {
    let n = 0;
    for (let i = 3; i < buffer.length; i += 4) if (buffer[i]) n++;
    return n;
  };

  await check('tray icon is 44x44 at 2x, and the meter only ever fills up', () => {
    const empty = drawTrayIcon(0);
    assert.strictEqual(empty.width, 44);
    assert.strictEqual(empty.height, 44);
    assert.strictEqual(empty.buffer.length, 44 * 44 * 4);
    let prev = inked(empty);
    for (let p = 5; p <= 100; p += 5) {
      const n = inked(drawTrayIcon(p));
      assert.ok(n >= prev, `${p}% has less ink than the step before`);
      prev = n;
    }
    assert.strictEqual(prev, 5 * 6 * 20); // five solid 6x20 segments
  });

  await check('tray icon clamps bad input', () => {
    assert.deepStrictEqual(drawTrayIcon(-5).buffer, drawTrayIcon(0).buffer);
    assert.deepStrictEqual(drawTrayIcon(500).buffer, drawTrayIcon(100).buffer);
    assert.deepStrictEqual(drawTrayIcon(NaN).buffer, drawTrayIcon(0).buffer);
  });

  await check('tray icon draws in the requested grey level', () => {
    const { buffer } = drawTrayIcon(100, { level: 255 });
    let sawInk = false;
    for (let i = 0; i < buffer.length; i += 4) {
      if (buffer[i + 3]) {
        sawInk = true;
        assert.strictEqual(buffer[i], 255);
      }
    }
    assert.ok(sawInk);
  });

  console.log('\n' + passed + ' checks passed');
})();
