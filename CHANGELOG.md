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
