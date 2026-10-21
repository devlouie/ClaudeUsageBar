// Local spend accounting, parsed from Claude Code's own JSONL transcripts.
//
// The corpus is large (hundreds of MB) but strictly APPEND-ONLY: Claude Code
// only ever adds lines to the end of a session file. Re-reading every file on
// every tick therefore burns ~96% of its work re-parsing bytes it already
// parsed. Instead we keep a per-file cursor and read only the new tail.
//
// Two consequences drive the design below:
//
//   1. Per-file state must survive across ticks. The byte offset, the
//      day-bucketed subtotals, and the set of seen message ids (Claude Code
//      re-emits the same assistant message under multiple parent chains, so
//      ~44% of usage lines are duplicates and dropping dedupe inflates totals).
//   2. Day/week/month windows roll over, so we can't keep a single running
//      total. We bucket each file's spend BY DAY, then re-aggregate the
//      buckets on each tick. Cheap, because there are only ~30 days of them.
//
// Reads are chunked rather than readFileSync'd whole: a single 69MB session
// file materialised as a string costs ~360MB RSS, versus ~73MB streamed.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { cost, displayName } = require('./pricing');

const READ_CHUNK = 1 << 20; // 1 MiB

// ---------------------------------------------------------------------------
// Persistent cursor state
// ---------------------------------------------------------------------------

// filePath -> {
//   offset      bytes consumed so far (always lands on a line boundary)
//   inode       detects replace-in-place rotation
//   days        { 'YYYY-MM-DD': { tokens, cost, models: {name: cost} } }
//   events      [{ ts, input, output, cacheRead, cacheWrite }] for window sums
//   seen        Set of message.id seen in THIS file
// }
const cursors = new Map();

// message.id -> filePath. Dedupe is global (the same message is re-emitted
// across different session files), so this must live outside the per-file map.
const seenGlobal = new Map();

// Separate cursor and dedupe maps for Gemini local logs (~/.gemini/antigravity
// and ~/.gemini/tmp) so Claude and Gemini caches never collide.
const geminiCursors = new Map();
const geminiSeenGlobal = new Map();
const geminiDirCache = new Map();

function resetCache() {
  cursors.clear();
  seenGlobal.clear();
  dirCache.clear();
  geminiCursors.clear();
  geminiSeenGlobal.clear();
  geminiDirCache.clear();
}

function dayKey(d) {
  // Local-time day key, matching the local-time day/week/month boundaries used
  // by the aggregation below.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    sessionUsage: zeroBucket(),
    weeklyUsage: zeroBucket(),
  };
}

function accumulateDayBucket(summary, key, bucket, { todayKey, todayStart, weekStart, monthStartMs }) {
  const dayMs = dayKeyToMs(key);
  if (dayMs < monthStartMs) return;

  summary.monthTokens += bucket.tokens;
  summary.monthCost += bucket.cost;

  let dayEntry = summary.daily[key];
  if (!dayEntry) {
    dayEntry = summary.daily[key] = { tokens: 0, cost: 0, models: {}, modelTokens: {} };
  }
  dayEntry.tokens += bucket.tokens;
  dayEntry.cost += bucket.cost;

  for (const [name, c] of Object.entries(bucket.models)) {
    summary.modelBreakdown[name] = (summary.modelBreakdown[name] || 0) + c;
    dayEntry.models[name] = (dayEntry.models[name] || 0) + c;
  }
  if (bucket.modelTokens) {
    for (const [name, t] of Object.entries(bucket.modelTokens)) {
      summary.monthModelTokens[name] = (summary.monthModelTokens[name] || 0) + t;
      dayEntry.modelTokens[name] = (dayEntry.modelTokens[name] || 0) + t;
    }
  }

  if (dayMs >= weekStart) {
    summary.weekTokens += bucket.tokens;
    summary.weekCost += bucket.cost;
    for (const [name, c] of Object.entries(bucket.models)) {
      summary.weekModelBreakdown[name] = (summary.weekModelBreakdown[name] || 0) + c;
    }
    if (bucket.modelTokens) {
      for (const [name, t] of Object.entries(bucket.modelTokens)) {
        summary.weekModelTokens[name] = (summary.weekModelTokens[name] || 0) + t;
      }
    }
  }

  if (key === todayKey || dayMs >= todayStart) {
    summary.todayTokens += bucket.tokens;
    summary.todayCost += bucket.cost;
    for (const [name, c] of Object.entries(bucket.models)) {
      summary.todayModelBreakdown[name] = (summary.todayModelBreakdown[name] || 0) + c;
    }
    if (bucket.modelTokens) {
      for (const [name, t] of Object.entries(bucket.modelTokens)) {
        summary.todayModelTokens[name] = (summary.todayModelTokens[name] || 0) + t;
      }
    }
  }
}

function zeroBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function bucketTotal(b) {
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d) {
  // ISO week starting Monday
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// ---------------------------------------------------------------------------
// Chunked tail reader
// ---------------------------------------------------------------------------

// Read bytes [from, size) and hand back only COMPLETE lines. A trailing
// partial line (Claude Code mid-write) is left unconsumed so the next tick
// picks it up whole. Returns the new offset, which always sits just past a
// newline.
function readNewLines(file, from, size, onLine) {
  if (from >= size) return from;

  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(READ_CHUNK);
  let pos = from;
  let carry = null;   // Buffer of bytes after the last newline in the chunk
  let consumed = from;

  try {
    while (pos < size) {
      const want = Math.min(READ_CHUNK, size - pos);
      const read = fs.readSync(fd, buf, 0, want, pos);
      if (read <= 0) break;
      pos += read;

      // Split on raw BYTES, not on a decoded string. A multi-byte UTF-8
      // character straddling a chunk boundary decodes to replacement chars on
      // both sides, which makes Buffer.byteLength(line) disagree with the
      // bytes actually consumed and drifts the offset. The drift then trips
      // the truncation check and re-reads the whole file every tick.
      let chunk = carry
        ? Buffer.concat([carry, buf.subarray(0, read)])
        : Buffer.from(buf.subarray(0, read));
      carry = null;

      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
        onLine(chunk.toString('utf8', start, nl));
        consumed += nl - start + 1; // +1 for the newline itself
        start = nl + 1;
      }
      if (start < chunk.length) carry = chunk.subarray(start);
    }
  } finally {
    fs.closeSync(fd);
  }

  return consumed;
}

// ---------------------------------------------------------------------------
// Line -> accounting
// ---------------------------------------------------------------------------

