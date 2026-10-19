// Worker entry point. Keeps the JSONL walk off Electron's main thread: the
// cold pass still costs a few hundred ms, and blocking the main thread there
// stalls IPC, tray updates and window painting.
//
// The cursor cache lives in this worker's module scope, so it persists across
// requests exactly as it would in-process.

const { parentPort } = require('worker_threads');
const { parseLocalLogs } = require('./localUsage');

parentPort.on('message', async (msg) => {
  const { id, sessionResetAt, weeklyResetAt } = msg;
  try {
    const summary = await parseLocalLogs({
      sessionResetAt: sessionResetAt ? new Date(sessionResetAt) : null,
      weeklyResetAt: weeklyResetAt ? new Date(weeklyResetAt) : null,
    });
    parentPort.postMessage({ id, ok: true, summary });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e && e.message });
  }
});
