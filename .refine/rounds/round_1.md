# Round 1: Iterative Review Notes

**Reviewer:** Claude (spec-polish-round1)
**Date:** 2026-02-05
**Source spec:** REIMAGINE.md (original)

---

## Proposed Changes — Analysis & Rationale

### 1. ✅ Single Multiplexed WebSocket (replaces multiple HTTP endpoints)

**Change:** Replace the multi-endpoint HTTP architecture (separate `/api/transcribe`, `/api/chat`, `/api/tts`) with a single WebSocket connection carrying both binary audio frames and JSON control messages.

**Rationale:** The original design inherits V0's HTTP-per-action pattern. For a real-time voice app, each HTTP round-trip adds ~50-100ms of overhead (connection setup, headers, body serialization). With a single WebSocket:
- Audio streams as raw binary frames with zero serialization overhead (vs. base64 JSON)
- Barge-in signals arrive instantly (no new HTTP connection needed)
- Turn state changes propagate bidirectionally without polling
- Connection lifecycle is simpler (one reconnect path vs. three)

The tradeoff is more complex message routing on the WebSocket, but a typed message protocol handles this cleanly.

**Verdict: Wholeheartedly agree** — this is table-stakes for a real-time voice app.

---

### 2. ✅ Explicit Turn State Machine with Defined States

**Change:** Added a formal state machine (IDLE → LISTENING → TRANSCRIBING → PENDING_SEND → THINKING → SPEAKING) with defined transitions, replacing the original's vague "Turn/State machine in backend" mention.

**Rationale:** The original spec mentioned a state machine but didn't define states or transitions. This is the single most important architectural element — every voice app bug I've seen stems from unclear turn state. By defining:
- Exact states with names both client and server agree on
- Legal transitions (with triggers)
- Server as authoritative, client as optimistic
- A `turn_state` message type for synchronization

...you eliminate entire classes of bugs: speaking while thinking, listening during playback, ghost transcripts, etc. The ASCII state diagram makes transitions visible and reviewable.

**Verdict: Wholeheartedly agree** — this was the biggest gap in the original spec.

---

### 3. ✅ PENDING_SEND State with Configurable Auto-Send Timer

**Change:** Added an intermediate state between transcription and LLM send. The transcript appears in an editable box; auto-send fires after a configurable delay (default 1.5s), or user can edit and manually send.

**Rationale:** This was implied by "Streaming STT drops into editable message box, user can edit + hit Send" in the constraints, but the original spec didn't formalize it as a state or explain the auto-send behavior. Key questions the original left unanswered:
- When does auto-send fire? (answer: configurable timer from transcript_final)
- Can the user cancel auto-send? (answer: any edit resets the timer)
- What if the user is still editing when the timer fires? (answer: timer paused while box has focus/edits)
- What's the default? (answer: 1.5s, with 0 = instant for power users)

This is a genuine UX innovation — most voice apps either auto-send immediately (frustrating when STT is wrong) or require manual send (breaks the hands-free flow). The timer gives the best of both worlds.

**Verdict: Wholeheartedly agree** — fills a critical UX gap.

---

### 4. ✅ Sentence-Level TTS Pipelining

**Change:** Added detailed section on splitting LLM output at sentence boundaries and dispatching each sentence to TTS independently, with a playback queue on the client.

**Rationale:** This is the #1 latency optimization for voice chat. Without it:
- User speaks → STT (200-500ms) → LLM (2-5s for full response) → TTS (500ms-2s) → playback
- Total: 3-8 seconds of silence

With sentence pipelining:
- User speaks → STT → LLM starts → first sentence complete (~500ms) → TTS on first sentence → playback starts
- Total perceived latency: 1-2 seconds, with continuous speech after that

The original spec mentioned "streaming TTS" but didn't explain the pipelining mechanism. This is important enough to warrant its own section.

**Verdict: Wholeheartedly agree** — this is what makes voice apps feel alive vs. walkie-talkie.

---

### 5. ✅ Typed Message Protocol

**Change:** Added full TypeScript type definitions for the WebSocket message protocol (ClientMessage and ServerMessage union types).

**Rationale:** The original spec had no protocol definition. For implementation, you need to know exactly what messages exist, their payloads, and their directions. The typed protocol:
- Serves as the contract between client and server teams/modules
- Makes the WebSocket multiplexing concrete (not hand-wavy)
- Includes `error` messages with `recoverable` flag for proper error handling
- Includes `cancel` for mid-stream LLM cancellation (important for costs)

