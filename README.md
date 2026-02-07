# Voice Chat

A real-time voice conversation interface for LLMs. Speak naturally, get spoken responses. The system chains Voice Activity Detection → Speech-to-Text → LLM → Text-to-Speech with streaming at every stage.

Built as a monorepo with an Expo/React Native web client and a Fastify WebSocket gateway.

## Architecture

```
┌─────────────────────────────────────────┐
│           Client (Expo Web)             │
│                                         │
│  Mic → VAD (Silero) → Audio Capture     │
│           │                             │
│           │ binary frames (WAV)         │
│           ▼                             │
│  ┌─────────────────────────────────┐    │
│  │     WebSocket (single conn)     │◄───┤── JSON: turn_state, transcripts,
│  └─────────────┬───────────────────┘    │       LLM tokens, TTS meta
│                │                        │
│  Audio Playback ◄── binary: TTS audio   │
│  (Web Audio API, queue-based)           │
└─────────────────────────────────────────┘
                 │
                 │ ws://gateway:8788/ws
                 ▼
┌─────────────────────────────────────────┐
│         Gateway (Fastify + WS)          │
│                                         │
│  Turn State Machine (per connection)    │
│  idle → listening → transcribing →      │
│  pending_send → thinking → speaking     │
│                                         │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │ STT      │ │ LLM      │ │ TTS     │ │
│  │ Router   │ │ Pipeline  │ │ Pipeline│ │
│  │          │ │          │ │         │ │
│  │ Parakeet │ │ OpenClaw │ │ Kokoro  │ │
│  │ (local)  │ │ Gateway  │ │ (local) │ │
│  │    ↕     │ │          │ │    ↕    │ │
│  │ Cloud    │ │          │ │ OpenAI  │ │
│  │ (stub)   │ │          │ │ TTS     │ │
│  └──────────┘ └──────────┘ └─────────┘ │
└─────────────────────────────────────────┘
```

The client sends audio as binary WebSocket frames. The gateway runs STT, forwards the transcript to an LLM via OpenClaw Gateway, streams tokens back while simultaneously chunking them into sentences for TTS synthesis. TTS audio is sent back as binary frames interleaved with JSON metadata.

The server is authoritative over turn state. The client can optimistically transition for responsive UI but reconciles with server-sent `turn_state` messages.

## Project Structure

```
voice-chat/
├── packages/
│   ├── client/                  # Expo/React Native app (web target)
│   │   ├── app/                 # Expo Router pages
│   │   │   ├── index.tsx        # Main voice chat screen
│   │   │   ├── settings.tsx     # Settings screen
│   │   │   └── _layout.tsx      # Root layout
│   │   ├── components/          # UI components
│   │   │   ├── VoiceButton.tsx
│   │   │   ├── ChatHistory.tsx
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── TranscriptBox.tsx
│   │   │   ├── StatusIndicator.tsx
│   │   │   └── ErrorBanner.tsx
│   │   ├── hooks/               # React hooks
│   │   │   ├── useAudioCapture.ts    # VAD + mic recording
│   │   │   ├── useAudioPlayback.ts   # Queue-based TTS playback
│   │   │   ├── useWebSocket.ts       # WS connection management
│   │   │   └── useErrorRecovery.ts   # Error state + auto-recovery
│   │   ├── stores/              # Zustand state
│   │   │   ├── turnStore.ts     # Turn state machine (client-side)
│   │   │   ├── chatStore.ts     # Chat message history
│   │   │   └── configStore.ts   # Session configuration
│   │   └── lib/
│   │       ├── types.ts         # Shared protocol types
│   │       ├── audio-utils.ts   # Float32→WAV conversion
│   │       └── debounce.ts
│   │
│   └── gateway/                 # Fastify WebSocket backend
│       └── src/
│           ├── server.ts        # Fastify app + health endpoint
│           ├── types.ts         # Protocol types (authoritative)
│           ├── ws/
│           │   ├── handler.ts       # WS connection lifecycle + message routing
│           │   ├── turn-machine.ts  # Turn state machine (EventEmitter)
│           │   ├── commands.ts      # Slash command registry
│           │   └── rate-limiter.ts  # Sliding window rate limiter
│           ├── stt/
│           │   ├── parakeet-client.ts  # Parakeet STT HTTP client
│           │   ├── router.ts           # STT provider routing + failover
│           │   └── rolling-window.ts   # Streaming STT (rolling decode)
│           ├── llm/
│           │   ├── gateway-client.ts   # OpenClaw Gateway WS client
│           │   └── pipeline.ts         # LLM streaming + phrase chunking
│           └── tts/
│               ├── kokoro-client.ts    # Kokoro TTS HTTP client (local)
│               ├── openai-client.ts    # OpenAI TTS HTTP client
│               ├── router.ts           # TTS provider routing + failover
│               ├── pipeline.ts         # Ordered chunk synthesis + delivery
│               ├── phrase-chunker.ts   # Sentence boundary detection
│               └── tts-error.ts
│
├── parakeet-server/             # Local STT server (Python/FastAPI)
│   ├── server.py
│   └── requirements.txt
├── ecosystem.config.js          # PM2 production config
├── scripts/
│   ├── build.sh
│   ├── deploy.sh
│   └── https-proxy.mjs         # HTTPS reverse proxy for Expo dev
└── REIMAGINE.md                 # Architecture spec
```

