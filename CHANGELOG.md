# Changelog

All notable changes to Shuggle are documented here.

## v0.5.0 — initial release

The whole thing, for the first time:

- Free, unlimited chatting on Kaggle's free GPU hours (30h/week per token) — an uncensored 27B on twin T4s, driven entirely through the official Kaggle API. No tunnels, no middlemen.
- One-file app: a single executable, no runtimes, no DLLs. Your chats, memories, tokens and settings live in one folder next to it, encrypted with your password.
- Local accounts: one account per device, password-gated, device-signed.
- Real chat experience: markdown, code highlighting, RTL/Arabic, thinking blocks with show/hide, reply timing, copy/download everywhere.
- Retry and edit that branch properly — every retry opens a new dimension you can flip between with ‹ 2/3 ›, and any message can branch out into a fresh chat carrying the full context.
- Web search pipeline (optional, per chat): the model plans queries, reads unfiltered results, and a distillation pass hands it only what matters.
- Memory: one shared, editable memory across chats — capped, synced, and optional.
- File attachments: UTF-8 text only, hard limits, refused — never silently clipped.
- Token pool: up to 100 Kaggle tokens with per-account dedupe, weekly quota meters, exhaustion flags and automatic rotation.
- Dual-chat compare mode with per-side or broadcast messages.
- CLI: `shuggle cli` for real conversations in the terminal, `shuggle chat "..."` for one-shot asks — same account, same history.
- LAN mode: `.bat`/`.sh` launchers open Shuggle to your local network so anyone on your Wi-Fi can use it in their browser.

## Unreleased (this round)

Fixes found by actually running it, end to end, on real GPUs:

- The shipped app opened a **blank window** — the UI assets were read from disk, and a single-file executable has no `src/ui` folder. They are compiled into the binary now.
- The CLI was dead on arrival: global flags swallowed the command word, the embedded server dialled port 0, and every send threw `slot is not defined` before the model was reached.
- A pending reply now survives the engine falling asleep (it wakes again instead of failing the turn), and a dead engine no longer looks alive — the log stream replays, so the app now asks and waits for the answer.
- The memory parser read only the first note (a JavaScript regex has no `\Z`), so edit / delete / undo never matched later ones.
- The Windows artifact shipped `.sh` launchers; the `.bat` launchers dropped their arguments, so there was no CLI mode behind them.
- Rate limits, GPU-session limits and missing tokens now say what actually happened instead of a generic apology.

## v0.5.0 — alpha refresh (build fixes + live-fire hardening)

Fixes from the first real-machine test round:

- **The exe serves a real UI now** — the app window was blank because assets were probed on disk from inside the compiled binary (those paths only exist in dev). Everything is embedded at build time now, and CI smoke-tests it: the artifact can never ship a blank window again.
- **CLI that actually runs** — first-run account creation happens right in the terminal; `shuggle cli` and `shuggle chat` attach to the running app instead of spawning a second brain; `/use`, `/rename`, `/pin` and friends really talk to the API now. Windows gets a proper `Shuggle CLI.bat`.
- **Engine lifecycle hardened** — a boot in flight can no longer be killed by the previous session's goodbye (the race that flipped the engine to "resting" one second after starting); a failed start now lands in an honest error state instead of "booting" forever.
- **Replay contamination fixed** — generation events are tagged with the command version they belong to; the log stream re-serves old turns on every reconnect and those stale replies used to masquerade as answers to *new* messages.
- **Memory tools actually reach the engine** — the create/edit/delete/list/list_deleted/undo switch existed in settings but was never sent; the mem echo can no longer truncate your real memories; vision + memory knobs are baked into engine boots and patchable live.
- **Windows artifact is Windows-only** — no more `.sh` files in the zip; CI trigger repaired (`[main]`), UI-serving smoke tests on both platforms.
- **Links stay inside the app when you ask** — the in-app viewer setting is now real, with an honest "open in browser" escape hatch for sites that refuse framing.
- **Compare mode got its broadcast** — one message now goes to both chats side by side.
- **Sharper binaries** — the executable ships UPX-compressed (~90 MB → ~33 MB) and verified running after compression.
- Window shell: isolated browser profile by default (your Edge data only when you switch it on), no first-run popups, favicon-carried taskbar icon.
