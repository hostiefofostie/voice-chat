# Voice Chat — Agent Workspace

## Project
Building a voice chat app (React Native Expo Web + Fastify backend) for talking to AI assistants via OpenClaw Gateway.

## Spec
- Full spec: `REIMAGINE.md` (373 lines) — the source of truth
- Original spec (V0): `SPEC.md` (reference only)

## Beads
All tasks are tracked as beads. Use `bd` CLI:
- `bd ready --json` — see what's available to work on
- `bd show <id>` — read a bead's full description
- `bd update <id> --status in_progress` — claim a bead
- `bd close <id> --reason "done"` — mark complete

## Dependencies
Beads have dependencies wired up. `bd ready` only shows unblocked beads.
When you complete a bead, new beads may become unblocked.

## Architecture
- **Backend:** `packages/gateway/` — Fastify + TypeScript, WebSocket server
- **Frontend:** `packages/client/` — Expo Web (React Native), Zustand state, hooks-based
- **Shared types** in gateway (imported by client)

## Key Patterns
- Single multiplexed WebSocket (binary frames for audio, JSON for control)
- Explicit turn state machine (idle → listening → transcribing → pending_send → thinking → speaking)
- Streaming STT with partial transcripts
- Sentence-level TTS pipelining
- Pluggable providers (STT: Parakeet/cloud, TTS: Kokoro/OpenAI)

## Rules
- Read the full bead description before starting
- Follow the acceptance criteria exactly
- Self-review your code before marking complete
- Don't modify files outside your bead's scope without coordination
