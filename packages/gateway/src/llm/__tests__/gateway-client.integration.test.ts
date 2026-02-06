import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';

// NOTE: gateway-client reads env vars at module load time. We set them per-test
// and dynamically import the module after vi.resetModules().

// Suppress known "Gateway connection closed" unhandled rejections that
// arise from WebSocket close events firing asynchronously after tests clean
// up.  The gateway-client's reconnect logic handles these, but the close
// event can fire after vitest's test boundary, causing a spurious error.
const suppressedErrors: Error[] = [];
function suppressHandler(err: Error) {
  if (err?.message === 'Gateway connection closed' || err?.message === 'Client is closed') {
    suppressedErrors.push(err);
    return;
  }
}
process.on('unhandledRejection', suppressHandler);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const addr = wss.address();
  if (typeof addr === 'string' || addr === null) throw new Error('bad addr');
  const port = addr.port;
  const url = `ws://127.0.0.1:${port}`;
  return { wss, url };
}

describe('GatewayClient (integration)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects via connect.challenge handshake and emits connection states', async () => {
    const { wss, url } = await createServer();

    // Gateway behavior: challenge first, then respond to connect req.
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce' },
      }));

      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'req' && frame.method === 'connect') {
          ws.send(JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {},
          }));
        }
      });
    });

    vi.resetModules();
    process.env.VOICECHAT_GATEWAY_ALLOW_INSECURE = '1';
    process.env.VOICECHAT_GATEWAY_URL = url;
    process.env.VOICECHAT_GATEWAY_TIMEOUT_MS = '5000';

    const { GatewayClient } = await import('../gateway-client.js');

    const client = new GatewayClient();
    const states: string[] = [];
    const unsubscribe = client.onConnectionState((s) => states.push(s));

    await client.ensureConnected();

    expect(states).toContain('connecting');
    expect(states).toContain('connected');

    unsubscribe();
    client.close();
    wss.close();
  });

  it('streams chat deltas and final text via chat events', async () => {
    const { wss, url } = await createServer();

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce' },
      }));

      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());

        if (frame.type === 'req' && frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
          return;
        }

        if (frame.type === 'req' && frame.method === 'chat.send') {
          const runId = 'run-1';
          const sessionKey = frame.params?.sessionKey || 'default';

          ws.send(JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { runId },
          }));

          // Send delta frames in a couple different payload formats.
          ws.send(JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey,
              state: 'delta',
              message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
            },
          }));

          ws.send(JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey,
              state: 'delta',
              // Alternate format: delta field
              delta: { role: 'assistant', delta: { type: 'text', text: 'Hello world' } },
            },
          }));

          ws.send(JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey,
              state: 'final',
              done: true,
              message: { role: 'assistant', content: 'Hello world.' },
            },
          }));
        }
      });
    });

    vi.resetModules();
    process.env.VOICECHAT_GATEWAY_ALLOW_INSECURE = '1';
    process.env.VOICECHAT_GATEWAY_URL = url;
    process.env.VOICECHAT_GATEWAY_TIMEOUT_MS = '5000';

    const { GatewayClient } = await import('../gateway-client.js');

    const client = new GatewayClient();

    const deltas: string[] = [];
    const finals: string[] = [];

    const finalText = await client.sendChat('session-1', 'hi', {
      onDelta: (text) => deltas.push(text),
      onFinal: (text) => finals.push(text),
    });

    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[deltas.length - 1]).toContain('Hello');
    expect(finals[0]).toBe('Hello world.');
    expect(finalText).toBe('Hello world.');

    client.close();
    wss.close();
  });

  it('supports local abort signal to stop waiting for stream completion', async () => {
    const { wss, url } = await createServer();

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce' },
      }));

      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'req' && frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
          return;
        }

        if (frame.type === 'req' && frame.method === 'chat.send') {
          ws.send(JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { runId: 'run-2' },
          }));
          // Never send final — caller should abort.
          ws.send(JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId: 'run-2',
              sessionKey: frame.params?.sessionKey || 'default',
              state: 'delta',
              message: { role: 'assistant', content: 'Hello' },
            },
          }));
        }
      });
    });

    vi.resetModules();
    process.env.VOICECHAT_GATEWAY_ALLOW_INSECURE = '1';
    process.env.VOICECHAT_GATEWAY_URL = url;
    process.env.VOICECHAT_GATEWAY_TIMEOUT_MS = '5000';

    const { GatewayClient } = await import('../gateway-client.js');

    const client = new GatewayClient();

    const ac = new AbortController();
    const promise = client.sendChat('session-1', 'hi', {
      signal: ac.signal,
    });

    // Abort immediately after the run is started.
    ac.abort();

    await expect(promise).rejects.toThrow(/aborted/i);

    client.close();
    wss.close();
  });

  it('rejects pending runs on disconnect', async () => {
    const { wss, url } = await createServer();

    let serverSocketClosed = false;

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));

      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'req' && frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
          return;
        }

        if (frame.type === 'req' && frame.method === 'chat.send') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { runId: 'run-3' } }));
          // Immediately close the socket to simulate gateway crash.
          ws.close();
          serverSocketClosed = true;
        }
      });
    });

    vi.resetModules();
    process.env.VOICECHAT_GATEWAY_ALLOW_INSECURE = '1';
    process.env.VOICECHAT_GATEWAY_URL = url;
    process.env.VOICECHAT_GATEWAY_TIMEOUT_MS = '5000';

    const { GatewayClient } = await import('../gateway-client.js');

    const client = new GatewayClient();

    const promise = client.sendChat('session-1', 'hi');

    await vi.waitFor(() => expect(serverSocketClosed).toBe(true));

    await expect(promise).rejects.toThrow(/closed|disconnected/i);

    // Close the client first to cancel reconnect timers, then close the server.
    // Close the server first so that if a reconnect is already in-flight,
    // it will fail to connect rather than establishing a session that then
    // gets orphaned.
    client.close();
    wss.close();
    // Allow any pending microtasks / async close handlers to settle so they
    // don't leak as unhandled rejections after the test finishes.
    await sleep(200);
  });
});

// Clean up the global unhandledRejection handler after all tests complete
afterAll(() => {
  process.off('unhandledRejection', suppressHandler);
});
