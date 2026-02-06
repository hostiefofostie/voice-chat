import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { registerWebSocket } from '../ws/handler.js';
import type { ServerMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an in-process Fastify server with WebSocket support. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 * 5 },
  });
  registerWebSocket(app);
  await app.listen({ port: 0 }); // OS-assigned port
  return app;
}

/** Get the port the server is listening on. */
function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  throw new Error('Server address is not available');
}

/** Open a WebSocket connection and wait for it to be ready. */
function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait for the next JSON message from the WebSocket. */
function nextJsonMessage(ws: WebSocket, timeoutMs = 3000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for message')),
      timeoutMs,
    );
    const handler = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return; // skip binary frames, keep waiting
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(JSON.parse(data.toString()) as ServerMessage);
    };
    ws.on('message', handler);
  });
}

/** Send a JSON message over the WebSocket. */
function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocket Integration', () => {
  let app: FastifyInstance;
  let ws: WebSocket;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
      // Wait for close to propagate so the server can clean up
      await new Promise((r) => ws.on('close', r));
    }
    await app.close();
  });

  // -----------------------------------------------------------------------
  // 1. Ping / Pong
  // -----------------------------------------------------------------------
  it('responds to ping with pong containing server timestamp', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    const clientTs = Date.now();
    sendJson(ws, { type: 'ping', ts: clientTs });

    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('pong');
    if (msg.type === 'pong') {
      expect(msg.ts).toBe(clientTs);
      expect(msg.serverTs).toBeTypeOf('number');
      expect(msg.serverTs).toBeGreaterThanOrEqual(clientTs);
    }
  });

  // -----------------------------------------------------------------------
  // 2. Slash Command (/help)
  // -----------------------------------------------------------------------
  it('executes /help command and returns command_result', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    sendJson(ws, { type: 'command', name: 'help', args: [] });

    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('command_result');
    if (msg.type === 'command_result') {
      expect(msg.name).toBe('help');
      expect(msg.result).toHaveProperty('message');
      const result = msg.result as { message: string };
      expect(result.message).toContain('Available commands');
    }
  });

  // -----------------------------------------------------------------------
  // 3. Config Update
  // -----------------------------------------------------------------------
  it('accepts config update without error', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    sendJson(ws, { type: 'config', settings: { ttsProvider: 'openai' } });

    // Config updates don't produce a response message. Verify no error
    // arrives by sending a ping immediately after — if config had errored,
    // the error would arrive before the pong.
    const pingTs = Date.now();
    sendJson(ws, { type: 'ping', ts: pingTs });

    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('pong');
  });

  // -----------------------------------------------------------------------
  // 4. Binary Audio Frame
  // -----------------------------------------------------------------------
  it('buffers binary audio frame without error', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    // Create a minimal WAV-like binary frame (44-byte header + some samples)
    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + 160, 4);   // file size - 8
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);        // fmt chunk size
    wavHeader.writeUInt16LE(1, 20);         // PCM
    wavHeader.writeUInt16LE(1, 22);         // mono
    wavHeader.writeUInt32LE(16000, 24);     // sample rate
    wavHeader.writeUInt32LE(32000, 28);     // byte rate
    wavHeader.writeUInt16LE(2, 32);         // block align
    wavHeader.writeUInt16LE(16, 34);        // bits per sample
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(160, 40);       // data size
    const samples = Buffer.alloc(160);
    const audioFrame = Buffer.concat([wavHeader, samples]);

    ws.send(audioFrame, { binary: true });

    // Sending audio in idle state triggers a transition to 'listening'.
    // We should receive a turn_state message.
    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('turn_state');
    if (msg.type === 'turn_state') {
      expect(msg.state).toBe('listening');
      expect(msg.turnId).toBeTypeOf('string');
    }

    // After the turn_state, verify no error by pinging
    const pingTs = Date.now();
    sendJson(ws, { type: 'ping', ts: pingTs });
    const pong = await nextJsonMessage(ws);
    expect(pong.type).toBe('pong');
  });

  // -----------------------------------------------------------------------
  // 5. Turn State Broadcast
  // -----------------------------------------------------------------------
  it('broadcasts turn_state when audio triggers listening', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    // Send binary audio to trigger idle -> listening
    const audioFrame = Buffer.alloc(100);
    ws.send(audioFrame, { binary: true });

    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('turn_state');
    if (msg.type === 'turn_state') {
      expect(msg.state).toBe('listening');
      expect(msg.turnId).toBeDefined();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Error Handling — Invalid JSON
  // -----------------------------------------------------------------------
  it('returns PARSE_ERROR for invalid JSON', async () => {
    const port = getPort(app);
    ws = await connectWs(port);

    ws.send('not valid json {{{');

    const msg = await nextJsonMessage(ws);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('PARSE_ERROR');
      expect(msg.message).toBe('Invalid JSON');
      expect(msg.recoverable).toBe(true);
    }
  });
});