## Prerequisites

- **Node.js** ≥ 20
- **npm** (uses npm workspaces)
- **Parakeet STT server** running (see `parakeet-server/`)
- **Kokoro TTS server** running (or an OpenAI API key for cloud TTS)
- **OpenClaw Gateway** running (provides LLM access)

## Setup

```bash
# Clone and install
cd voice-chat
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your values (see Environment Variables below)
```

## Development

Two processes — gateway and client — run independently:

```bash
# Terminal 1: Start the gateway (auto-reloads via tsx watch)
npm run dev:gateway

# Terminal 2: Start the Expo dev server (web)
npm run dev:client
```

The gateway listens on `http://localhost:8788` (WebSocket at `/ws`, health at `/health`).
The client dev server starts on `http://localhost:8081` by default.

### Type Checking

```bash
# All packages
npm run typecheck

# Individual
npm run typecheck --workspace=@voice-chat/gateway
npm run typecheck --workspace=@voice-chat/client
```

### Tests

Gateway tests use Vitest:

```bash
cd packages/gateway
npm test            # Run once
npm run test:watch  # Watch mode
```

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

### Gateway Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8788` | Gateway HTTP/WS port |
| `LOG_LEVEL` | `info` | Pino log level |
| `NODE_ENV` | `development` | `development` enables pino-pretty |

### Client

| Variable | Default | Description |
|----------|---------|-------------|
| `EXPO_PUBLIC_GATEWAY_URL` | `ws://localhost:8788/ws` | Gateway WebSocket URL |

### STT (Parakeet)

| Variable | Default | Description |
|----------|---------|-------------|
| `PARAKEET_URL` | `http://100.86.69.14:8765` | Parakeet STT server URL |

### TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `KOKORO_URL` | `http://100.86.69.14:8787` | Kokoro TTS server URL |
| `OPENAI_API_KEY` | — | OpenAI API key (for cloud TTS fallback) |
| `VOICECHAT_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS model |
| `VOICECHAT_TTS_VOICE` | `nova` | Default OpenAI TTS voice |

### LLM (OpenClaw Gateway)

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICECHAT_GATEWAY_URL` | `ws://127.0.0.1:18789/gateway` | OpenClaw Gateway WS URL |
| `VOICECHAT_GATEWAY_TOKEN` | — | Auth token (also reads `OPENCLAW_GATEWAY_TOKEN` and `~/.openclaw/openclaw.json`) |
| `VOICECHAT_GATEWAY_PASSWORD` | — | Auth password (alternative to token) |
| `VOICECHAT_GATEWAY_TIMEOUT_MS` | `120000` | LLM response timeout |
| `VOICECHAT_GATEWAY_CLIENT_ID` | `webchat` | Client identifier |

