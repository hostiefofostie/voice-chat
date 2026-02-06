# Voice Chat Reimagined

## 1. Current State Analysis

### What's There (Architecture)
- **Client:** Single-file `index.html` (vanilla JS) served over HTTPS via Caddy. Uses `vad-web` (Silero) for VAD, records mic, converts Float32 → WAV, sends to bridge.
- **Bridge server:** `bridge.js` (Node HTTP) exposes:
  - `POST /api/transcribe` → Parakeet server (local STT on Apple Silicon).
  - `POST /api/chat` and `/api/chat/stream` → OpenClaw Gateway WebSocket (Claude).
  - `POST /api/tts` and `/api/tts/stream` → OpenAI TTS.
  - `GET /api/health`.
- **STT:** `parakeet-server` (FastAPI) with Parakeet-MLX.
- **Hosting:** Caddy reverse proxy on Tailscale, `/api/*` → bridge (:8787), `/gateway` → OpenClaw (:18789). TLS with local certs.

### What Works Well (Keep)
- **Chained pipeline** (STT → Claude → TTS) is clean and debuggable.
- **Parakeet-MLX local STT** is fast and cheap; good latency profile.
- **Bridge server** keeps secrets server-side (OpenAI key); browser is keyless.
- **Streaming chat** over SSE + incremental UI updates feels responsive.
- **Turn-taking logic**: endpointing + barge-in handling are surprisingly advanced for a V0.
- **Low surface area**: minimal infra, easy to iterate.

### Limitations / Brittleness / Pain Points
- **Single-file JS UI is brittle**: lots of state flags, no types/tests, hard to maintain.
- **No streaming STT**: transcribe after speech end only → slower and less natural.
- **Audio upload uses base64 JSON**: heavy memory/CPU overhead and latency for longer turns.
- **No echo cancellation / AEC tuning**: can get feedback / false VAD triggers.
- **No robust auth** beyond Tailscale network access.
- **Limited UX polish**: no conversation history persistence, no settings profiles, no device selection.
- **Resilience gaps**: limited retries/backoff; no offline fallback; no metrics.
- **Security posture**: local certs, manual key management, no user auth.

---

## 2. Proposed Architecture

### High-Level

```
React Native Client (iOS + Web via Expo)
  ├─ Audio Pipeline
  │   ├─ Audio Capture (expo-audio-studio / Web AudioWorklet)
  │   ├─ VAD (Silero via expo-audio-studio on native, vad-web on web)
  │   ├─ Echo Cancellation (OS-level AEC on iOS, browser AEC on web)
  │   └─ Audio Encoder (Opus for streaming, WAV fallback)
  ├─ Streaming STT → live partial transcript in editable message box
  ├─ Turn Manager (finite state machine: idle → listening → transcribing → pending_send → thinking → speaking)
  ├─ UI Layer
  │   ├─ Chat history (FlatList, virtualized)
  │   ├─ Transcript input box (editable, with Send button)
  │   ├─ Status indicators + waveform visualization
  │   └─ Slash command parser (/model, /agent, /voice, /clear)
  ├─ Audio Playback (streaming TTS chunks, queue-based)
  └─ Local Storage (SQLite via expo-sqlite for sessions, prefs)

Voice Gateway (Node/TS — single backend)
  ├─ WebSocket Server (single multiplexed connection per client)
  │   ├─ Binary frames: audio chunks (client → server)
  │   ├─ JSON frames: control messages, transcripts, LLM responses, TTS audio URLs
  │   └─ Heartbeat / keepalive
  ├─ STT Router
  │   ├─ Parakeet-MLX (local, streaming via chunked HTTP)
  │   └─ Cloud fallback: Deepgram / AssemblyAI (streaming WebSocket)
  ├─ LLM Router → OpenClaw Gateway (bring-your-own-agent compatible)
  ├─ TTS Router
  │   ├─ Kokoro-82M via mlx-audio (local, chunked HTTP)
  │   └─ OpenAI gpt-4o-mini-tts (cloud, streaming)
  ├─ Session Store (SQLite — conversations, prefs, metadata)
  └─ Auth (Tailscale network + API token)
```

### Key Architectural Decisions

**Single WebSocket connection.** All client↔server communication flows over one multiplexed WebSocket. Binary frames carry audio; JSON frames carry everything else (control, transcripts, LLM tokens, TTS audio metadata). This eliminates HTTP overhead for audio, enables true bidirectional streaming, and simplifies connection management. The alternative (separate HTTP endpoints for STT/chat/TTS) adds latency at each hop and complicates barge-in coordination.

