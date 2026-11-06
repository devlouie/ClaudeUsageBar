// Local spend accounting, parsed from the JSONL transcripts that Claude Code,
// Antigravity, and Gemini CLI write.
//
// The corpus is large (gigabytes) but strictly APPEND-ONLY. Re-reading every
// file on every tick would burn nearly all of its work on bytes it already
// parsed. Instead we keep a per-file cursor and read only the new tail.
//
// Three facts drive the design below:
//
//   1. Per-file state must survive across ticks: the byte offset, the
//      day-bucketed subtotals, and the usage events.
//   2. Claude Code streams one message as many lines under one message id. The
//      early lines carry partial output_tokens. The final count only appears
//      on a later line, so a message's usage can GROW after we first see it.
//      Keeping the first line alone undercounts output by about 22%. Counting
//      every line overcounts by double. So we keep one event per message id and
//      raise it in place when a later line reports more.
//   3. Today, 7d, and 30d windows roll forward daily, so we can't keep a single
//      running total. We bucket each file's spend BY DAY, then re-aggregate the
//      buckets on each tick. Cheap, because there are only ~30 days of them.
//
// Reads are chunked rather than readFileSync'd whole: a single 69MB session
// file materialised as a string costs ~360MB RSS, versus ~73MB streamed.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { cost, displayName } = require('./pricing');

const READ_CHUNK = 1 << 20; // 1 MiB
const readBuf = Buffer.allocUnsafe(READ_CHUNK); // reads run one at a time
const SESSION_MS = 5 * 3600 * 1000;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

// cursors: filePath -> {
//   offset       bytes consumed so far (always lands on a line boundary)
//   inode        detects replace-in-place rotation
//   days         { 'YYYY-MM-DD': { tokens, cost, models, modelTokens } }
//   events       usage events, sorted by ts
//   activeModel  Antigravity only: the model the conversation last selected
// }
// seen: message id -> its event. Dedupe is global because a resumed session
// re-emits the same message in a different file.
function createTracker() {
  return { cursors: new Map(), seen: new Map() };
}

const claude = createTracker();
const gemini = createTracker();

// dirPath -> { mtimeMs, files: [absolute .jsonl paths], dirs: [absolute paths] }
// Listing a directory is far more expensive than stat'ing it. A directory's
// mtime changes when an entry is added or removed, so an unchanged mtime means
// the cached listing is still valid and readdir can be skipped entirely.
const dirCache = new Map();

function resetCache() {
  for (const tracker of [claude, gemini]) {
    tracker.cursors.clear();
    tracker.seen.clear();
  }
  dirCache.clear();
}

// ---------------------------------------------------------------------------
// Dates. Day keys and period starts are all local time.
// ---------------------------------------------------------------------------

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayKeyToMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Rolling windows that include today. "7d" is today and the 6 days before it.
function periodStarts(now) {
  const dayStart = (daysAgo) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  return { today: dayStart(0), week: dayStart(WEEK_DAYS - 1), month: dayStart(MONTH_DAYS - 1) };
}

// ---------------------------------------------------------------------------
// Chunked tail reader
// ---------------------------------------------------------------------------

