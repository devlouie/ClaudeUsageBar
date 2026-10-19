// Regression tests for the incremental JSONL parser + model naming.
// Run: node test/localUsage.test.js
//
// These pin the three bugs that made the parser slow or wrong:
//   1. offset drift on a multi-byte UTF-8 char straddling a read chunk
//   2. partial trailing lines being consumed before they're complete
//   3. single-number model ids (claude-opus-5) failing to resolve a name

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cub-test-'));
const realHome = os.homedir;
os.homedir = () => TMP;

const dir = path.join(TMP, '.claude', 'projects', 'proj');
fs.mkdirSync(dir, { recursive: true });
const FILE = path.join(dir, 's.jsonl');

const { parseLocalLogs, resetCache } = require('../src/localUsage');
const { displayName, tier, cost } = require('../src/pricing');

let n = 0;
function line(model, output, pad = '', usageExtra = {}) {
  n++;
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      id: 'm' + n,
      model,
      usage: {
        input_tokens: 10, output_tokens: output,
        cache_read_input_tokens: 5, cache_creation_input_tokens: 2,
        ...usageExtra,
      },
      pad,
    },
  }) + '\n';
}

function near(a, b) { return Math.abs(a - b) < 1e-12; }

let passed = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); passed++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

(async () => {
  // --- model naming -------------------------------------------------------
  const names = {
    'claude-opus-5': 'Opus 5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-opus-5[1m]': 'Opus 5',
    'claude-fable-5': 'Fable 5',
    'claude-mythos-5': 'Mythos 5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-opus-4-20250514': 'Opus 4',
    'claude-3-opus-20240229': 'Opus 3',
    'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
    'claude-opus-5-5': 'Opus 5.5',
    'claude-opus-5-5[1m]': 'Opus 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5',
    'claude-haiku-5-5': 'Haiku 5.5',
    'claude-fable-5-1': 'Fable 5.1',
    'claude-mythos-5-1': 'Mythos 5.1',
    'claude-opus-4-8': 'Opus 4.8',
  };
  for (const [id, want] of Object.entries(names)) {
    check('displayName ' + id, () => assert.strictEqual(displayName(id), want));
  }
  // --- pricing tiers ------------------------------------------------------
  const M = 1_000_000;
  const tiers = {
    'claude-fable-5-1': 'fable51',
    'claude-mythos-5-1': 'fable51',
    'claude-fable-5': 'fable5',
    'claude-mythos-preview': 'fable5',
    'claude-opus-5-5': 'opus55',
    'claude-opus-5-5[1m]': 'opus55',
    'claude-opus-5': 'opus45',
    'claude-opus-4-8': 'opus45',
    'claude-opus-4-5-20251101': 'opus45',
    'claude-opus-4-1-20250805': 'opusLegacy',
    'claude-opus-4-20250514': 'opusLegacy',
    'claude-3-opus-20240229': 'opusLegacy',
    'claude-sonnet-5-5': 'sonnet55',
    'claude-sonnet-5': 'sonnet5',
    'claude-sonnet-4-6': 'sonnet',
    'claude-3-5-sonnet-20241022': 'sonnet',
    'claude-haiku-5-5': 'haiku55',
    'claude-haiku-4-5-20251001': 'haiku45',
    'claude-3-5-haiku-20241022': 'haiku35',
    'claude-3-haiku-20240307': 'haiku3',
  };
  for (const [id, want] of Object.entries(tiers)) {
    check('tier ' + id + ' = ' + want, () => assert.strictEqual(tier(id), want));
  }
  check('opus 5.5 bills $4 in / $20 out / $0.20 cache read', () => {
    assert.ok(near(cost({ model: 'claude-opus-5-5', input: M }), 4));
    assert.ok(near(cost({ model: 'claude-opus-5-5', output: M }), 20));
    assert.ok(near(cost({ model: 'claude-opus-5-5', cacheRead: M }), 0.20));
  });
  check('fable 5.1 cache read is $0.25, fable 5 is $1.00', () => {
    assert.ok(near(cost({ model: 'claude-fable-5-1', cacheRead: M }), 0.25));
    assert.ok(near(cost({ model: 'claude-fable-5', cacheRead: M }), 1.0));
  });
  check('sonnet 5.5 cache read is $0.10, sonnet 5 is $0.20', () => {
    assert.ok(near(cost({ model: 'claude-sonnet-5-5', cacheRead: M }), 0.10));
    assert.ok(near(cost({ model: 'claude-sonnet-5', cacheRead: M }), 0.20));
  });
  check('haiku 5.5 steps up above a 100K prompt', () => {
    assert.strictEqual(tier('claude-haiku-5-5', { promptTokens: 99_000 }), 'haiku55');
    assert.strictEqual(tier('claude-haiku-5-5', { promptTokens: 101_000 }), 'haiku55Long');
    assert.ok(near(cost({ model: 'claude-haiku-5-5', input: 150_000 }), 0.075));
  });
  check('sonnet 4.6 has no long-context tier, sonnet 4.5 does', () => {
    assert.strictEqual(tier('claude-sonnet-4-6', { promptTokens: 300_000 }), 'sonnet');
    assert.strictEqual(tier('claude-sonnet-4-5', { promptTokens: 300_000 }), 'sonnetLong');
  });
  check('1-hour cache writes bill at 2x input', () => {
    assert.ok(near(cost({ model: 'claude-opus-5-5', cacheWrite: M }), 5));
    assert.ok(near(cost({ model: 'claude-opus-5-5', cacheWrite1h: M }), 8));
  });
  check('fast mode doubles opus 5.5 and prices opus 5 at $10/$50', () => {
    assert.ok(near(cost({ model: 'claude-opus-5-5', input: M, speed: 'fast' }), 8));
    assert.ok(near(cost({ model: 'claude-opus-5', output: M, speed: 'fast' }), 50));
    assert.ok(near(cost({ model: 'claude-opus-4-6', input: M, speed: 'fast' }), 5));
  });
  check('unknown model id bills as current sonnet', () => assert.strictEqual(tier('claude-next'), 'sonnet55'));

  // --- incremental parsing ------------------------------------------------
  // Pad with multi-byte chars so one straddles the 1 MiB chunk boundary.
  const pad = 'é'.repeat(400000);
  fs.writeFileSync(FILE, line('claude-opus-5', 100, pad) + line('claude-sonnet-5', 200));

  const first = await parseLocalLogs({});
  check('first pass counts both messages',
    () => assert.strictEqual(first.monthTokens, 2 * 17 + 300));

  fs.appendFileSync(FILE, line('claude-fable-5', 300));
  const incremental = await parseLocalLogs({});
  resetCache();
  const full = await parseLocalLogs({});
  check('incremental result == cold re-read',
    () => assert.deepStrictEqual(incremental, full));
  check('multi-byte chunk boundary does not drift offset',
    () => assert.strictEqual(incremental.monthTokens, 3 * 17 + 600));

  // Partial line must be ignored until its newline arrives.
  const before = await parseLocalLogs({});
  fs.appendFileSync(FILE, '{"type":"assistant","message":{"id":"mX"');
  const during = await parseLocalLogs({});
  check('partial trailing line ignored',
    () => assert.deepStrictEqual(during, before));

  fs.appendFileSync(FILE,
    ',"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,' +
    '"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},' +
    '"timestamp":"' + new Date().toISOString() + '"}\n');
  const after = await parseLocalLogs({});
  check('completed line is picked up',
    () => assert.strictEqual(after.monthTokens, before.monthTokens + 2));

  // Truncation / rotation must force a clean re-read, not a stale offset.
  fs.writeFileSync(FILE, line('claude-opus-5', 50));
  const rotated = await parseLocalLogs({});
  resetCache();
  const rotatedFull = await parseLocalLogs({});
  check('truncated file re-reads from zero',
    () => assert.deepStrictEqual(rotated, rotatedFull));

  // Synthetic responses are never billed and must not pollute the legend.
  fs.appendFileSync(FILE, line('<synthetic>', 999));
  const synth = await parseLocalLogs({});
  check('<synthetic> excluded from breakdown',
    () => assert.ok(!('<synthetic>' in synth.modelBreakdown)));

  // A line that reports its cache writes as 1-hour must bill them at the
  // 1-hour rate. 10 in, 5 cache read, 2 cache write (1h) on Opus 5.5:
  // 10*4 + 5*0.20 + 2*8 = 57 micro-dollars.
  fs.writeFileSync(FILE, line('claude-opus-5-5', 0, '', {
    cache_creation: { ephemeral_1h_input_tokens: 2, ephemeral_5m_input_tokens: 0 },
  }));
  resetCache();
  const oneHour = await parseLocalLogs({});
  check('1h cache writes priced from the TTL breakdown',
    () => assert.ok(near(oneHour.todayCost, 57 / 1_000_000), 'got ' + oneHour.todayCost));

  os.homedir = realHome;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + passed + ' checks passed');
})();
