import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmPipeline } from '../pipeline.js';
import { GatewayClient } from '../gateway-client.js';

function createMockGateway(responses: { deltas: string[]; final: string }) {
  const sendChat = vi.fn(
    async (
      _sessionKey: string,
      _message: string,
      callbacks: { onDelta?: (text: string, payload: Record<string, unknown>) => void; onFinal?: (text: string, payload: Record<string, unknown>) => void },
    ) => {
      let buffer = '';
      for (const delta of responses.deltas) {
        buffer += delta;
        callbacks.onDelta?.(buffer, {});
        // Yield to event loop to simulate streaming
        await new Promise((r) => setTimeout(r, 1));
      }
      callbacks.onFinal?.(responses.final || buffer, {});
      return responses.final || buffer;
    },
  );

  return { sendChat, ensureConnected: vi.fn() } as unknown as GatewayClient;
}

describe('LlmPipeline', () => {
  let gateway: GatewayClient;
  let pipeline: LlmPipeline;

  beforeEach(() => {
    gateway = createMockGateway({
      deltas: ['Hello', ' world', '.'],
      final: 'Hello world.',
    });
    pipeline = new LlmPipeline(gateway);
  });

  it('emits llm_token events for each delta', async () => {
    const tokens: string[] = [];
    pipeline.on('llm_token', ({ token }: { token: string }) => tokens.push(token));

    await pipeline.sendTranscript('test', 'session-1', 'turn-1');

    expect(tokens).toEqual(['Hello', ' world', '.']);
  });

  it('emits llm_done with full text', async () => {
    const doneHandler = vi.fn();
    pipeline.on('llm_done', doneHandler);

    await pipeline.sendTranscript('test', 'session-1', 'turn-1');

    expect(doneHandler).toHaveBeenCalledWith(
      expect.objectContaining({ fullText: 'Hello world.' }),
    );
  });

  it('emits phrase_ready events from PhraseChunker', async () => {
    // Use a longer response that produces phrases
    const longGateway = createMockGateway({
      deltas: [
        'This is a longer sentence. ',
        'And here is another sentence. ',
      ],
      final: 'This is a longer sentence. And here is another sentence.',
    });
    const longPipeline = new LlmPipeline(longGateway);

    const phrases: Array<{ text: string; index: number }> = [];
    longPipeline.on('phrase_ready', (p: { text: string; index: number }) => phrases.push(p));

    await longPipeline.sendTranscript('test', 'session-1', 'turn-1');

    expect(phrases.length).toBeGreaterThanOrEqual(1);
    // All phrases should have turnId context
    for (const phrase of phrases) {
      expect(phrase.text.length).toBeGreaterThan(0);
      expect(phrase.index).toBeTypeOf('number');
    }
  });

  it('prepends [[voice]] instruction to message', async () => {
    await pipeline.sendTranscript('hello there', 'session-1', 'turn-1');

    expect(gateway.sendChat).toHaveBeenCalledWith(
      'session-1',
      '[[voice]] Be brief.\nhello there',
      expect.any(Object),
    );
  });

  it('emits error event on gateway failure', async () => {
    const failGateway = {
      sendChat: vi.fn(async () => {
        throw new Error('Gateway down');
      }),
      ensureConnected: vi.fn(),
    } as unknown as GatewayClient;

    const failPipeline = new LlmPipeline(failGateway);
    const errorHandler = vi.fn();
    failPipeline.on('error', errorHandler);

    await failPipeline.sendTranscript('test', 'session-1', 'turn-1');

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        turnId: 'turn-1',
      }),
    );
  });

  it('cancel emits llm_done with cancelled flag', () => {
    // Start a pipeline but cancel before it finishes
    const doneHandler = vi.fn();
    pipeline.on('llm_done', doneHandler);

    pipeline.cancel();

    expect(doneHandler).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
    );
  });

  it('resets internal state between calls', async () => {
    const tokens1: string[] = [];
    const listener1 = ({ token }: { token: string }) => tokens1.push(token);
    pipeline.on('llm_token', listener1);
    await pipeline.sendTranscript('first', 'session-1', 'turn-1');
    pipeline.off('llm_token', listener1);

    // Second call should start fresh (no leftover accumulated text)
    const tokens2: string[] = [];
    pipeline.on('llm_token', ({ token }: { token: string }) => tokens2.push(token));
    await pipeline.sendTranscript('second', 'session-1', 'turn-2');

    expect(tokens2).toEqual(['Hello', ' world', '.']);
  });
});
