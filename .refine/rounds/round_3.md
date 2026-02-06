# Round 3 - Opus Review (2026-02-05)

**Reviewer:** Claude Opus 4.6
**Source:** REIMAGINE.md + Round 1 feedback + Round 2 (GPT Pro) filtered feedback
**Goal:** Incorporate accepted Round 2 changes, then identify remaining gaps/improvements

---

## Part A: Incorporating Accepted Round 2 Changes

These 5 changes from Round 2 were marked MVP-relevant. Here's how each should land in the spec:

### Change 2 — Binary TTS frames (no base64)
**Status:** Already aligned. REIMAGINE.md specifies binary WebSocket frames for audio. The TTS section mentions `tts_chunk` messages but doesn't explicitly say binary frames. 

**Spec patch needed:** In the message protocol (Section 2), change `tts_chunk` from JSON with `audio: string` to a binary frame + preceding JSON metadata frame pattern (mirroring how mic audio works). Specifically:

```typescript
// Replace:
| { type: 'tts_chunk'; audio: string; format: 'opus' | 'wav'; index: number }

// With:
| { type: 'tts_meta'; format: 'opus' | 'wav'; index: number; sampleRate: number; durationMs: number }
// followed by binary frame containing raw audio bytes
```

This eliminates base64 encoding overhead for TTS audio delivery.

### Change 5 — Echo-aware barge-in gating (~200ms + energy check)
**Status:** Round 1 flagged this as an open question. GPT Pro gave concrete implementation.

**Spec patch needed:** In the turn state machine section, add a transition guard on SPEAKING → LISTENING:

> During SPEAKING state, barge-in requires: (a) VAD active for ≥200ms sustained, AND (b) mic energy exceeds playback energy by a configurable margin (default 6dB). This prevents TTS audio leaking into the mic from triggering false barge-ins, especially on speakerphone or Bluetooth.

Also update Open Questions to remove the barge-in sensitivity question (now answered).

### Change 6 — Rolling-window STT for Parakeet
**Status:** Addresses the first Technical Risk (Parakeet streaming support).

**Spec patch needed:** In Section 5 (STT Local), replace the uncertain streaming description with:

> **Streaming approach:** Rolling-window re-decode. Every 300-700ms during LISTENING, send the last 4-8 seconds of accumulated audio to Parakeet. Parakeet returns a full transcript of that window. The gateway maintains a `stablePrefix` (text confirmed across 2+ consecutive decodes) and `unstableSuffix` (latest decode's tail that hasn't stabilized). Client receives `transcript_partial` with `stablePrefix + unstableSuffix`, rendering stable text normally and unstable text with a subtle visual distinction (lighter color or italic). On VAD end, one final full-audio decode produces `transcript_final`.

Move the Parakeet streaming risk from Open Questions to a resolved note.

### Change 8 — expo-av deprecated → use expo-audio
**Status:** Direct library swap needed.

**Spec patch needed:** In Section 5 (Client tech stack), replace:
- `expo-av` with streaming queue manager → `expo-audio` with streaming queue manager

Also add a note: expo-av is deprecated as of Expo SDK 52+. Use `expo-audio` (from `expo-audio` package) which provides equivalent playback APIs with better performance.

### Change 15 — Phrase chunker vs naive sentence split
**Status:** Improves the TTS pipelining section.

**Spec patch needed:** In the Sentence-Level TTS Pipelining section, replace the naive boundary detection with:

> **Phrase-level chunking:** The gateway uses a phrase-aware chunker rather than naive sentence splitting. Rules:
> - Split at sentence boundaries (`.`, `!`, `?`) but NOT after common abbreviations (Mr., Dr., e.g., etc.)
> - For long sentences (>100 chars without a sentence boundary), split at natural pause points: commas, semicolons, em-dashes, colons
> - Minimum chunk size: 4 words (avoid choppy single-word TTS calls)
> - Maximum chunk size: ~200 chars (avoid long TTS generation delays)
> - Code blocks and URLs are never split mid-token

---

## Part B: Opus Review — Remaining Issues

### 1. 🔴 REIMAGINE.md vs SPEC.md Drift (Critical)

The repo has two specs: `SPEC.md` (original V0, ~300 lines) and `REIMAGINE.md` (the real spec, ~400 lines). The V0 spec describes a completely different architecture (HTTP endpoints, vanilla JS, no React Native). Anyone coming to this repo will be confused about which is authoritative.

**Recommendation:** Rename `SPEC.md` → `SPEC-v0.md` (archive) and `REIMAGINE.md` → `SPEC.md` (canonical). Or delete `SPEC.md` entirely since the working implementation already exists as `index.html`.