// Read bytes [from, size) and hand back only COMPLETE lines. A trailing
// partial line (the writer mid-write) is left unconsumed so the next tick
// picks it up whole. Returns the new offset, which always sits just past a
// newline.
//
// `needles` are byte strings a useful line must contain. Most of the corpus is
// tool output with no usage in it. Testing the raw bytes first means those lines
// are never decoded into strings, which keeps the cold pass's memory peak down.
function readNewLines(file, from, size, needles, onLine) {
  if (from >= size) return from;

  const fd = fs.openSync(file, 'r');
  let pos = from;
  let carry = null;   // Bytes after the last newline in the previous chunk
  let consumed = from;

  try {
    while (pos < size) {
      const want = Math.min(READ_CHUNK, size - pos);
      const read = fs.readSync(fd, readBuf, 0, want, pos);
      if (read <= 0) break;
      pos += read;

      // Split on raw BYTES, not on a decoded string. A multi-byte UTF-8
      // character straddling a chunk boundary decodes to replacement chars on
      // both sides, which makes Buffer.byteLength(line) disagree with the
      // bytes actually consumed and drifts the offset. The drift then trips
      // the truncation check and re-reads the whole file every tick.
      const fresh = readBuf.subarray(0, read);
      const chunk = carry ? Buffer.concat([carry, fresh]) : fresh;
      carry = null;

      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
        const line = chunk.subarray(start, nl);
        if (needles.some((n) => line.includes(n))) onLine(line.toString('utf8'));
        consumed += nl - start + 1; // +1 for the newline itself
        start = nl + 1;
      }
      // Copy the tail, because the next read overwrites readBuf.
      if (start < chunk.length) carry = Buffer.from(chunk.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }

  return consumed;
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

function eventTokens(e) {
  return e.input + e.output + e.cacheRead + e.cacheWrite;
}

// cacheWrite is the total. cacheWrite1h is the part written to the 1-hour cache,
// which bills at a higher rate than the 5-minute cache.
function eventCost(e) {
  return cost({
    model: e.model,
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheWrite: e.cacheWrite - e.cacheWrite1h,
    cacheWrite1h: e.cacheWrite1h,
    speed: e.speed,
    at: e.ts,
  });
}

function addToBucket(cur, day, name, tokens, usd) {
  let bucket = cur.days[day];
  if (!bucket) bucket = cur.days[day] = { tokens: 0, cost: 0, models: {}, modelTokens: {} };
  bucket.tokens += tokens;
  bucket.cost += usd;
  bucket.models[name] = (bucket.models[name] || 0) + usd;
  bucket.modelTokens[name] = (bucket.modelTokens[name] || 0) + tokens;
}

function recordUsage(tracker, cur, file, rec, since) {
  if (!rec.ts) return;
  const date = new Date(rec.ts);
  const ts = date.getTime();
  if (Number.isNaN(ts) || ts < since) return;

  const known = rec.id ? tracker.seen.get(rec.id) : null;
  if (known) {
    growEvent(tracker, known, rec);
    return;
  }

  const evt = {
    id: rec.id || null,
    file,
    day: dayKey(date),
    name: displayName(rec.model),
    model: rec.model,
    speed: rec.speed,
    ts,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cacheWrite: rec.cacheWrite || 0,
    cacheWrite1h: rec.cacheWrite1h || 0,
    cost: 0,
  };
  const tokens = eventTokens(evt);
  if (tokens <= 0) return;
  evt.cost = eventCost(evt);

  if (evt.id) tracker.seen.set(evt.id, evt);
  addToBucket(cur, evt.day, evt.name, tokens, evt.cost);

  const last = cur.events[cur.events.length - 1];
  if (last && last.ts > ts) {
    // Rare out-of-order line: insert in place so lowerBound stays valid.
    cur.events.splice(lowerBound(cur.events, ts), 0, evt);
  } else {
    cur.events.push(evt);
  }
}

// A later line for a known message. Raise the event to the highest count seen
// and pass the difference on to the day bucket of the file that owns the event.
function growEvent(tracker, evt, rec) {
  const cacheWrite = rec.cacheWrite || 0;
  const cacheWrite1h = rec.cacheWrite1h || 0;
  if (rec.input <= evt.input && rec.output <= evt.output && rec.cacheRead <= evt.cacheRead
    && cacheWrite <= evt.cacheWrite && cacheWrite1h <= evt.cacheWrite1h) return;

  const oldTokens = eventTokens(evt);
  const oldCost = evt.cost;
  evt.input = Math.max(evt.input, rec.input);
  evt.output = Math.max(evt.output, rec.output);
  evt.cacheRead = Math.max(evt.cacheRead, rec.cacheRead);
  evt.cacheWrite = Math.max(evt.cacheWrite, cacheWrite);
  evt.cacheWrite1h = Math.max(evt.cacheWrite1h, cacheWrite1h);
  evt.cost = eventCost(evt);

  const owner = tracker.cursors.get(evt.file);
  if (owner) addToBucket(owner, evt.day, evt.name, eventTokens(evt) - oldTokens, evt.cost - oldCost);
}

function releaseCursor(tracker, cur) {
  for (const e of cur.events) {
    if (e.id) tracker.seen.delete(e.id);
  }
}

// Drop day buckets and events that have aged out of the window, so long-running
// sessions don't grow state without bound.
function pruneOld(tracker, cur, since) {
  for (const key of Object.keys(cur.days)) {
    if (dayKeyToMs(key) < since) delete cur.days[key];
  }
  if (cur.events.length && cur.events[0].ts < since) {
    const keepFrom = lowerBound(cur.events, since);
    for (let i = 0; i < keepFrom; i++) {
      if (cur.events[i].id) tracker.seen.delete(cur.events[i].id);
    }
    cur.events = cur.events.slice(keepFrom);
  }
}

// First index whose ts >= target. Assumes events are sorted ascending.
function lowerBound(events, target) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Sync + aggregate, shared by both providers
// ---------------------------------------------------------------------------

function syncFiles(tracker, files, since, ingest) {
  const live = new Set();

  for (const entry of files) {
    const { file, size, ino } = entry;
    live.add(file);
    let cur = tracker.cursors.get(file);

    // A shrunk file or a changed inode means truncation/rotation, not an
    // append. The cursor is meaningless, so re-read from the top.
    if (cur && (size < cur.offset || (ino && cur.inode && ino !== cur.inode))) {
      releaseCursor(tracker, cur);
      cur = undefined;
    }
    if (!cur) {
      cur = { offset: 0, inode: ino, days: {}, events: [], activeModel: null };
      tracker.cursors.set(file, cur);
    }

    if (size > cur.offset) {
      try { cur.offset = ingest(entry, cur); }
      catch { /* unreadable this tick; retry next */ }
    }

    pruneOld(tracker, cur, since);
  }

  // Forget files that no longer qualify (aged out or deleted), releasing their
  // dedupe ids.
  for (const [file, cur] of tracker.cursors) {
    if (live.has(file)) continue;
    releaseCursor(tracker, cur);
    tracker.cursors.delete(file);
  }
}

function emptySummary() {
  return {
    todayTokens: 0, todayCost: 0,
    weekTokens: 0, weekCost: 0,
    monthTokens: 0, monthCost: 0,
    modelBreakdown: {},
    todayModelBreakdown: {},
    weekModelBreakdown: {},
    todayModelTokens: {},
    weekModelTokens: {},
    monthModelTokens: {},
    daily: {},
    sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function addEntries(target, source) {
  for (const [name, v] of Object.entries(source)) target[name] = (target[name] || 0) + v;
}

function accumulateDayBucket(summary, key, bucket, periods) {
  const dayMs = dayKeyToMs(key);
  if (dayMs < periods.month) return;

  summary.monthTokens += bucket.tokens;
  summary.monthCost += bucket.cost;
  addEntries(summary.modelBreakdown, bucket.models);
  addEntries(summary.monthModelTokens, bucket.modelTokens);

  let dayEntry = summary.daily[key];
  if (!dayEntry) dayEntry = summary.daily[key] = { tokens: 0, cost: 0, models: {}, modelTokens: {} };
  dayEntry.tokens += bucket.tokens;
  dayEntry.cost += bucket.cost;
  addEntries(dayEntry.models, bucket.models);
  addEntries(dayEntry.modelTokens, bucket.modelTokens);

  if (dayMs >= periods.week) {
    summary.weekTokens += bucket.tokens;
    summary.weekCost += bucket.cost;
    addEntries(summary.weekModelBreakdown, bucket.models);
    addEntries(summary.weekModelTokens, bucket.modelTokens);
  }

  if (dayMs >= periods.today) {
    summary.todayTokens += bucket.tokens;
    summary.todayCost += bucket.cost;
    addEntries(summary.todayModelBreakdown, bucket.models);
    addEntries(summary.todayModelTokens, bucket.modelTokens);
  }
}

function summarize(tracker, periods, sessionWindowStart) {
  const summary = emptySummary();
  const su = summary.sessionUsage;
  for (const cur of tracker.cursors.values()) {
    for (const [key, bucket] of Object.entries(cur.days)) {
      accumulateDayBucket(summary, key, bucket, periods);
    }
    if (sessionWindowStart == null) continue;
    // Events are sorted, so the window is a suffix of the array. Binary-search
    // the first in-window index rather than scanning every event on every tick.
    for (let i = lowerBound(cur.events, sessionWindowStart); i < cur.events.length; i++) {
      const e = cur.events[i];
      su.input += e.input;
      su.output += e.output;
      su.cacheRead += e.cacheRead;
      su.cacheWrite += e.cacheWrite;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_NEEDLES = [Buffer.from('"input_tokens"')];

function ingestClaudeLine(cur, file, line, since) {
  let obj;
  try { obj = JSON.parse(line); }
  catch { return; }

  if (obj.type !== 'assistant') return;
  const message = obj.message;
  const usage = message && message.usage;
  if (!usage) return;

  // Synthetic responses are locally generated and never billed. Keeping them
  // only adds a permanent $0 row to the model legend.
  const model = message.model || 'unknown';
  if (model === '<synthetic>') return;

  // Newer Claude Code builds split cache writes by TTL. Older lines carry only
  // the total, which we treat as 5-minute writes.
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cc = usage.cache_creation;

  recordUsage(claude, cur, file, {
    id: message.id,
    ts: obj.timestamp,
    model,
    speed: usage.speed,
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, (cc && cc.ephemeral_1h_input_tokens) || 0),
  }, since);
}

async function parseLocalLogs({ sessionResetAt = null } = {}) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!safeIsDir(projectsDir)) return emptySummary();

  const periods = periodStarts(new Date());
  syncFiles(claude, collectJsonl(projectsDir, periods.month), periods.month, ({ file, size }, cur) =>
    readNewLines(file, cur.offset, size, CLAUDE_NEEDLES, (line) => ingestClaudeLine(cur, file, line, periods.month)));

  const sessionStart = sessionResetAt ? sessionResetAt.getTime() - SESSION_MS : null;
  return summarize(claude, periods, sessionStart);
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listJsonlFiles(root) {
  const out = [];
  const stack = [root];
  const live = new Set();

  while (stack.length) {
    const dir = stack.pop();
    live.add(dir);

    let dirStat;
    try { dirStat = fs.statSync(dir); }
    catch { continue; }

    const cached = dirCache.get(dir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) {
      for (const f of cached.files) out.push(f);
      for (const d of cached.dirs) stack.push(d);
      continue;
    }

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
    dirCache.set(dir, { mtimeMs: dirStat.mtimeMs, files, dirs });
    for (const f of files) out.push(f);
    for (const d of dirs) stack.push(d);
  }

  for (const dir of dirCache.keys()) {
    if (!live.has(dir)) dirCache.delete(dir);
  }
  return out;
}

function statIfRecent(file, sinceMs) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.mtimeMs >= sinceMs ? st : null;
  } catch {
    return null;
  }
}

function collectJsonl(root, sinceMs) {
  const out = [];
  for (const file of listJsonlFiles(root)) {
    const st = statIfRecent(file, sinceMs);
    if (st) out.push({ file, size: st.size, ino: st.ino });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini: Antigravity brain transcripts + Gemini CLI chats
// ---------------------------------------------------------------------------

// The desktop app and the CLI each keep their own brain directory, with the
// same transcript format. Each conversation also holds transcript_full.jsonl
// and chunks/, which repeat the same steps, so only transcript.jsonl is read.
const ANTIGRAVITY_ROOTS = ['antigravity', 'antigravity-cli'];
const DEFAULT_GEMINI_MODEL = 'gemini-4-argon';
const GEMINI_NEEDLES = ['Model Selection', '"input_tokens"', '"tokens"'].map((n) => Buffer.from(n));

// Runs to the period that ends the sentence, so a version like "3.8" survives:
// "...to Gemini 3.8 Flash (Low). No need to comment..." gives "Gemini 3.8 Flash (Low)".
const MODEL_SELECTION = /changed setting `Model Selection` from .+? to (.+?)(?:\.(?:\s|$)|\n|$)/;

function defaultAntigravityModel(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'antigravity_state.pbtxt'), 'utf8');
    const m = raw.match(/last_selected_agent_model:\s*(\S+)/);
    if (m && !/^MODEL_PLACEHOLDER/i.test(m[1])) return m[1].toLowerCase();
  } catch {}
  return DEFAULT_GEMINI_MODEL;
}

function recordGeminiCliMessage(cur, file, msg, fallbackTs, since) {
  if (msg.type !== 'gemini' || !msg.tokens || typeof msg.tokens !== 'object') return;
  const cacheRead = Number(msg.tokens.cached) || 0;
  recordUsage(gemini, cur, file, {
    id: msg.id ? `gcli:${msg.id}` : `gcli:${file}:${msg.timestamp}`,
    ts: msg.timestamp || fallbackTs,
    model: msg.model || 'gemini-2.5-pro',
    input: Math.max(0, (Number(msg.tokens.input) || 0) - cacheRead),
    output: (Number(msg.tokens.output) || 0) + (Number(msg.tokens.thoughts) || 0),
    cacheRead,
  }, since);
}

function ingestGeminiLine(cur, file, line, since, defaultModel) {
  let obj;
  try { obj = JSON.parse(line); }
  catch { return; }

  if (obj.type === 'USER_INPUT') {
    const m = typeof obj.content === 'string' && obj.content.match(MODEL_SELECTION);
    if (m) cur.activeModel = m[1].trim();
  } else if (obj.type === 'PLANNER_RESPONSE') {
    recordUsage(gemini, cur, file, {
      id: `agy:${file}:${obj.step_index ?? obj.created_at}`,
      ts: obj.created_at || obj.timestamp,
      model: obj.model || cur.activeModel || defaultModel,
      input: Number(obj.input_tokens) || 0,
      output: Number(obj.output_tokens) || 0,
      cacheRead: Number(obj.cache_read_tokens) || 0,
    }, since);
  } else {
    recordGeminiCliMessage(cur, file, obj, obj.created_at, since);
  }
}

function ingestGeminiJsonFile(cur, file, since) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const msg of Array.isArray(data?.messages) ? data.messages : []) {
    if (msg) recordGeminiCliMessage(cur, file, msg, data.lastUpdated || data.startTime, since);
  }
}

