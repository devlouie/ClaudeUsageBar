# Changelog

## 2.1.0

First public release under this repository.

- Prices match the October 2026 Anthropic rate card. Opus 5.5 at $4/$20, Sonnet 5 and 5.5 at $2/$10, Haiku 5.5 at $0.10/$0.50 with the over-100K prompt tier, and the lower cache-hit rates on Fable 5.1, Opus 5.5, and Sonnet 5.5.
- 1-hour and 5-minute cache writes are priced separately, from the TTL breakdown Claude Code logs.
- Opus fast mode is priced at its premium rate.
- Per-model weekly meters are read from the limits array the usage endpoint now returns. Fable has its own row and tooltip entry.
- Usage requests honour Retry-After.
- Electron 44 and electron-builder 26.
- Incremental transcript parsing in a worker thread. Steady-state refresh drops from about 580 ms to about 2 ms on a 329 MB corpus.
- 53 regression checks under `npm test`.
