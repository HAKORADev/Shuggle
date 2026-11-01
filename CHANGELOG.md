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
- Memory: one shared, editable memory across chats — capped, synced, and optional. The model can manage it itself (create / edit / delete / list / list-deleted / undo) behind a toggle, with its own instructions kept separate from your system prompt.
- Skills: reusable instruction modules you write in the app — title, when it applies, why it exists, and the content. Toggle the whole system, a single skill, or a skill for one chat only; globally and per chat. They ride as their own block with their own handler instructions, never mixed into your prompt.
- Vision: images and video through the model's own projector (no audio). Loads on first use, unloads when switched off, with hard caps on size, count and frames and a context budget so media can never flood the conversation.
- Reply language (mirror the user / this device / always one language), an "about you" section, and a personalisation panel next to your time and location.
- Multi-device safety: the Kaggle storage namespace is bound to the device signature, so two devices signed into one account never overwrite each other's chats.
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
