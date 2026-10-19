// Per-million-token rates in USD for the Claude API.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
//
// Rules the table encodes:
//   * Cache hits cost 0.1x base input, except 0.025x on Fable 5.1 and
//     Mythos 5.1, and 0.05x on Opus 5.5 and Sonnet 5.5.
//   * Cache writes cost 1.25x base input for the 5-minute cache and 2x for
//     the 1-hour cache.
//   * Claude 4.6 and later include the full 1M context at standard pricing.
//     Sonnet 4.5 and earlier doubled input rates above 200K prompt tokens.
//   * Haiku 5.5 is priced by prompt length. A prompt over 100K tokens pays
//     the higher tier for the whole request.
//   * Fast mode costs $8/$40 on Opus 5.5 and $10/$50 on Opus 5 and 4.8.
//     Cache rates scale by the same 2x multiplier.
//
// Prices go stale. Bump LAST_VERIFIED whenever you re-check the page above.
// Override at runtime by pointing CLAUDE_USAGE_PRICING_JSON at a JSON file
// shaped like DEFAULT_RATES below. Matching keys overwrite, others stay.
const LAST_VERIFIED = '2026-10-20';

function r(input, output, cacheRead, cacheWrite, cacheWrite1h) {
  return { input, output, cacheRead, cacheWrite, cacheWrite1h };
}

const DEFAULT_RATES = {
  //              input  output cacheRead cacheWrite(5m) cacheWrite(1h)
  fable51:     r(10,    50,    0.25,  12.5,   20),    // Fable 5.1, Mythos 5.1
  fable5:      r(10,    50,    1.0,   12.5,   20),    // Fable 5, Mythos 5, Mythos Preview
  opus55:      r(4,     20,    0.20,  5,      8),     // Opus 5.5
  opus55Fast:  r(8,     40,    0.40,  10,     16),    // Opus 5.5 fast mode
  opus45:      r(5,     25,    0.50,  6.25,   10),    // Opus 4.5 through Opus 5
  opus45Fast:  r(10,    50,    1.0,   12.5,   20),    // Opus 5 and Opus 4.8 fast mode
  opusLegacy:  r(15,    75,    1.50,  18.75,  30),    // Opus 4.1, Opus 4, Opus 3
  sonnet55:    r(2,     10,    0.10,  2.5,    4),     // Sonnet 5.5
  sonnet5:     r(2,     10,    0.20,  2.5,    4),     // Sonnet 5
  sonnet:      r(3,     15,    0.30,  3.75,   6),     // Sonnet 4.6 and earlier
  sonnetLong:  r(6,     22.5,  0.60,  7.5,    12),    // Sonnet 4.5 and earlier, prompt above 200K
  haiku55:     r(0.10,  0.50,  0.01,  0.125,  0.20),  // Haiku 5.5, prompt up to 100K
  haiku55Long: r(0.50,  2.50,  0.05,  0.625,  1.0),   // Haiku 5.5, prompt above 100K
  haiku45:     r(1,     5,     0.10,  1.25,   2),     // Haiku 4.5
  haiku35:     r(0.80,  4,     0.08,  1.0,    1.60),  // Haiku 3.5
  haiku3:      r(0.25,  1.25,  0.03,  0.30,   0.50),  // Haiku 3
};

const SONNET_LONG_THRESHOLD = 200_000;
const HAIKU_LONG_THRESHOLD = 100_000;

const RATES = loadRates();

function loadRates() {
  const overridePath = process.env.CLAUDE_USAGE_PRICING_JSON;
  if (!overridePath) return { ...DEFAULT_RATES };
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    return { ...DEFAULT_RATES, ...data };
  } catch (e) {
    console.warn('[pricing] failed to load CLAUDE_USAGE_PRICING_JSON:', e.message);
    return { ...DEFAULT_RATES };
  }
}

// Model ids can carry a bracketed variant suffix (for example
// "claude-opus-5-5[1m]"). Strip it so variants price and name like their
// base model.
function normalize(model) {
  return (model || '').toLowerCase().replace(/\[[^\]]*\]/g, '');
}

function family(model) {
  const m = normalize(model);
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// "5.5", "5", "4.5", "3" or null. Date suffixes are not versions.
function version(model) {
  const m = normalize(model);
  const single = m.match(/(fable|mythos)-(\d+)(?:-(\d+))?/);
  if (single) {
    return single[3] && single[3].length < 4 ? `${single[2]}.${single[3]}` : single[2];
  }
  // Older "claude-3-5-sonnet" style puts the version before the family name.
  // Check it first so the modern regex below cannot match a date suffix.
  const legacy = m.match(/claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/);
  if (legacy) return legacy[2] ? `${legacy[1]}.${legacy[2]}` : `${legacy[1]}`;
  const v = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (v && v[3] && v[3].length < 4) return `${v[2]}.${v[3]}`;
  if (v) return v[2];
  return null;
}

function versionNumber(model) {
  const v = version(model);
  return v == null ? null : parseFloat(v);
}

// Which rate row a request bills against. A bare family name with no
// version ("opus") bills as the current model in that family.
function tier(model, { promptTokens = 0, speed } = {}) {
  const f = family(model);
  const v = versionNumber(model);
  const fast = speed === 'fast';
  if (f === 'fable') return v != null && v >= 5.1 ? 'fable51' : 'fable5';
  if (f === 'opus') {
    if (v == null || v >= 5.5) return fast ? 'opus55Fast' : 'opus55';
    if (v >= 4.5) return fast && v >= 4.8 ? 'opus45Fast' : 'opus45';
    return 'opusLegacy';
  }
  if (f === 'haiku') {
    if (v == null || v >= 5.5) return promptTokens > HAIKU_LONG_THRESHOLD ? 'haiku55Long' : 'haiku55';
    if (v >= 4.5) return 'haiku45';
    if (v >= 3.5) return 'haiku35';
    return 'haiku3';
  }
  if (v == null || v >= 5.5) return 'sonnet55';
  if (v >= 5) return 'sonnet5';
  if (v < 4.6 && promptTokens > SONNET_LONG_THRESHOLD) return 'sonnetLong';
  return 'sonnet';
}

function rates(model, opts) {
  const t = tier(model, opts);
  const base = RATES[t] || DEFAULT_RATES[t] || DEFAULT_RATES.sonnet55;
  if (base.cacheWrite1h == null) return { ...base, cacheWrite1h: base.input * 2 };
  return base;
}

// cacheWrite is the 5-minute cache. cacheWrite1h is the 1-hour cache.
// Prompt length for tiered models counts every input token in the request,
// including cache reads and writes.
function cost({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, speed } = {}) {
  const promptTokens = input + cacheRead + cacheWrite + cacheWrite1h;
  const rt = rates(model, { promptTokens, speed });
  return (
    input * rt.input +
    output * rt.output +
    cacheRead * rt.cacheRead +
    cacheWrite * rt.cacheWrite +
    cacheWrite1h * rt.cacheWrite1h
  ) / 1_000_000;
}

function displayName(model) {
  const f = family(model);
  const m = normalize(model);
  const base = f === 'fable' ? (m.includes('mythos') ? 'Mythos' : 'Fable')
    : f === 'opus' ? 'Opus'
    : f === 'haiku' ? 'Haiku'
    : 'Sonnet';
  const v = version(model);
  return v ? `${base} ${v}` : (model || base);
}

module.exports = { cost, rates, tier, family, version, displayName, LAST_VERIFIED, DEFAULT_RATES };