**Message-type protocol.** Every JSON frame has a `type` field that routes it through the system:

```typescript
// Client → Server
type ClientMessage =
  | { type: 'audio'; }              // (binary frame — raw audio chunk)
  | { type: 'transcript_send'; text: string }  // user sends/edits transcript
  | { type: 'command'; name: string; args: string[] }  // slash command
  | { type: 'barge_in' }            // user interrupted TTS
  | { type: 'cancel' }              // cancel current LLM generation
  | { type: 'ping' }

// Server → Client
type ServerMessage =
  | { type: 'transcript_partial'; text: string; isFinal: boolean }
  | { type: 'transcript_final'; text: string }
  | { type: 'llm_token'; token: string }
  | { type: 'llm_done'; fullText: string }
  | { type: 'tts_chunk'; audio: string; format: 'opus' | 'wav'; index: number }
  | { type: 'tts_done' }
  | { type: 'turn_state'; state: TurnState }
  | { type: 'error'; code: string; message: string; recoverable: boolean }
  | { type: 'command_result'; name: string; result: any }
  | { type: 'pong' }
```

**Explicit turn state machine.** Both client and server track the same state machine. Server is authoritative; client can optimistically transition but reconciles on `turn_state` messages:

```
         ┌──────────────────────────────────────────────┐
         │                                              │
         v                                              │
       IDLE ──(VAD start)──> LISTENING ──(VAD end)──> TRANSCRIBING
         ^                      │                        │
         │                      │(barge-in)              │
         │                      v                        v
         │                   IDLE ◄──(cancel)      PENDING_SEND
         │                                              │
         │                                     (auto/manual send)
         │                                              │
         │                                              v
         │                                          THINKING
         │                                              │
         │                                              v
         │                                          SPEAKING
         │                                              │
         │                        (TTS done / barge-in) │
         └──────────────────────────────────────────────┘
```

States:
- **IDLE**: Not listening, not processing. Mic may be hot but VAD hasn't triggered.
- **LISTENING**: VAD has detected speech. Audio chunks streaming to server.
- **TRANSCRIBING**: VAD endpoint detected. Server running STT on buffered audio. Partial transcripts flowing to client.
- **PENDING_SEND**: Final transcript displayed in editable message box. User can edit and manually send, or auto-send fires after configurable delay (default: 1.5s, 0 = instant auto-send).
- **THINKING**: Transcript sent to LLM. Tokens streaming back.
- **SPEAKING**: TTS audio playing. Barge-in returns to IDLE.

**PENDING_SEND with auto-send timer** is the key UX innovation: it gives users the option to review/edit the transcript while keeping the hands-free flow fast. The timer is configurable — power users set it to 0 for instant send; careful users increase it.

**Streaming audio as binary WebSocket frames.** Audio is captured, encoded as Opus (16kHz mono), and sent as binary WebSocket frames in real-time during LISTENING state. No base64, no JSON wrapping, no HTTP round-trips. This cuts latency and memory overhead dramatically vs. the current batch-upload approach.

