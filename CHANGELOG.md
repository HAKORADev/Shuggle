# Changelog

All notable changes to Shuggle are documented here. Dates are UTC.

## v0.5.0 — Initial Release (unreleased — artifacts under test)

The first public artifact of Shuggle. Everything below ships in this one.

### Added
- Native C++ app for Windows and Linux: Qt6 GUI + interactive CLI + VODER-style one-line CLI, from one identical codebase.
- **Shuggle Engine**: a premade private Kaggle notebook (Qwen3.8-27B-Uncensored, Q4_K_M, GPU T4 x2) that the app creates, boots, monitors, and stops automatically.
- Multi-token support: up to 100 Kaggle API tokens, live introspection, same-account dedupe, exhaustion flags tied to Kaggle's real weekly quota reset, automatic token assignment per session, and live usage meters.
- Streaming chat with elapsed generation timer, markdown rendering with RTL/Arabic support, collapsible thinking blocks with global show/hide.
- In-session branching: retry-older opens a branch instead of rewriting history; branch switcher; branch-out to a new session with full context.
- Shared memory file (toggleable/editable per session) with optional single-shot memory tools (create/edit/delete/list/list_deleted/undo) — no agent loops.
- Web search pipeline (toggle per chat): query planning → notebook-side unfiltered search → summarization digest → cited answers. Separate tool prompt, never mixed into the system prompt.
- Dynamic system prompt builder: fancy editor (identity, role, response style, social status, per-minute local time) and raw editor, 10K char budget; memory budget 10K chars, grounded by a real tokenizer probe from the notebook.
- Terminal runtimes: run model code blocks in Terminal/cmd/PowerShell/bash with live output, clear, and Ctrl+C; Python runtime detection with graceful graying.
- File attachments (UTF-8) with clip-refusal; per-session download folders.
- Chat management: pinning, collapsible pinned/history lists, full chat search (name/date/content), auto-naming, activity dots, active-notebook marks, dual-chat side-by-side mode with broadcast input.
- Settings: global and per-session; context window 32,768–75,000 (hard ceiling 75K); in-app internal browser (WebView2 on Windows, WebKitGTK helper on Linux) with open-in-app vs system-browser choice and optional Edge data reuse.
- First-run wizard, no-token/no-internet/no-quota edge states, delete confirmations, and the cool banner.

### Notes
- Artifacts are distributed via GitHub Actions while this release is under test; a GitHub Release will follow once stable.
