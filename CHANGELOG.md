# Changelog

## Unreleased

Gemini sign-in

- The app no longer ships Google OAuth client secrets or presents itself as Antigravity. It identifies as ClaudeUsageBar.
- It reads the newest token that Antigravity or Gemini CLI has saved. When every token has expired, the Gemini tab says to open one of those apps. Set `GEMINI_OAUTH_CLIENT_ID` and `GEMINI_OAUTH_CLIENT_SECRET` to let the app renew tokens itself.

Accuracy

- 7d and 30d are now rolling windows. They used to stop at Monday and the 1st of the month, so early in a month "30d" showed a few days and the daily chart was empty.
- Output tokens are no longer undercounted by about 22%. Claude Code streams a message as many lines, and the parser kept the first line, which has a partial count.
- Antigravity CLI logs in `~/.gemini/antigravity-cli` are now read. Most Antigravity usage lives there.
- Model names with a dot are no longer cut short. "Gemini 3.8 Flash" was read as "Gemini 3" and billed at Pro rates.
- Gemini prices match the November 2026 rate card, including the dated rises for Gemini 4 Argon and Gemini 3.6 and 3.8 Flash. Each request is priced by its own date.
- A limit whose reset time has passed reads 0%, even if the next fetch fails.
- A limit the provider does not report has no row and no false 0%. Rows come from what the API returns, so a Sonnet weekly limit now shows and counts toward the tray icon.
- Gemini partner model quota is now a limit row and counts toward the tray icon.
- Extra usage reads as money, using the decimal places the API reports. Limits without a monthly cap now show too.

Reliability

- A connection dropped mid-response no longer freezes polling until restart. Every request now settles, and a failure in one tick cannot stop the loop.
- A rotated Claude token now retries at once, instead of showing an error for 5 minutes.
- Opening the popup now fetches fresh numbers. It used to wait for the 5-minute hidden cadence.
- The footer shows the age of the last successful fetch. It used to say "just now" during an outage.
- Waking from sleep waits for the network, and being offline retries in 30 seconds. Waking no longer skips a Retry-After.
- The keychain prompt stays open long enough to answer, and no longer blocks the app or returns every 5 minutes once denied.
- Clicking the tray icon closes an open popup on every platform. Linux gets a tray menu, because most Linux desktops send no tray clicks. The icon stays visible on dark Windows and Linux taskbars.
- The popup opens on the current Space and over full-screen apps.

Interface

- Fixed highlights and tab badges that never showed, caused by undefined colours and mismatched class names.
- Pace verdict now flags a session on track to hit its limit. It no longer calls the same session "On pace". The first 15 minutes are not judged.
- Removed the duplicate reset time. Large totals read as `9.4B` and `$4,292`. Models under 1% fold into "Other". Keyboard hints match the keys that work.
- Local spend shows when a provider's sign-in has lapsed.

Internals

- The popup renderer is now sandboxed and cannot navigate or open windows. Removed an unused IPC channel.
- The tray icon is drawn in code, which removes a hidden browser window.
- Shared code replaced the duplicated Claude and Gemini paths in the parser and the derivations, and the three HTTP clients.
- 118 regression checks under `npm test`.

## 2.2.0

- Gemini limits, spend, and plan from Antigravity, Gemini CLI, and API keys.
- Claude, Gemini, and Combined tabs.
- Daily price and token comparison, with day and period filters.

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