**Audio playback queue.** TTS responses arrive as a stream of audio chunks. The client maintains a playback queue that starts playing the first chunk as soon as it arrives (don't wait for the full response). Each chunk is an independently decodable audio segment. This gives perceived instant response — the user hears the first words while the rest is still generating.

### Key Changes from V0
- **Streaming STT** instead of batch: audio chunks stream over WebSocket, partial transcripts render live into an editable message box.
- **Editable transcript + configurable auto-send**: user reviews/edits before send, or auto-send fires after delay.
- **React Native** for iOS (background audio, lock-screen controls) + web via Expo Web.
- **Pluggable TTS**: Kokoro (local, free) or OpenAI (cloud) — swap via settings, same gateway interface.
- **Explicit turn state machine** shared between client and server, replacing ad-hoc state flags.
- **Single WebSocket** with multiplexed binary/JSON frames replaces multiple HTTP endpoints.
- **Slash commands** in transcript: `/model`, `/agent`, `/voice`, `/clear` detected and executed.
- **OpenClaw Gateway** as LLM backend, designed for bring-your-own-agent compatibility.
- **Session persistence** with conversation history, search, and export.
- **Audio playback queue** for streaming TTS with instant first-chunk playback.

---

## 3. Platform Decision

**React Native (Expo Dev Client) + Expo Web**

Rationale:
- Background audio + lock-screen controls on iOS (PWA can't do this reliably)
- Web/desktop works fine via Expo Web — no backgrounding issue there
- One codebase for iOS + web
- Native modules available for low-level audio (VAD, streaming capture, AEC)
- Expo Dev Client allows native module access without ejecting

### Audio Library Selection

**Primary recommendation: `@siteed/expo-audio-studio`** (formerly expo-audio-stream)
- Production-tested, actively maintained (2025), Expo-native
- Built-in VAD (Silero), streaming recording, feature extraction
- Supports iOS, Android, and Web
- Provides raw PCM data callbacks — can pipe directly to WebSocket
- Has companion UI package (`@siteed/expo-audio-ui`) for waveform visualization

**Fallback / alternative: `expo-audio-streaming`** (IhorPeresunko)
- Simpler API, focused specifically on streaming mic → WebSocket
- Good if expo-audio-studio proves too heavy

**Web platform: `vad-web`** (Silero WASM) + Web Audio API
- `AudioWorklet` for streaming capture with minimal latency
- Browser-native AEC via `echoCancellation: true` on `getUserMedia`

### Native iOS Modules Needed
- Background audio session management (`AVAudioSession` category `.playAndRecord`)
- Lock-screen / Control Center controls (via `MPNowPlayingInfoCenter`)
- Hardware echo cancellation configuration

---

## 4. Features (Single MVP Build)

### Core Voice Pipeline
- **Audio capture** with configurable sample rate (16kHz for STT, 24kHz for high-quality recording)
- **VAD** (Silero) with tunable sensitivity: speech start threshold, speech end padding, min speech duration
- **Echo cancellation**: OS-level AEC on iOS (via `AVAudioSession`), browser AEC on web (`echoCancellation` constraint)
- **Streaming STT** with partial transcript rendering — text appears word-by-word in the message box
- **Editable transcript message box** with configurable auto-send timer (0–10s, default 1.5s)
- **Manual send** option: tap Send button or press Enter to send immediately
- **LLM streaming** via OpenClaw Gateway with token-by-token rendering
- **Streaming TTS playback** with audio chunk queue — first words play while rest generates
- **Barge-in**: speaking while TTS plays stops playback, transitions to LISTENING
- **Cancel**: explicit cancel button stops LLM generation mid-stream

### Slash Commands
Detected in the transcript message box before sending. Syntax: `/command [args]`

| Command | Action |
|---------|--------|
| `/model <name>` | Switch LLM model (e.g., `/model opus`, `/model sonnet`) |
| `/agent <name>` | Switch agent/persona |
| `/voice <name>` | Switch TTS voice |
| `/tts <provider>` | Switch TTS provider (kokoro / openai) |
| `/stt <provider>` | Switch STT provider (parakeet / cloud) |
| `/clear` | Clear conversation history (with confirmation) |
| `/export` | Export conversation as JSON/markdown |
| `/help` | Show available commands |

Commands are intercepted client-side, sent as `command` messages to the server, and results displayed inline in chat.

### UI / UX
- **Chat history**: scrollable list with message bubbles (user + assistant), virtualized for performance
- **Message input area**: dual-mode — voice (waveform + transcript box) or text (standard keyboard input)
- **Waveform visualization**: real-time audio level display during capture (mini waveform bar)
- **Status indicators**: clear visual states for each turn phase (listening 🎤, transcribing ✍️, thinking 🧠, speaking 🔊)
- **Voice/text toggle**: tap mic icon to switch between voice and text input
- **Settings panel**: TTS provider/voice, STT provider, auto-send timer, VAD sensitivity, theme
- **Device selection**: choose audio input/output device (especially important for web with multiple devices)
- **Mic test**: record and playback to verify audio is working before a session
- **Conversation list**: sidebar/drawer showing past conversations with search
- **Haptic feedback** (iOS): subtle haptics on turn transitions (start listening, start speaking)

### Session Management
- **Auto-save**: every conversation persisted to SQLite automatically
- **Conversation metadata**: title (auto-generated from first exchange), created/updated timestamps, message count
- **Search**: full-text search across conversation history
- **Export**: download conversation as JSON or Markdown
- **Delete**: delete individual conversations or bulk clear

### Error Handling & Resilience
- **Connection loss recovery**: WebSocket auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s). During disconnect, buffer audio locally and show "Reconnecting..." status. On reconnect, resume session from last known state.
- **STT fallback**: if Parakeet is unreachable (timeout 3s), automatically fall back to cloud STT. Show subtle indicator that cloud STT is active. Fall back to local when it recovers.
- **TTS fallback**: if Kokoro is unreachable, fall back to OpenAI TTS (and vice versa if cloud is down and local is available).
- **LLM timeout**: if no tokens received within 15s of sending, show "Still thinking..." indicator. At 30s, offer retry button. Don't auto-retry LLM calls (they may have side effects via tool use).
- **Audio permission denied**: clear explanation + deep-link to OS settings
- **Graceful degradation**: if all STT fails, fall back to text-only input. If all TTS fails, show text response without audio. App remains usable in text-only mode.
- **Corrupt audio handling**: validate audio chunks before sending (check for silence, clipping, invalid format). Drop corrupted chunks silently rather than crashing the pipeline.
- **Rate limiting**: client-side debounce on rapid send attempts. Server-side per-session rate limit on LLM calls (configurable, default 30/min).

---

## 5. Tech Stack

### Client
- **Framework:** React Native (Expo Dev Client) + Expo Web
- **Audio Capture:** `@siteed/expo-audio-studio` (native) / Web Audio API + AudioWorklet (web)
- **VAD:** Silero via expo-audio-studio (native) / `@ricky0123/vad-web` (web)
- **Audio Encoding:** Opus via native encoder / `libopus.js` (web) — with WAV fallback
- **Audio Playback:** `expo-av` with streaming queue manager
- **State Management:** Zustand — turn state machine + UI state + preferences
- **Local Storage:** `expo-sqlite` for conversations + `expo-secure-store` for tokens
- **Transport:** Single WebSocket connection (binary + JSON frames)
- **UI Components:** React Native core + custom waveform component (canvas/SVG)
- **Navigation:** Expo Router (file-based routing)

### Backend (Voice Gateway)
- **Runtime:** Node.js + TypeScript
- **HTTP/WS Server:** Fastify + `@fastify/websocket` (faster than Express, schema validation built-in)
- **Session Store:** SQLite via `better-sqlite3` (synchronous, fast, zero-config)
- **Auth:** Tailscale network ACL + bearer token header
- **Logging:** `pino` (structured JSON, Fastify-native)
- **Process Manager:** PM2 or systemd for production

### Voice Stack
- **STT (Local):** Parakeet-MLX — FastAPI server on Apple Silicon, accessed over Tailscale
  - Input: WAV/PCM audio chunks via HTTP POST
  - Output: JSON with transcript + confidence + word timestamps
  - Streaming: chunked transfer encoding (send audio incrementally, receive partial transcripts)
- **STT (Cloud Fallback):** Deepgram Nova-3 (streaming WebSocket, excellent accuracy, low latency)
- **LLM:** OpenClaw Gateway — WebSocket connection, bring-your-own-agent compatible
  - Supports streaming token delivery
  - Handles tool use, system prompts, conversation context
- **TTS (Local):** Kokoro-82M via mlx-audio server — FastAPI on Apple Silicon, accessed over Tailscale
  - Input: text string + voice name
  - Output: WAV/PCM audio (streamed as chunks for long responses)
  - Sentence-level chunking: gateway splits LLM output at sentence boundaries, sends each sentence to TTS independently for pipeline parallelism
- **TTS (Cloud):** OpenAI `gpt-4o-mini-tts`
  - Input: text + voice + instructions
  - Output: streaming audio (Opus or PCM)

### Sentence-Level TTS Pipelining

This is the critical latency optimization. Rather than waiting for the full LLM response before starting TTS:

```
LLM tokens streaming: "Hello! I'd be happy to help. Let me think about that."
                       ↓ sentence boundary detected
                       "Hello!" → TTS immediately
                                  ↓ next sentence
                                  "I'd be happy to help." → TTS
                                                             ↓ next sentence
                                                             "Let me think about that." → TTS
```

The gateway maintains a sentence buffer. As LLM tokens arrive, it accumulates text until a sentence boundary (`.`, `!`, `?`, or `\n` followed by a capital letter / end of stream). Each complete sentence is dispatched to TTS immediately. TTS audio chunks are sent to the client as they're generated. The client's playback queue handles ordering.

This means the user hears the first sentence of the response while the LLM is still generating the rest. For a typical 3-sentence response, this can cut perceived latency by 60-70%.

---

## 6. Security

### Authentication & Authorization
- **Network layer:** Tailscale ACLs restrict access to the Voice Gateway to authorized devices only
- **Application layer:** Bearer token in WebSocket handshake headers. Token stored in `expo-secure-store` on iOS, `localStorage` (encrypted if available) on web
- **Token management:** Tokens generated by the gateway, long-lived (30 days), revocable
- **No user accounts in MVP** — single-user, token is the identity

### Data Protection
- **Audio data:** Never persisted on the server beyond the processing pipeline. Audio chunks are held in memory only during STT processing, then discarded
- **Conversation history:** Stored in SQLite on both client (for offline access) and server (for session continuity). Server-side data at rest is on the Tailscale-protected machine
- **API keys:** All third-party keys (OpenAI, Deepgram) stored server-side only. Client never sees them
- **Token storage:** `expo-secure-store` on iOS (Keychain), `SecureStore` equivalent or encrypted localStorage on web

### Transport Security
- **Tailscale WireGuard:** All traffic encrypted end-to-end via Tailscale's WireGuard tunnels
- **WebSocket over TLS:** WSS only, no plain WS
- **No external exposure:** Voice Gateway not exposed to the public internet

---

## 7. Notes on Commercial Assistants (Design Reference)

Key patterns observed in Siri, Google Assistant, Alexa, ChatGPT Voice:
- **Streaming STT + partials**: always on to reduce perceived latency.
- **Aggressive barge-in**: stop TTS immediately when user speaks. No fade-out delay.
- **Echo cancellation + noise suppression**: hardware/OS level DSP. Critical for speaker-to-mic scenarios.
- **Context persistence**: sessions stored and searchable across devices.
- **Turn prediction**: server-side endpointing models for cleaner turn boundaries.
- **Sentence-level TTS pipelining**: start speaking the first sentence before the full response is ready.
- **Conversational backchannels**: "uh-huh", "mmm" to indicate listening (future consideration).
- **Visual feedback loops**: always show state clearly — users need to know the system is listening vs. thinking.

---

## 8. Open Questions & Risks

### Technical Risks
- **Parakeet streaming support**: Current Parakeet-MLX server may not support true streaming (partial transcripts from chunked audio). May need to implement a buffer-and-reprocess approach: send accumulated audio at intervals (every 500ms), get progressively longer transcripts, diff to show new words. Verify actual Parakeet API capabilities before committing to streaming architecture.
- **Opus encoding on React Native**: `@siteed/expo-audio-studio` provides raw PCM. Need to verify Opus encoding is available or if a native module is needed. WAV fallback works but uses ~10x more bandwidth.
- **Expo Web audio latency**: Web Audio API through Expo Web may have higher latency than native. Need to benchmark AudioWorklet capture → WebSocket send latency. Target: <100ms capture-to-server.
- **Kokoro TTS chunk streaming**: mlx-audio may generate full audio before returning (not true streaming). Need to verify if sentence-level chunking gives adequate perceived responsiveness, or if we need to implement within-sentence streaming at the TTS server level.
- **Background audio on iOS**: Expo Dev Client + `expo-audio-studio` should support background audio sessions, but needs testing with the specific AVAudioSession configuration required for simultaneous record + playback.

### UX Questions
- **Auto-send timer default**: 1.5s is a guess. Need user testing. Should probably be 0 (instant) for voice-native users and configurable up for accuracy-conscious users.
- **Barge-in sensitivity**: How quickly should TTS stop? Immediate on any VAD trigger risks false positives (cough, background noise). Consider a short confirmation window (~200ms) before killing TTS.
- **Keyboard vs. voice switching**: should the app default to voice mode on open, or remember last-used mode?

---

## 9. Future (Not in MVP)
- Offline mode: local STT + local TTS (both fully on-device)
- Wake-word + hands-free always-on mode
- Personal voice profiles (custom Kokoro voice fine-tuning)
- Multi-device sync (conversations across iPhone + Mac)
- Advanced AEC / noise reduction (RNNoise, custom DSP)
- ElevenLabs TTS integration
- Latency telemetry dashboard
- Multi-user support
- Bring-your-own-agent config UI (connect to any OpenAI-compatible API)
- Conversation branching (fork from any message)
- Voice shortcuts / macros (custom slash commands)
- Audio message mode (send voice notes without STT, like WhatsApp)
- Accessibility: VoiceOver/TalkBack integration, high-contrast mode
