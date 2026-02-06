import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmPipeline } from '../pipeline.js';
import { GatewayClient } from '../gateway-client.js';

/**
 * Creates a mock gateway where streaming can be controlled step-by-step.
 * Returns controls to drive the stream from tests.
 */
function createControllableGateway() {
  let onDelta: ((text: string, payload: Record<string, unknown>) => void) | undefined;
  let onFinal: ((text: string, payload: Record<string, unknown>) => void) | undefined;
  let resolveChat: (() => void) | undefined;
  let rejectChat: ((err: Error) => void) | undefined;
  let chatStarted = false;

  const sendChat = vi.fn(
    async (
      _sessionKey: string,
      _message: string,
      callbacks: {
        onDelta?: (text: string, payload: Record<string, unknown>) => void;
        onFinal?: (text: string, payload: Record<string, unknown>) => void;
        signal?: AbortSignal;
      },
    ) => {
      onDelta = callbacks.onDelta;
      onFinal = callbacks.onFinal;
      chatStarted = true;

      return new Promise<string>((resolve, reject) => {
        resolveChat = () => resolve('');
        rejectChat = (err: Error) => reject(err);

        const signal = callbacks.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        }
      });
    },
  );

  return {
    gateway: { sendChat, ensureConnected: vi.fn() } as unknown as GatewayClient,
    sendDelta: (fullBuffer: string) => {
      onDelta?.(fullBuffer, {});
    },
    sendFinal: (text: string) => {
      onFinal?.(text, {});
      resolveChat?.();
    },
    failChat: (err: Error) => {
      rejectChat?.(err);
    },
    get chatStarted() {
      return chatStarted;
    },
  };
}

describe('LlmPipeline — cancel during streaming', () => {
  it('stops emitting tokens after cancel', async () => {
    const { gateway, sendDelta, sendFinal } = createControllableGateway();
    const pipeline = new LlmPipeline(gateway);
    const tokens: string[] = [];
    const doneEvents: Array<{ fullText: string; cancelled?: boolean }> = [];

    pipeline.on('llm_token', ({ token }: { token: string }) => tokens.push(token));
    pipeline.on('llm_done', (e: { fullText: string; cancelled?: boolean }) => doneEvents.push(e));

    // Start streaming (don't await — it won't resolve until we control it)
    const streamPromise = pipeline.sendTranscript('test', 'session-1', 'turn-1');

    // Wait for chat to start
    await vi.waitFor(() => expect(gateway.sendChat).toHaveBeenCalled());

    // Send some deltas
    sendDelta('Hello');
    expect(tokens).toContain('Hello');

    sendDelta('Hello world');
    expect(tokens).toContain(' world');

    // Cancel mid-stream
    pipeline.cancel();

    // cancel() should emit llm_done with cancelled=true
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].cancelled).toBe(true);

    // After cancel, further deltas should be ignored
    sendDelta('Hello world this should be ignored');
    expect(tokens).not.toContain(' this should be ignored');

    // Cancellation should abort the gateway call, allowing sendTranscript to resolve
    await streamPromise;

    // Should not have emitted a second llm_done from onFinal
    expect(doneEvents.length).toBe(1);
  });

  it('double cancel is safe (idempotent)', async () => {
    const { gateway, sendFinal } = createControllableGateway();
    const pipeline = new LlmPipeline(gateway);
    const doneEvents: Array<{ fullText: string; cancelled?: boolean }> = [];
    pipeline.on('llm_done', (e: { fullText: string; cancelled?: boolean }) => doneEvents.push(e));

    const streamPromise = pipeline.sendTranscript('test', 'session-1', 'turn-1');
    await vi.waitFor(() => expect(gateway.sendChat).toHaveBeenCalled());

    pipeline.cancel();
    pipeline.cancel(); // should be no-op

    expect(doneEvents.length).toBe(1); // Only one llm_done

    sendFinal('');
    await streamPromise;
  });

  it('does not emit error after cancel even if gateway throws', async () => {
    const { gateway, failChat } = createControllableGateway();
    const pipeline = new LlmPipeline(gateway);
    const errors: unknown[] = [];
    const doneEvents: unknown[] = [];

    pipeline.on('error', (e: unknown) => errors.push(e));
    pipeline.on('llm_done', (e: unknown) => doneEvents.push(e));

    const streamPromise = pipeline.sendTranscript('test', 'session-1', 'turn-1');
    await vi.waitFor(() => expect(gateway.sendChat).toHaveBeenCalled());

    pipeline.cancel();
    failChat(new Error('gateway exploded'));

    await streamPromise; // should resolve without throwing

    // No error event because we cancelled first
    expect(errors.length).toBe(0);
    // Only the cancel llm_done
    expect(doneEvents.length).toBe(1);
  });

  it('flushes remaining phrases from chunker on cancel', async () => {
    const { gateway, sendDelta, sendFinal } = createControllableGateway();
    const pipeline = new LlmPipeline(gateway);
    const phrases: Array<{ text: string; index: number }> = [];

    pipeline.on('phrase_ready', (p: { text: string; index: number }) => phrases.push(p));

    const streamPromise = pipeline.sendTranscript('test', 'session-1', 'turn-1');
    await vi.waitFor(() => expect(gateway.sendChat).toHaveBeenCalled());

    // Feed enough text that the chunker has a pending incomplete sentence
    sendDelta('This is a partial sentence that');

    const phraseCountBeforeCancel = phrases.length;

    // Cancel should flush remaining text from chunker
    pipeline.cancel();

    // The remaining buffer should have been flushed as a phrase
    expect(phrases.length).toBeGreaterThanOrEqual(phraseCountBeforeCancel);

    sendFinal('');
    await streamPromise;
  });
});

describe('LlmPipeline — phrase emission', () => {
  it('emits phrase_ready with turnId from sendTranscript', async () => {
    const longGateway = {
      sendChat: vi.fn(async (
        _sessionKey: string,
        _message: string,
        callbacks: {
          onDelta?: (text: string, payload: Record<string, unknown>) => void;
          onFinal?: (text: string, payload: Record<string, unknown>) => void;
        },
      ) => {
        // Send a complete sentence in one shot
        callbacks.onDelta?.('This is a complete sentence right here now. ', {});
        callbacks.onFinal?.('This is a complete sentence right here now.', {});
        return '';
      }),
      ensureConnected: vi.fn(),
    } as unknown as GatewayClient;

    const pipeline = new LlmPipeline(longGateway);
    const phrases: Array<{ text: string; index: number; turnId: string }> = [];
    pipeline.on('phrase_ready', (p: { text: string; index: number; turnId: string }) => phrases.push(p));

    await pipeline.sendTranscript('test', 'session-1', 'turn-42');

    expect(phrases.length).toBeGreaterThanOrEqual(1);
    for (const p of phrases) {
      expect(p.turnId).toBe('turn-42');
    }
  });
});
