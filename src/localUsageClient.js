// Main-thread client for the local-usage worker.
//
// Falls back to an in-process parse if the worker can't start, so a packaging
// or platform problem degrades to the old behaviour rather than losing the
// local spend numbers entirely.

const path = require('path');

let worker = null;
let seq = 0;
const pending = new Map();
let fallback = null;

function startWorker() {
  if (worker) return worker;
  try {
    const { Worker } = require('worker_threads');
    worker = new Worker(path.join(__dirname, 'localUsageWorker.js'));
    worker.on('message', (msg) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (pending.size === 0 && worker) worker.unref();
      if (msg.ok) entry.resolve(msg.summary);
      else entry.reject(new Error(msg.error || 'worker error'));
    });
    worker.on('error', () => { failAll(); });
    worker.on('exit', () => { failAll(); });
    worker.unref(); // idle worker must not hold the process open
  } catch {
    worker = null;
  }
  return worker;
}

function failAll() {
  worker = null;
  for (const [, entry] of pending) entry.reject(new Error('worker exited'));
  pending.clear();
}

async function parseLocalLogsAsync(opts = {}) {
  const w = startWorker();
  if (!w) return inProcess(opts);

  const id = ++seq;
  const payload = {
    id,
    sessionResetAt: opts.sessionResetAt ? opts.sessionResetAt.toISOString() : null,
    weeklyResetAt: opts.weeklyResetAt ? opts.weeklyResetAt.toISOString() : null,
  };

  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.ref(); // hold the loop open until this reply lands
      w.postMessage(payload);
    });
  } catch {
    // Worker died mid-flight. Serve this tick in-process.
    return inProcess(opts);
  }
}

function inProcess(opts) {
  if (!fallback) fallback = require('./localUsage');
  return fallback.parseLocalLogs(opts);
}

function stop() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  pending.clear();
}

module.exports = { parseLocalLogsAsync, stop };