function ingestLine(line, cur, file, monthStartMs) {
  // Cheap reject before the expensive JSON.parse. Most lines are user turns,
  // tool results, or metadata with no usage block at all.
  if (!line || line.indexOf('"input_tokens"') === -1) return;

  let obj;
  try { obj = JSON.parse(line); }
  catch { return; }

  if (obj.type !== 'assistant') return;
  const message = obj.message;
  if (!message) return;
  const usage = message.usage;
  if (!usage) return;

  const id = message.id;
  if (id) {
    const owner = seenGlobal.get(id);
    if (owner !== undefined && owner !== file) return; // counted by another file
    if (cur.seen.has(id)) return;                      // counted by this file
    cur.seen.add(id);
    seenGlobal.set(id, file);
  }

  const tsRaw = obj.timestamp;
  if (!tsRaw) return;
  const ts = new Date(tsRaw);
  const tsMs = ts.getTime();
  if (Number.isNaN(tsMs) || tsMs < monthStartMs) return;

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  // Newer Claude Code builds split cache writes by TTL. The 1-hour cache
  // costs 2x input and the 5-minute cache 1.25x, so price them apart when
  // the breakdown is present. Older lines carry only the total. Treat that
  // as 5-minute writes.
  const cc = usage.cache_creation;
  const cacheWrite1h = Math.min(cacheWrite, (cc && cc.ephemeral_1h_input_tokens) || 0);
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const model = message.model || 'unknown';
  // Synthetic responses are locally generated and never billed; keeping them
  // only adds a permanent $0 row to the model legend.
  if (model === '<synthetic>') return;

  const lineCost = cost({
    model, input, output, cacheRead,
    cacheWrite: cacheWrite5m, cacheWrite1h, speed: usage.speed,
  });
  const tokens = input + output + cacheRead + cacheWrite;
  const dn = displayName(model);

  const key = dayKey(ts);
  let bucket = cur.days[key];
  if (!bucket) bucket = cur.days[key] = { tokens: 0, cost: 0, models: {}, modelTokens: {} };
  bucket.tokens += tokens;
  bucket.cost += lineCost;
  bucket.models[dn] = (bucket.models[dn] || 0) + lineCost;
  bucket.modelTokens[dn] = (bucket.modelTokens[dn] || 0) + tokens;

  // Session/weekly windows are anchored to API-supplied reset times that move
  // independently of calendar days, so keep the raw events to sum over.
  const evt = { ts: tsMs, input, output, cacheRead, cacheWrite };
  const last = cur.events[cur.events.length - 1];
  if (last && last.ts > tsMs) {
    // Rare out-of-order line: insert in place so lowerBound stays valid.
    cur.events.splice(lowerBound(cur.events, tsMs), 0, evt);
  } else {
    cur.events.push(evt);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function parseLocalLogs({ sessionResetAt = null, weeklyResetAt = null } = {}) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const summary = emptySummary();
  if (!safeIsDir(projectsDir)) return summary;

  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now);
  const monthStartMs = monthStart.getTime();

  const sessionWindowStart = sessionResetAt
    ? sessionResetAt.getTime() - 5 * 3600 * 1000
    : null;
  const weeklyWindowStart = weeklyResetAt
    ? weeklyResetAt.getTime() - 7 * 24 * 3600 * 1000
    : null;

  const files = collectJsonl(projectsDir, monthStart);
  const live = new Set();

  for (const { file, size, ino } of files) {
    live.add(file);
    let cur = cursors.get(file);

    // A shrunk file or a changed inode means truncation/rotation, not an
    // append. The cursor is meaningless, so re-read from the top.
    if (cur && (size < cur.offset || (ino && cur.inode && ino !== cur.inode))) {
      for (const id of cur.seen) seenGlobal.delete(id);
      cur = undefined;
    }
    if (!cur) {
      cur = { offset: 0, inode: ino, days: {}, events: [], seen: new Set() };
      cursors.set(file, cur);
    }

    if (size > cur.offset) {
      try {
        cur.offset = readNewLines(file, cur.offset, size, (line) => {
          ingestLine(line, cur, file, monthStartMs);
        });
      } catch { /* unreadable this tick; retry next */ }
    }

    // Drop day buckets and events that have aged out of the month window, so
    // long-running sessions don't grow state without bound.
    pruneOld(cur, monthStartMs);
  }

  // Forget files that no longer qualify (aged out of the month window or were
  // deleted), releasing their dedupe ids.
  for (const [file, cur] of cursors) {
    if (live.has(file)) continue;
    for (const id of cur.seen) seenGlobal.delete(id);
    cursors.delete(file);
  }

  // ---- Re-aggregate from the cached per-file buckets ----
  const todayKey = dayKey(now);
  const bounds = { todayKey, todayStart, weekStart, monthStartMs };
  for (const cur of cursors.values()) {
    for (const [key, bucket] of Object.entries(cur.days)) {
      accumulateDayBucket(summary, key, bucket, bounds);
    }

    if (sessionWindowStart == null && weeklyWindowStart == null) continue;
    // Events are appended in timestamp order, so the array is sorted and the
    // window is a suffix of it. Binary-search the first in-window index rather
    // than scanning every event on every tick.
    if (sessionWindowStart != null) {
      for (let i = lowerBound(cur.events, sessionWindowStart); i < cur.events.length; i++) {
        const e = cur.events[i];
        addBucket(summary.sessionUsage, e.input, e.output, e.cacheRead, e.cacheWrite);
      }
    }
    if (weeklyWindowStart != null) {
      for (let i = lowerBound(cur.events, weeklyWindowStart); i < cur.events.length; i++) {
        const e = cur.events[i];
        addBucket(summary.weeklyUsage, e.input, e.output, e.cacheRead, e.cacheWrite);
      }
    }
  }

  return summary;
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

function dayKeyToMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function pruneOld(cur, monthStartMs) {
  for (const key of Object.keys(cur.days)) {
    if (dayKeyToMs(key) < monthStartMs) delete cur.days[key];
  }
  if (cur.events.length && cur.events[0].ts < monthStartMs) {
    cur.events = cur.events.filter((e) => e.ts >= monthStartMs);
  }
}

function addBucket(b, input, output, cacheRead, cacheWrite) {
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheWrite += cacheWrite;
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

// dirPath -> { mtimeMs, files: [absolute .jsonl paths] }
// Listing a directory is far more expensive than stat'ing it. A directory's
// mtime changes when an entry is added or removed, so an unchanged mtime means
// the cached listing is still valid and readdir can be skipped entirely.
const dirCache = new Map();

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

function collectJsonl(root, sinceDate) {
  const out = [];
  const sinceMs = sinceDate.getTime();
  for (const full of listJsonlFiles(root)) {
    // A file already being tracked can skip the mtime gate: its cursor proves
    // it qualified, and re-checking only risks dropping it mid-month.
    const known = cursors.get(full);
    try {
      const st = fs.statSync(full);
      if (known || st.mtimeMs >= sinceMs) {
        out.push({ file: full, size: st.size, ino: st.ino });
      }
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini Local Log Accounting (Antigravity brain transcripts + Gemini CLI chats)
// ---------------------------------------------------------------------------

function readDefaultAntigravityModel() {
  try {
    const pbtxt = path.join(os.homedir(), '.gemini', 'antigravity', 'antigravity_state.pbtxt');
    if (fs.existsSync(pbtxt)) {
      const raw = fs.readFileSync(pbtxt, 'utf8');
      const m = raw.match(/last_selected_agent_model:\s*([^\s\n]+)/);
      if (m && m[1]) {
        if (m[1] === 'MODEL_PLACEHOLDER_M417') return 'gemini-4-argon';
        return m[1].toLowerCase();
      }
    }
  } catch {}
  return 'gemini-4-argon';
}

function recordGeminiUsageEvent(cur, file, { id, tsRaw, model, input, output, cacheRead, cacheWrite = 0 }, monthStartMs) {
  if (id) {
    const owner = geminiSeenGlobal.get(id);
    if (owner !== undefined && owner !== file) return;
    if (cur.seen.has(id)) return;
    cur.seen.add(id);
    geminiSeenGlobal.set(id, file);
  }

  if (!tsRaw) return;
  const ts = new Date(tsRaw);
  const tsMs = ts.getTime();
  if (Number.isNaN(tsMs) || tsMs < monthStartMs) return;

  const lineCost = cost({ model, input, output, cacheRead, cacheWrite });
  const tokens = input + output + cacheRead + cacheWrite;
  if (tokens <= 0) return;
  const dn = displayName(model);

  const key = dayKey(ts);
  let bucket = cur.days[key];
  if (!bucket) bucket = cur.days[key] = { tokens: 0, cost: 0, models: {}, modelTokens: {} };
  bucket.tokens += tokens;
  bucket.cost += lineCost;
  bucket.models[dn] = (bucket.models[dn] || 0) + lineCost;
  bucket.modelTokens[dn] = (bucket.modelTokens[dn] || 0) + tokens;

  const evt = { ts: tsMs, input, output, cacheRead, cacheWrite };
  const last = cur.events[cur.events.length - 1];
  if (last && last.ts > tsMs) {
    cur.events.splice(lowerBound(cur.events, tsMs), 0, evt);
  } else {
    cur.events.push(evt);
  }
}

function ingestGeminiLine(line, cur, file, monthStartMs, defaultModel) {
  if (!line) return;

  // 1. Track Antigravity model selection changes inside USER_INPUT steps
  if (line.indexOf('Model Selection') !== -1 && line.indexOf('"USER_INPUT"') !== -1) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const m = obj.content.match(/changed setting `Model Selection` from [^\n]+? to ([^.\n]+)/);
        if (m && m[1]) cur.activeModel = m[1].trim();
      }
    } catch {}
    return;
  }

  // 2. Antigravity PLANNER_RESPONSE steps carry input_tokens, cache_read_tokens, output_tokens
  if (line.indexOf('"PLANNER_RESPONSE"') !== -1 && line.indexOf('"input_tokens"') !== -1) {
    let obj;
    try { obj = JSON.parse(line); }
    catch { return; }
    if (obj.type !== 'PLANNER_RESPONSE') return;

    const input = Number(obj.input_tokens) || 0;
    const cacheRead = Number(obj.cache_read_tokens) || 0;
    const output = Number(obj.output_tokens) || 0;
    const model = obj.model || cur.activeModel || defaultModel;
    const id = `agy:${file}:${obj.step_index ?? obj.created_at}`;

    recordGeminiUsageEvent(cur, file, {
      id,
      tsRaw: obj.created_at || obj.timestamp,
      model,
      input,
      output,
      cacheRead,
    }, monthStartMs);
    return;
  }

  // 3. Gemini CLI .jsonl chat lines carry { type: "gemini", model, tokens: { input, output, cached, thoughts } }
  if (line.indexOf('"gemini"') !== -1 && line.indexOf('"tokens"') !== -1) {
    let obj;
    try { obj = JSON.parse(line); }
    catch { return; }
    if (obj.type !== 'gemini' || !obj.tokens || typeof obj.tokens !== 'object') return;

    const cacheRead = Number(obj.tokens.cached) || 0;
    const rawInput = Number(obj.tokens.input) || 0;
    const input = Math.max(0, rawInput - cacheRead);
    const output = (Number(obj.tokens.output) || 0) + (Number(obj.tokens.thoughts) || 0);
    const model = obj.model || 'gemini-2.5-pro';
    const id = obj.id ? `gcli:${obj.id}` : `gcli:${file}:${obj.timestamp}`;

    recordGeminiUsageEvent(cur, file, {
      id,
      tsRaw: obj.timestamp || obj.created_at,
      model,
      input,
      output,
      cacheRead,
    }, monthStartMs);
  }
}

function ingestGeminiJsonFile(file, cur, monthStartMs) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return; }
  let data;
  try { data = JSON.parse(raw); }
  catch { return; }
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  for (const msg of messages) {
    if (!msg || msg.type !== 'gemini' || !msg.tokens || typeof msg.tokens !== 'object') continue;
    const cacheRead = Number(msg.tokens.cached) || 0;
    const rawInput = Number(msg.tokens.input) || 0;
    const input = Math.max(0, rawInput - cacheRead);
    const output = (Number(msg.tokens.output) || 0) + (Number(msg.tokens.thoughts) || 0);
    const model = msg.model || 'gemini-2.5-pro';
    const id = msg.id ? `gcli:${msg.id}` : `gcli:${file}:${msg.timestamp}`;
    recordGeminiUsageEvent(cur, file, {
      id,
      tsRaw: msg.timestamp || data.lastUpdated || data.startTime,
      model,
      input,
      output,
      cacheRead,
    }, monthStartMs);
  }
}

