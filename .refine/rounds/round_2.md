# Round 2 - GPT 5.2 Pro Review (2026-02-05)

**Source:** https://chatgpt.com/c/69851a06-44c0-8323-9d9e-f575e9a44100
**Model:** GPT 5.2 Pro (regular reasoning, NOT extended)
**Prompt:** Standard Emanuel spec review prompt

## Trevor's Filter Note
This review is thorough but overkill for MVP. We're building a personal tool, not a product.
Cherry-pick what actually improves Trevor's experience. Ignore "production at scale" suggestions.

## MVP-Relevant Changes (Worth Taking)
- **Change 2** — Binary TTS frames (no base64) — easy win, real perf improvement
- **Change 5** — Echo-aware barge-in gating (~200ms + energy check) — prevents self-trigger
- **Change 6** — Rolling-window STT strategy for Parakeet — practical solution to a real limitation
- **Change 8** — expo-av deprecated → use expo-audio — important, avoid deprecated deps
- **Change 15** — Phrase chunker vs naive sentence split — small effort, better TTS quality

## Maybe Later (Good Ideas, Not MVP)
- **Change 1** — Protocol versioning/IDs — good for multi-device, overkill for single-user
- **Change 3** — Backpressure/buffering limits — matters at scale, not for Tailscale LAN
- **Change 4** — Server-authoritative VAD — good architecture but adds complexity
- **Change 9** — Unified sample rate strategy — good hygiene, can refactor later
- **Change 10** — Provider isolation layer / circuit breakers — production concern
- **Change 14** — Confidence highlighting + tap-to-fix — cool UX, but future polish

## Skip for Now (Overkill)
- **Change 7** — OpenAI Realtime transcription fallback — unnecessary with working local STT
- **Change 11** — Observability/OpenTelemetry/Prometheus — way overkill for personal tool
- **Change 12** — Token security hardening (HttpOnly cookies, CSP) — Tailscale is fine
- **Change 13** — Data retention modes / E2EE — single user, no need
- **Change 16** — Realtime voice mode — cool future idea, file it away

---

## Full Review (Raw)

Below are the strongest revisions I'd make to your plan to improve robustness, reliability, performance, debuggability, and product "wow", while keeping the spirit of your architecture (local-first STT/TTS, bring-your-own-agent via OpenClaw, streaming everywhere).

For each proposed change you'll get:
- Detailed analysis + rationale
- A git-diff style patch against your plan (as if it were PLAN.md)

### Change 1 — Make the WebSocket protocol "real": versioning, IDs, sequencing, resume, and capability negotiation

**Why this makes the project better:**
Right now the protocol is "types over JSON + raw binary audio." That works for a single happy-path client, but it becomes brittle once you add: reconnect/resume, multi-device/multi-tab, provider failover mid-turn, buffering and backpressure, latency instrumentation per turn, "server authoritative" state.

The fix is to make the protocol explicitly versioned and turn/message addressed, with a minimal handshake:
- `hello` (client → server): protocol version + codec support + preferred sample rate + feature flags
- `welcome` (server → client): chosen codec + server settings + heartbeat interval + max buffered audio + session id
- Every message thereafter includes: sessionId, conversationId, turnId, and msgId
- Audio frames include seq + timestampMs
- Server sends ack to let client drop buffered audio

### Change 2 — Stop base64 for TTS: send TTS audio as binary frames (like mic audio)

Base64 costs ~33% size overhead, extra CPU to encode/decode, extra memory copies, larger GC pressure (especially RN/Hermes). Fix: mirror your mic approach — JSON metadata frame followed by binary audio frame.

### Change 3 — Add explicit backpressure + buffering limits

Max mic buffer duration (2-5s), server audio_ack and client drop policy, server "slow consumer" detection.

### Change 4 — Make server authoritative for VAD/endpointing

Client VAD is "preview," server VAD is "truth." Enables consistent endpointing, echo-aware barge-in gating centrally.

### Change 5 — Add echo-aware barge-in gating

When in SPEAKING: require ~200ms sustained VAD + energy margin above playback, to avoid TTS self-trigger on speakerphone/Bluetooth.

### Change 6 — Rolling-window STT strategy for Parakeet

Rolling-window re-decode every 300-700ms on last 4-8s audio, maintain stablePrefix + unstableSuffix to avoid flicker.

### Change 7 — Add OpenAI Realtime transcription as additional STT fallback

gpt-4o-mini-transcribe / gpt-4o-transcribe for true incremental partials. Support STT "prompt hints" for custom vocab.

### Change 8 — expo-av is deprecated; use expo-audio

Add jitter buffer + prebuffer threshold. Allow server to coalesce tiny TTS chunks into ~200-400ms segments.

### Change 9 — Unify sample rate strategy

Capture at device-native (48k), transport as Opus, server resamples to 16k for STT.

### Change 10 — Provider isolation layer

TurnSupervisor + provider interfaces with circuit breakers, timeouts, concurrency limits.

### Change 11 — First-class observability

Per-turn latency metrics, correlation IDs, Prometheus metrics, debug HUD.

### Change 12 — Security hardening

HttpOnly cookies for web, strict CSP, shorter token expiry, device-scoped tokens.

### Change 13 — Explicit data retention modes

Client-only (default) vs synced (optional), with retention policies and encryption option.

### Change 14 — Confidence highlighting + tap-to-fix correction

Visually mark low-confidence words, tap a word to speak correction and replace just that span.

### Change 15 — Phrase chunker instead of naive sentence splitting

Handle abbreviations, chunk long sentences at commas, minimum phrase length for smooth prosody.

### Change 16 — Optional "Realtime Voice Mode" (audio-to-audio)

Future path using OpenAI Realtime API, architecture it as switchable mode via /mode command.

### Meta Notes
- MVP scope is good — treat "protocol + playback + endpointing" as the core
- expo-av deprecation is non-optional to address
- "Killer patch" trio: Changes 1 + 2 + 4 (protocol + binary TTS + server VAD)