## WebSocket Protocol

All communication happens over a single WebSocket connection per client. Binary frames carry audio; JSON frames carry everything else.

### Turn State Machine

```
idle → listening → transcribing → pending_send → thinking → speaking → idle
              ↘ idle       ↘ idle          ↘ idle     ↘ idle    ↘ listening (barge-in)
```

States:
- **idle** — Nothing happening. Audio frames arriving here implicitly start `listening`.
- **listening** — VAD detected speech, audio streaming to gateway.
- **transcribing** — VAD endpoint reached, running STT on buffered audio.
- **pending_send** — Transcript ready. User can edit before confirming.
- **thinking** — Transcript sent to LLM, tokens streaming back.
- **speaking** — TTS audio playing. User can barge in (→ `listening`).

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `transcript_send` | `text`, `turnId` | Send confirmed transcript to LLM |
| `command` | `name`, `args[]` | Slash command (`/model`, `/voice`, etc.) |
| `barge_in` | — | Interrupt TTS playback |
| `cancel` | — | Cancel current operation |
| `config` | `settings` (partial) | Update session config |
| `ping` | `ts` | Heartbeat (server replies `pong`) |

### Server → Client Messages

| Type | Key Fields | Description |
|------|------------|-------------|
| `transcript_partial` | `stable`, `unstable`, `text` | Live STT transcript |
| `transcript_final` | `text`, `turnId` | Final transcript after VAD endpoint |
| `llm_token` | `token`, `fullText` | Streaming LLM token |
| `llm_done` | `fullText` | LLM generation complete |
| `tts_meta` | `format`, `index`, `sampleRate`, `durationMs` | Metadata for next binary frame |
| `tts_done` | — | All TTS chunks sent |
| `turn_state` | `state`, `turnId?` | Authoritative state update |
| `error` | `code`, `message`, `recoverable` | Error with recovery hint |
| `command_result` | `name`, `result` | Slash command response |
| `pong` | `ts`, `serverTs` | Heartbeat reply with RTT data |

Binary frames (server → client) always follow a `tts_meta` JSON message and contain WAV audio.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/model <name>` | Switch LLM model |
| `/agent <name>` | Switch agent/persona |
| `/voice <name>` | Switch TTS voice |
| `/tts kokoro\|openai` | Switch TTS provider |
| `/stt parakeet\|cloud` | Switch STT provider |
| `/clear` | Clear conversation |
| `/help` | List commands |

## Tech Stack

**Client:**
- Expo 52 + React Native Web
- Expo Router (file-based routing)
- Zustand (state management)
- `@ricky0123/vad-web` (Silero VAD for voice activity detection)
- Web Audio API (TTS playback with ordered queue)

**Gateway:**
- Fastify 5 with `@fastify/websocket`
- Pino (structured logging)
- TweetNaCl (Ed25519 device identity for OpenClaw auth)
- better-sqlite3 (available for session persistence)
- Vitest (testing)

**STT:**
- Parakeet-MLX — local STT on Apple Silicon via FastAPI server
- Automatic failover with health checks (cloud stub for future Deepgram integration)

**TTS:**
- Kokoro — local TTS (primary, lowest latency)
- OpenAI TTS — cloud fallback (`gpt-4o-mini-tts`)
- Automatic failover: 3 failures in 60s triggers provider switch

**LLM:**
- OpenClaw Gateway — WebSocket-based chat with streaming, handles model routing and session management

## Production

```bash
# Build everything (gateway TypeScript + Expo web export)
./scripts/build.sh

# Start with PM2
npm start         # pm2 start ecosystem.config.js
npm stop          # pm2 stop voice-gateway
npm run logs      # pm2 logs voice-gateway

# Or deploy (build + restart)
./scripts/deploy.sh
```

PM2 config: single instance, 512MB memory limit, logs in `./logs/`.