**Verdict: Wholeheartedly agree** — essential for implementation clarity.

---

### 6. ✅ Comprehensive Error Handling & Resilience Section

**Change:** Expanded from "limited retries/backoff" mention to a full error handling strategy: WebSocket reconnect with backoff, STT/TTS fallback chains, LLM timeout handling, audio permission flows, graceful text-only degradation, corrupt audio handling, rate limiting.

**Rationale:** The original spec acknowledged resilience gaps but proposed no solutions. For a voice app, error handling IS the UX — users will encounter:
- Network blips (especially on mobile)
- Local server restarts (Parakeet, Kokoro maintenance)
- Mic permission issues (OS updates, first launch)
- Corrupted audio (Bluetooth codec switches, background noise)

The key design choice: **graceful degradation over failure.** If STT fails, fall back to cloud. If cloud fails too, offer text input. If TTS fails, show text. The app should never dead-end.

**Verdict: Wholeheartedly agree** — most voice app projects fail here.

---

### 7. ✅ Security Section

**Change:** Added dedicated security section covering authentication (Tailscale + bearer token), data protection (audio never persisted server-side, secure token storage), and transport security.

**Rationale:** The original spec mentioned "Auth (Tailscale initially, then token-based)" but had no security analysis. Even for a single-user MVP, you need to think about:
- Where API keys live (answer: server only, never in client)
- Where audio data lives (answer: memory only during processing, never persisted)
- How tokens are stored (answer: expo-secure-store / Keychain)
- What's exposed to the network (answer: nothing beyond Tailscale)

This prevents "we'll add security later" syndrome.

**Verdict: Wholeheartedly agree** — security-by-design is cheaper than security-by-retrofit.

---

### 8. ✅ Specific Library Recommendations (expo-audio-studio)

**Change:** Replaced generic "native modules for iOS background audio" with specific recommendation of `@siteed/expo-audio-studio` — a production-tested Expo library with built-in VAD, streaming recording, and Web support.

**Rationale:** The original spec was library-agnostic, which sounds flexible but actually creates implementation risk. Key findings:
- `@siteed/expo-audio-studio` is actively maintained (last updated 2025), Expo-native, has built-in Silero VAD, supports iOS/Android/Web, and provides raw PCM callbacks perfect for WebSocket streaming
- It has a companion UI package for waveform visualization
- Alternative: `expo-audio-streaming` (simpler, focused on mic→stream)
- For web: `vad-web` + AudioWorklet is the proven path

Naming specific libraries means the implementer doesn't have to rediscover this.

**Verdict: Wholeheartedly agree** — specificity de-risks implementation.

---

### 9. ✅ Open Questions & Risks Section

**Change:** Added explicit section cataloguing technical risks and UX unknowns that need validation before or during implementation.

**Rationale:** A good spec acknowledges what it doesn't know. Key risks identified:
- Parakeet may not support true streaming STT (may need buffer-and-reprocess approach)
- Opus encoding availability on React Native is uncertain
- Kokoro may not support within-sentence streaming
- Background audio on iOS needs specific AVAudioSession testing

These are things that could force architecture changes mid-build. Flagging them upfront means the team can spike on them first.

**Verdict: Wholeheartedly agree** — intellectual honesty about unknowns saves time.

---

### 10. ✅ Audio Playback Queue Architecture

**Change:** Made the client-side audio playback queue explicit: TTS chunks arrive independently, queue manager handles ordering and gapless playback.

**Rationale:** "Streaming TTS" sounds simple but the implementation is subtle:
- Chunks may arrive out of order (unlikely with TCP but possible with retries)
- Each chunk must be independently decodable (no codec state dependency between chunks)
- Gapless playback requires pre-buffering the next chunk while current plays
- Barge-in must instantly stop playback AND clear the queue

Making this explicit prevents a common failure mode where "streaming TTS" gets implemented as "wait for all chunks, then play."

**Verdict: Wholeheartedly agree** — this is where streaming TTS implementations usually break.

---

### 11. ⚡ Expanded Slash Commands

**Change:** Added `/voice`, `/tts`, `/stt`, `/export`, `/help` to the original `/model`, `/agent`, `/clear`.

**Rationale:** If you have a slash command system, these are natural additions:
- `/voice` — switch TTS voice without opening settings
- `/tts` and `/stt` — switch providers on the fly (useful for debugging or when local server is down)
- `/export` — quick access to conversation export
- `/help` — discoverability