### 2. 🟡 Web-First vs React Native Tension

The spec is written for React Native + Expo, but the working implementation is a single `index.html` vanilla JS file served via Caddy. Trevor's been iterating on the web version successfully. The React Native spec adds significant complexity (Expo Dev Client, native audio modules, two different VAD libraries, two different audio capture paths) for one benefit: iOS background audio.

**Question for Trevor:** Is background audio on iOS actually needed for your use case? You're using this at your desk or around the house. If the browser tab stays in foreground while talking, the web version works fine. The RN migration is a ~2 week effort that adds a lot of moving parts.

**If web-only is fine:** Strip all RN-specific sections. Keep the backend architecture (it's good). The web client is already working.

**If RN is needed:** Fine, but the spec should acknowledge the web version as the Phase 1 deliverable and RN as Phase 2.

### 3. 🟡 Bridge Server vs Voice Gateway Identity Crisis

The spec describes a new "Voice Gateway" (Fastify + TypeScript + SQLite + WebSocket), but the current bridge is a ~200-line Node HTTP server that works. The spec doesn't clearly state whether the Voice Gateway replaces the bridge or is a separate new server.

**Recommendation:** Add a migration section. The bridge works today. The Voice Gateway is the target architecture. Specify what the migration path looks like:
- Phase 1: Current bridge, enhanced with binary TTS frames + phrase chunker + rolling-window STT
- Phase 2: Full Voice Gateway rewrite (if/when complexity warrants it)

### 4. 🟡 Session Persistence Scope Creep

The spec includes SQLite session storage, conversation search, export, conversation list with sidebar. For a personal voice chat tool, this is significant scope. The current implementation has no persistence and works fine — conversation context lives in the OpenClaw gateway session.

**Recommendation:** Cut session persistence from MVP. If Trevor wants history, the OpenClaw gateway already stores session history. Adding another persistence layer is redundant for a single-user tool.

### 5. 🟢 Missing: Kokoro Voice Selection

The spec mentions Kokoro as local TTS but doesn't specify voice selection. We just fixed a bug where only 1 of 54 voices appeared. The spec should document:
- Default voice: `af_heart` (or Trevor's preference)
- Voice switching via `/voice` command and settings panel
- Voice categories: American English, British English, + 7 other languages

### 6. 🟢 Missing: TTS Provider Switching Logic

The spec says "Kokoro (local) or OpenAI (cloud) — swap via settings" but doesn't define the fallback behavior during a conversation. What happens if Kokoro goes down mid-conversation?

**Recommendation:** Add: If the active TTS provider fails 3 consecutive times within 60 seconds, auto-switch to the alternate provider and show a subtle "Switched to [provider]" toast. Manual switch back via `/tts` command.

### 7. 🟢 Missing: Audio Format Negotiation

The `hello`/`welcome` handshake (from Round 2's Change 1) was marked "Maybe Later" but the spec still doesn't specify what audio format the client should send. Currently it's WAV. The spec mentions Opus but with uncertainty about RN support.

**For web-only MVP:** Stick with WAV (16kHz, 16-bit, mono). It works, Parakeet accepts it, and the bandwidth on Tailscale LAN is irrelevant. Add a comment: "Opus encoding is a future optimization for mobile/bandwidth-constrained scenarios."

### 8. 🟢 Latency Budget Needs Update

The spec's latency estimate (Section at bottom of V0 spec) is for the old HTTP architecture. With rolling-window STT, the breakdown changes:

| Step | Old | New (with rolling-window STT) |
|------|-----|------|
| VAD detection | ~100ms | ~100ms |
| STT | 200-500ms (batch after speech end) | ~0ms (already decoded during speech, final confirm ~200ms) |
| Gateway + Claude | 1-2s | 1-2s |
| TTS (first chunk) | 300-500ms | 200-400ms (phrase chunking) |
| **Total to first audio** | **1.5-3s** | **1.3-2.7s** |

The real win is that STT is effectively "free" since it's happening during speech.

---

## Summary

### Must-do (before implementation):
1. Incorporate the 5 accepted Round 2 changes (Part A above)
2. Resolve SPEC.md vs REIMAGINE.md confusion (#1)
3. Decide web-only vs React Native (#2) — this changes 40% of the spec

### Should-do (improves spec quality):
4. Clarify bridge → Voice Gateway migration path (#3)
5. Cut or defer session persistence (#4)
6. Add TTS provider fallback logic (#6)

### Nice-to-have:
7. Document Kokoro voice catalog (#5)
8. Specify audio format explicitly (#7)
9. Update latency budget (#8)
