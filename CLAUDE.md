# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run in separate terminals)
npm run dev:gateway          # Gateway with auto-reload (tsx watch)
npm run dev:client           # Expo Web dev server

# Type checking
npm run typecheck            # All workspaces

# Tests (gateway only, vitest)
cd packages/gateway
npm test                     # Run all tests once
npx vitest run src/tts/__tests__/phrase-chunker.test.ts   # Single file
npm run test:watch           # Watch mode

# Build
npm run build                # All workspaces (tsc)
```

## Architecture

Monorepo with two packages: `packages/gateway` (Fastify backend) and `packages/client` (Expo Web frontend), connected by npm workspaces.

### Protocol

Single multiplexed WebSocket per client. Binary frames carry audio; JSON frames carry control messages. The protocol types are defined authoritatively in `packages/gateway/src/types.ts` — the client has a **manually copied** duplicate at `packages/client/lib/types.ts` (not imported).

### Turn State Machine

Server-authoritative state machine governs conversation flow. The client mirrors state optimistically via Zustand but reconciles on `turn_state` messages from the server.

```
idle → listening → transcribing → pending_send → thinking → speaking → idle
```

- `listening`: VAD detected speech, audio streaming to server
- `transcribing`: VAD endpoint reached, STT processing
- `pending_send`: Transcript ready, user can edit before auto-send (default 1500ms)
- `thinking`: LLM streaming tokens
- `speaking`: TTS audio playing (barge-in interrupts)

Server implementation: `packages/gateway/src/ws/handler.ts` (orchestration) + `packages/gateway/src/ws/turn-machine.ts` (state machine).
Client implementation: `packages/client/stores/turnStore.ts` (Zustand store).

### Streaming Pipeline

The critical latency optimization is **sentence-level TTS pipelining**: as the LLM streams tokens, the `PhraseChunker` detects sentence boundaries and emits completed phrases to the TTS pipeline immediately. TTS synthesizes chunks in parallel (max 2) but sends them to the client in strict order. This means audio playback starts before LLM generation finishes.

Pipeline flow: `llm/pipeline.ts` → `tts/phrase-chunker.ts` → `tts/pipeline.ts` → client

### Provider Fallback

Both STT and TTS have primary (local) and fallback (cloud) providers with automatic switching after consecutive failures and periodic health-check recovery:
- **STT**: Parakeet-MLX (local) → cloud stub. Threshold: 3 failures.
- **TTS**: Kokoro-82M (local) → OpenAI TTS (cloud). Threshold: 3 failures in 60s.
- **LLM**: OpenClaw Gateway via WebSocket with Ed25519 device auth.

### Client Stack

Expo Router (file-based routing in `app/`), Zustand stores (`stores/`), custom hooks for WebSocket/audio/error recovery (`hooks/`). VAD uses `@ricky0123/vad-web` (Silero model). Audio playback is queue-based with ordered chunk handling.

## Testing Notes

- Vitest v4, config: `src/**/__tests__/**/*.test.ts`, pool: forks, forceExit: true
- `vi.advanceTimersByTimeAsync` doesn't fully flush async callbacks from `setInterval` — test `processDecodeResult` directly via `(stt as any)` for STT streaming tests
- All backends are mocked in tests (no real Parakeet/Kokoro/OpenClaw)

## Environment

Copy `.env.example` to `.env`. Key services: Parakeet (STT, local), Kokoro (TTS, local), OpenClaw Gateway (LLM, WebSocket). See `.env.example` for all variables.

## Spec

`REIMAGINE.md` is the authoritative architecture specification. Consult it for protocol details, state machine semantics, and design rationale.