**Verdict: Somewhat agree** — `/voice` and `/help` are great. `/tts` and `/stt` are nice-to-have but might be over-engineering for MVP. Could be added post-MVP if the slash command infrastructure is clean. Left them in because they're trivial to implement if the framework exists.

---

### 12. ⚡ Barge-In Confirmation Window (200ms)

**Change:** Suggested in Open Questions that barge-in should have a ~200ms confirmation window before killing TTS, to avoid false positives from coughs/background noise.

**Rationale:** Immediate barge-in on any VAD trigger is what commercial assistants do, but they have sophisticated echo cancellation that prevents TTS output from triggering VAD. In our setup with potentially imperfect AEC:
- TTS audio might leak into mic and trigger VAD → false barge-in
- Coughs, sneezes, door slams → false barge-in
- A 200ms window means "if VAD fires and stays active for 200ms, it's real speech"

**Verdict: Somewhat agree** — this is a real problem, but 200ms might feel laggy. The right answer is probably: get AEC right first, and only add a confirmation window if false barge-ins are frequent in testing. Left it as an open question rather than a design decision.

---

### 13. ❌ Things I Considered But Did NOT Add

Per Trevor's constraints, I explicitly did **not** add:
- **Latency telemetry dashboard** — not in MVP (though I added basic logging via pino)
- **Multi-user support** — not in MVP
- **Phased roadmap** — kept as one MVP build
- **Estimated effort** — not included
- **ElevenLabs TTS** — not in MVP, listed in Future only
- **Platform changes** — kept React Native (Expo Dev Client) + Expo Web as decided

I also considered and rejected:
- **WebRTC instead of WebSocket**: WebRTC is designed for this (real-time audio, echo cancellation, adaptive bitrate), but the complexity is enormous for a single-user app. WebSocket over Tailscale is simpler and good enough.
- **On-device STT via Sherpa-ONNX**: `@siteed/sherpa-onnx.rn` exists and could enable fully on-device STT. But it's still in development and Parakeet-MLX over Tailscale is already fast. Deferred to future offline mode.
- **OpenAI Realtime API**: Could replace the entire STT→LLM→TTS pipeline with a single WebSocket. But it's expensive, proprietary, and doesn't support bring-your-own-agent. Not aligned with the OpenClaw Gateway architecture.

---

## Summary of Conviction Levels

### Wholeheartedly Agree (high confidence, would fight for these)
1. Single multiplexed WebSocket
2. Explicit turn state machine with defined states
3. PENDING_SEND with configurable auto-send timer
4. Sentence-level TTS pipelining
5. Typed message protocol
6. Comprehensive error handling & resilience
7. Security section
8. Specific library recommendations
9. Open questions & risks section
10. Audio playback queue architecture

### Somewhat Agree (good ideas, could be scoped down for MVP)
11. Expanded slash commands (core set is essential; `/tts`, `/stt` could wait)
12. Barge-in confirmation window (smart but may be premature optimization — test first)

### Disagree / Rejected (considered but intentionally excluded)
13. WebRTC transport (too complex for single-user)
14. On-device STT via Sherpa-ONNX (premature for MVP)
15. OpenAI Realtime API (misaligned with architecture goals)

---

## What Changed in the Spec (Diff Summary)

1. **Section 2 (Architecture):** Completely rewritten with detailed architecture diagram, single WebSocket design, typed message protocol, explicit state machine with ASCII diagram, sentence-level TTS pipelining, audio playback queue
2. **Section 3 (Platform):** Added specific library recommendations (expo-audio-studio, vad-web) with rationale
3. **Section 4 (Features):** Reorganized into Core Voice Pipeline, Slash Commands (with table), UI/UX, Session Management, Error Handling & Resilience subsections. Much more detail on each feature
4. **Section 5 (Tech Stack):** More specific library choices (Fastify, better-sqlite3, pino, expo-sqlite, expo-secure-store). Added sentence-level TTS pipelining detail
5. **Section 6 (NEW):** Security section
6. **Section 7:** Renamed from "Notes on commercial assistants" — added sentence-level pipelining and visual feedback as patterns
7. **Section 8 (NEW):** Open Questions & Risks — technical risks and UX questions
8. **Section 9 (Future):** Expanded with conversation branching, voice shortcuts, audio message mode, accessibility