function collectGeminiLogFiles(sinceDate) {
  const out = [];
  const sinceMs = sinceDate.getTime();
  const home = os.homedir();

  // 1. Antigravity brain transcripts: ~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl
  const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
  if (safeIsDir(brainDir)) {
    let convDirs = [];
    try { convDirs = fs.readdirSync(brainDir, { withFileTypes: true }); }
    catch {}
    for (const d of convDirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const transcript = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      const known = geminiCursors.get(transcript);
      try {
        const st = fs.statSync(transcript);
        if (st.isFile() && (known || st.mtimeMs >= sinceMs)) {
          out.push({ file: transcript, size: st.size, ino: st.ino, format: 'jsonl' });
        }
      } catch {}
    }
  }

  // 2. Gemini CLI session logs: ~/.gemini/tmp/<project>/chats/*.jsonl and *.json
  const tmpDir = path.join(home, '.gemini', 'tmp');
  if (safeIsDir(tmpDir)) {
    let projDirs = [];
    try { projDirs = fs.readdirSync(tmpDir, { withFileTypes: true }); }
    catch {}
    for (const p of projDirs) {
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      const chatsDir = path.join(tmpDir, p.name, 'chats');
      if (!safeIsDir(chatsDir)) continue;
      const stack = [chatsDir];
      while (stack.length) {
        const curDir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(curDir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(curDir, e.name);
          if (e.isDirectory()) {
            stack.push(full);
          } else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
            const known = geminiCursors.get(full);
            try {
              const st = fs.statSync(full);
              if (known || st.mtimeMs >= sinceMs) {
                out.push({
                  file: full,
                  size: st.size,
                  ino: st.ino,
                  format: e.name.endsWith('.json') ? 'json' : 'jsonl',
                });
              }
            } catch {}
          }
        }
      }
    }
  }

  return out;
}