function collectGeminiLogFiles(sinceMs) {
  const out = [];
  const base = path.join(os.homedir(), '.gemini');
  const add = (file, format, defaultModel) => {
    const st = statIfRecent(file, sinceMs);
    if (st) out.push({ file, size: st.size, ino: st.ino, format, defaultModel });
  };

  for (const name of ANTIGRAVITY_ROOTS) {
    const root = path.join(base, name);
    const brain = path.join(root, 'brain');
    const defaultModel = defaultAntigravityModel(root);
    for (const conv of listDirs(brain)) {
      add(path.join(brain, conv, '.system_generated', 'logs', 'transcript.jsonl'), 'jsonl', defaultModel);
    }
  }

  const tmp = path.join(base, 'tmp');
  for (const project of listDirs(tmp)) {
    const stack = [path.join(tmp, project, 'chats')];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith('.jsonl')) add(full, 'jsonl', DEFAULT_GEMINI_MODEL);
        else if (e.name.endsWith('.json')) add(full, 'json', DEFAULT_GEMINI_MODEL);
      }
    }
  }

  return out;
}

async function parseGeminiLocalLogs({ sessionResetAt = null } = {}) {
  const now = new Date();
  const periods = periodStarts(now);

  syncFiles(gemini, collectGeminiLogFiles(periods.month), periods.month, ({ file, size, format, defaultModel }, cur) => {
    if (format === 'json') {
      ingestGeminiJsonFile(cur, file, periods.month);
      return size;
    }
    return readNewLines(file, cur.offset, size, GEMINI_NEEDLES, (line) => ingestGeminiLine(cur, file, line, periods.month, defaultModel));
  });

  // Without a reported reset time, use the last 5 hours.
  const sessionStart = (sessionResetAt ? sessionResetAt.getTime() : now.getTime()) - SESSION_MS;
  return summarize(gemini, periods, sessionStart);
}

async function parseAllLogs({ sessionResetAt = null, geminiSessionResetAt = null } = {}) {
  return {
    claude: await parseLocalLogs({ sessionResetAt }),
    gemini: await parseGeminiLocalLogs({ sessionResetAt: geminiSessionResetAt }),
  };
}

module.exports = { parseAllLogs, parseLocalLogs, parseGeminiLocalLogs, resetCache };
