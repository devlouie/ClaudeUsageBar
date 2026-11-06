// Main-thread client for the local-usage worker.
//
// Falls back to an in-process parse if the worker can't start or dies, so a
// packaging or platform problem degrades to slower numbers rather than none.
// A worker that hangs is terminated and the request rejects, so the caller
// keeps its last numbers and the poll loop carries on. It does not fall back,
// because whatever hung the worker would then hang the main thread too.

const path = require('path');

const WORKER_TIMEOUT_MS = 120_000;

let worker = null;
let seq = 0;
const pending = new Map();
let fallback = null;

function startWorker() {
  if (worker) return worker;
  try {
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, 'localUsageWorker.js'));
    w.on('message', (msg) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (pending.size === 0 && worker === w) w.unref();
      if (msg.ok) entry.resolve(msg.summary);
      else entry.reject(new Error(msg.error || 'worker error'));
    });
    const onGone = () => { if (worker === w) failAll(new Error('worker exited')); };
    w.on('error', onGone);
    w.on('exit', onGone);
    w.unref(); // idle worker must not hold the process open
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function failAll(err) {
  worker = null;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  pending.clear();
}

function onTimeout() {
  const w = worker;
  const err = new Error('worker timed out');
  err.code = 'WORKER_TIMEOUT';
  failAll(err);
  if (w) w.terminate().catch(() => {});
}

async function parseLocalLogsAsync(opts = {}) {
  const w = startWorker();
  if (!w) return inProcess(opts);

  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(onTimeout, WORKER_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      w.ref(); // hold the loop open until this reply lands
      w.postMessage({
        id,
        sessionResetAt: opts.sessionResetAt ? opts.sessionResetAt.toISOString() : null,
        geminiSessionResetAt: opts.geminiSessionResetAt ? opts.geminiSessionResetAt.toISOString() : null,
      });
    });
  } catch (e) {
    if (e.code === 'WORKER_TIMEOUT') throw e;
    return inProcess(opts); // worker died mid-flight. Serve this tick in-process.
  }
}

function inProcess(opts) {
  if (!fallback) fallback = require('./localUsage');
  return fallback.parseAllLogs(opts);
}

function stop() {
  const w = worker;
  worker = null;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  if (w) w.terminate().catch(() => {});
}

module.exports = { parseLocalLogsAsync, stop };
