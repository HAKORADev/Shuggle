<p align="center">
  <img src="assets/shuggle_256.png" alt="Shuggle Logo" width="150"/>
</p>

<h1 align="center">Shuggle</h1>

<p align="center">
  <strong>Free • Uncensored • Zero local compute</strong><br/>
  Your chats run on Kaggle's free GPUs. Your data never leaves your disk.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v0.5.0-purple?style=for-the-badge" alt="Version"/>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue?style=for-the-badge" alt="Platform"/>
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="License"/>
</p>

---

**Jump to:** [What Is Shuggle?](#what-is-shuggle) · [How It Works](#how-it-works) · [First Run](#first-run) · [Features](#features) · [CLI](#cli) · [Share On Your Network](#share-on-your-network) · [FAQ](#faq)

## What Is Shuggle?

Shuggle gives you a real ChatGPT-class chatting experience **for completely free** — not a trial, not a watered-down tier. It runs an uncensored 27B model on **Kaggle's free GPU hours** (the twin Tesla T4s every Kaggle account gets, 30 hours a week), and makes it feel local: open the app, pick a chat, type, watch the answer stream in.

It is what you would get if a local LLM app and a polished web chat had a baby, and that baby refused to pay for anything. The model is not on your machine — but everything else is: chats, memories, tokens, attachments and downloads live in one folder next to the app, encrypted with your password. Nothing is sent anywhere except to the engine notebook on your own Kaggle account.

One executable. No installers, no runtimes, no DLL folders.

## How It Works

Shuggle sets up one private engine on **your** Kaggle account: it mounts the model once, keeps your chats warm, and talks to the app through official Kaggle APIs only — commands go out as small private updates, replies stream back live. When you walk away, the engine saves everything and rests so your GPU hours come back to you. Come back and it wakes in minutes with every chat intact.

```
   your device                          your Kaggle account
┌──────────────────┐                 ┌─────────────────────────┐
│  Shuggle app     │  official API   │  Shuggle Engine (T4 ×2) │
│  chats · memory  │ ◄──────────────►│  uncensored 27B model   │
│  tokens · files  │  send / stream  │  your private storage   │
└──────────────────┘                 └─────────────────────────┘
```

- **Private by construction** — the engine, the model storage and the relays are all private items on the account the token belongs to. Only your token can see them.
- **The weekly rhythm** — each token carries 30 GPU hours, resetting every Saturday. The app meters them per token, flags dry ones until reset, and rotates to a fresh token automatically. Stack up to 100 tokens.
- **Walk-away friendly** — 3 minutes of no activity (6 in reading mode) and the engine tucks itself in. Wake-ups are quick because the model never has to be fetched twice.

## First Run

1. Grab `Shuggle.exe` (Windows) or `shuggle` (Linux) from the artifacts, drop it in its own folder.
2. Open it — create your account (name + password). That password encrypts everything on disk. One account per device.
3. Click the token icon, hit **?**, and follow the wizard: create a Kaggle token in 5 steps, paste it in. Shuggle verifies it and reads your GPU hours.
4. Say anything. The first boot sets the model up on your Kaggle storage (one time, ~15 minutes). Every chat after that is minutes away.

**Linux note:** keep `shuggle` executable (`chmod +x shuggle`). The app window opens through Chrome/Chromium app mode when available, otherwise your default browser.

## Features

- **Real chat interface** — markdown, syntax-highlighted code with copy/download, RTL and Arabic done right, thinking blocks you can show or hide, reply timings, streaming as it writes.
- **Branching that makes sense** — retry an older message and it opens a **new dimension** instead of shredding your chat. Flip between dimensions with `‹ 2/3 ›`. Edit any of your messages to re-send with changes. Branch any point out into a fresh chat carrying the full context.
- **Web search, engineered not vibes** — an on/off toggle per chat. The model plans a few queries, reads unfiltered results, a distillation pass compresses them into exactly what the question needs. Capped and configurable. A fixed pipeline, never an agent.
- **Memory** — one text you maintain (or let the model maintain, optionally), shared across every chat, toggleable per chat, capped at 10K characters.
- **Attachments** — UTF-8 text files ride inside the message as attachment chips. Over the limit? Refused with a clear message. Never silently clipped.
- **Dual-chat compare** — run two chats side by side, broadcast one message to both or talk to each separately. Perfect for comparing prompts, temperatures, or your own branches.
- **Terminal at your side (CLI)** — `shuggle cli` is a real conversation in your terminal with the same account, same history, same memories. `shuggle chat "..."` for one-shot asks.
- **Profiles** — one account per device, signed to the machine, password-gated. Sessions, tokens and memory all sit encrypted in the app folder.
- **Token pool** — up to 100 tokens, per-account dedupe, weekly usage meters, exhaustion flags, auto-rotation, and a step-by-step wizard for making your first token.

## CLI

```
shuggle                    open the app
shuggle cli                chat in the terminal (interactive)
shuggle chat "text"        ask once, get the answer
shuggle chat 2 "text"      ask in chat #2
shuggle tokens add <tok>   add a Kaggle token
shuggle tokens list        pool status
shuggle status             engines at a glance
shuggle serve --lan        share on your local network
```

Interactive commands: `/new /open /list /rename /del /pin /search /think /memory /tokens /use /status /sleep /help`

## Share On Your Network

Run **`Shuggle LAN.bat`** (Windows) or **`./shuggle-lan.sh`** (Linux) — Shuggle opens to your local network and prints a link like `http://192.168.1.20:8680`. Anyone on the same Wi-Fi opens it in a browser, logs in with your password, and chats. Everything still runs and stays on your machine.

## FAQ

**Is it really free?** Yes — Kaggle gives every account 30 GPU hours weekly, no card, no catch. Shuggle just uses them well.

**Where does my data live?** In `ShuggleData/` next to the executable, encrypted with your password. The engine keeps its working notes in your own private Kaggle storage so boots are fast — that storage is bound to your token and readable only by your account.

**Why does the first message take a while?** The engine is being set up on your Kaggle account (model stored once, ~15 minutes). After that, waking the engine takes a few minutes, and replies start streaming right after.

**What does "resting" mean?** The engine saved everything and gave its GPU hours back. It wakes automatically on your next message — chats, memories and context come back exactly as they were.

**Uncensored how?** The model is an uncensored 27B. Shuggle adds no filters and never inspects your chats. What you write stays between you and the model.

## Documentation

- The engine, the model storage, and the relays are created automatically per token. Delete the app folder and nothing remains on your device; remove `shuggle-*` items from your Kaggle account to clear the cloud side.
- Model: [Qwen3.8-27B-Uncensored](https://huggingface.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF) (Q4_K_M GGUF, 75K context, twin T4s).