async function parseGeminiLocalLogs({ sessionResetAt = null, weeklyResetAt = null } = {}) {
  const summary = emptySummary();
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now);
  const monthStartMs = monthStart.getTime();

  const sessionWindowStart = sessionResetAt
    ? sessionResetAt.getTime() - 5 * 3600 * 1000
    : now.getTime() - 5 * 3600 * 1000;
  const weeklyWindowStart = weeklyResetAt
    ? weeklyResetAt.getTime() - 7 * 24 * 3600 * 1000
    : now.getTime() - 7 * 24 * 3600 * 1000;

  const defaultModel = readDefaultAntigravityModel();
  const files = collectGeminiLogFiles(monthStart);
  const live = new Set();

  for (const { file, size, ino, format } of files) {
    live.add(file);
    let cur = geminiCursors.get(file);

    if (cur && (size < cur.offset || (ino && cur.inode && ino !== cur.inode))) {
      for (const id of cur.seen) geminiSeenGlobal.delete(id);
      cur = undefined;
    }
    if (!cur) {
      cur = { offset: 0, inode: ino, days: {}, events: [], seen: new Set(), activeModel: defaultModel };
      geminiCursors.set(file, cur);
    }

    if (size > cur.offset) {
      if (format === 'json') {
        ingestGeminiJsonFile(file, cur, monthStartMs);
        cur.offset = size;
      } else {
        try {
          cur.offset = readNewLines(file, cur.offset, size, (line) => {
            ingestGeminiLine(line, cur, file, monthStartMs, defaultModel);
          });
        } catch {}
      }
    }

    pruneOld(cur, monthStartMs);
  }

  for (const [file, cur] of geminiCursors) {
    if (live.has(file)) continue;
    for (const id of cur.seen) geminiSeenGlobal.delete(id);
    geminiCursors.delete(file);
  }

  const todayKey = dayKey(now);
  const bounds = { todayKey, todayStart, weekStart, monthStartMs };
  for (const cur of geminiCursors.values()) {
    for (const [key, bucket] of Object.entries(cur.days)) {
      accumulateDayBucket(summary, key, bucket, bounds);
    }

    if (sessionWindowStart != null) {
      for (let i = lowerBound(cur.events, sessionWindowStart); i < cur.events.length; i++) {
        const e = cur.events[i];
        addBucket(summary.sessionUsage, e.input, e.output, e.cacheRead, e.cacheWrite);
      }
    }
    if (weeklyWindowStart != null) {
      for (let i = lowerBound(cur.events, weeklyWindowStart); i < cur.events.length; i++) {
        const e = cur.events[i];
        addBucket(summary.weeklyUsage, e.input, e.output, e.cacheRead, e.cacheWrite);
      }
    }
  }

  return summary;
}

module.exports = { parseLocalLogs, parseGeminiLocalLogs, bucketTotal, resetCache };
