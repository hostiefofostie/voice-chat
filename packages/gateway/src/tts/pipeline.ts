import { EventEmitter } from 'events';
import { TtsRouter } from './router.js';
import { ServerMessage } from '../types.js';

interface TtsPipelineOptions {
  ttsRouter: TtsRouter;
  sendJson: (msg: ServerMessage) => void;
  sendBinary: (data: Buffer) => void;
  maxParallel?: number;
}

export class TtsPipeline extends EventEmitter {
  private ttsRouter: TtsRouter;
  private sendJson: (msg: ServerMessage) => void;
  private sendBinary: (data: Buffer) => void;
  private maxParallel: number;
  private pendingChunks: Map<number, { text: string; turnId: string }> = new Map();
  private nextSendIndex: number = 0;
  private completedAudio: Map<number, Buffer> = new Map();
  private failedChunks: Set<number> = new Set();
  private failedTotal: number = 0;
  private totalChunks: number = 0;
  private inFlight: number = 0;
  private cancelled: boolean = false;
  // Generation counter — incremented on reset() so stale in-flight synthesis
  // from a previous turn does not corrupt state (e.g. decrementing inFlight
  // below zero after reset set it to 0).
  private generation: number = 0;

  // Event-driven drain: resolved when all chunks are settled (completed or failed)
  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TtsPipelineOptions) {
    super();
    this.ttsRouter = options.ttsRouter;
    this.sendJson = options.sendJson;
    this.sendBinary = options.sendBinary;
    this.maxParallel = options.maxParallel || 2;
  }

  async processChunk(text: string, index: number, turnId: string) {
    if (this.cancelled) return;
    this.totalChunks = Math.max(this.totalChunks, index + 1);
    this.pendingChunks.set(index, { text, turnId });
    await this.dispatch();
  }

  async finish() {
    await this.drainAll();
    if (!this.cancelled) {
      if (this.totalChunks > 0 && this.failedTotal === this.totalChunks) {
        this.emit('all_failed');
      }
      this.sendJson({ type: 'tts_done' });
      this.emit('done');
    }
  }

  cancel() {
    this.cancelled = true;
    this.pendingChunks.clear();
    this.completedAudio.clear();
    this.sendJson({ type: 'tts_done' });
    this.resolveDrain();
    this.emit('cancelled');
  }

  reset() {
    this.pendingChunks.clear();
    this.completedAudio.clear();
    this.failedChunks.clear();
    this.failedTotal = 0;
    this.totalChunks = 0;
    this.nextSendIndex = 0;
    this.inFlight = 0;
    this.cancelled = false;
    this.generation++;
    this.resolveDrain();
  }

  private async dispatch() {
    for (const [index, chunk] of this.pendingChunks) {
      if (this.inFlight >= this.maxParallel) break;
      if (this.cancelled) break;

      this.pendingChunks.delete(index);
      this.inFlight++;

      this.synthesizeAndQueue(chunk.text, index).catch(err => {
        this.emit('error', err);
      });
    }
  }

  private async synthesizeAndQueue(text: string, index: number) {
    const gen = this.generation;
    try {
      const { audio } = await this.ttsRouter.synthesize(text);
      // If cancel()+reset() happened while synthesis was in-flight, this result
      // belongs to a stale turn.  Ignore it — reset() already zeroed inFlight.
      if (gen !== this.generation) return;
      this.completedAudio.set(index, audio);
    } catch (err) {
      if (gen !== this.generation) return;
      // TtsRouter already tried fallback provider internally.
      // If we get here, both providers failed for this chunk.
      this.failedChunks.add(index);
      this.failedTotal++;
      this.emit('error', err);
    } finally {
      if (gen === this.generation) {
        this.inFlight--;
        this.sendInOrder();
        this.dispatch();
        this.checkDrained();
      }
    }
  }

  private sendInOrder() {
    while (true) {
      if (this.cancelled) {
        this.completedAudio.clear();
        return;
      }

      if (this.completedAudio.has(this.nextSendIndex)) {
        const audio = this.completedAudio.get(this.nextSendIndex)!;
        this.completedAudio.delete(this.nextSendIndex);

        // Parse WAV header for metadata (guard against malformed audio)
        let sampleRate = 16000;
        let durationMs = 0;
        if (audio.length >= 44) {
          const rawSampleRate = audio.readUInt32LE(24);
          sampleRate = rawSampleRate || 16000;
          const dataSize = audio.length - 44;
          const bytesPerSample = 2; // 16-bit
          durationMs = rawSampleRate > 0
            ? Math.round(dataSize / (rawSampleRate * bytesPerSample) * 1000)
            : 0;
        }

        this.sendJson({
          type: 'tts_meta',
          format: 'wav',
          index: this.nextSendIndex,
          sampleRate,
          durationMs,
        });
        this.sendBinary(audio);

        this.nextSendIndex++;
        continue;
      }

      if (this.failedChunks.has(this.nextSendIndex)) {
        // Skip this chunk — both providers failed
        this.failedChunks.delete(this.nextSendIndex);
        this.nextSendIndex++;
        continue;
      }

      // Neither completed nor failed — still in-flight or pending
      break;
    }
  }

  private checkDrained() {
    if (this.inFlight === 0 && this.pendingChunks.size === 0 && this.drainResolve) {
      this.sendInOrder();
      this.resolveDrain();
    }
  }

  private resolveDrain() {
    if (this.drainTimeout) {
      clearTimeout(this.drainTimeout);
      this.drainTimeout = null;
    }
    if (this.drainResolve) {
      const resolve = this.drainResolve;
      this.drainResolve = null;
      resolve();
    }
  }

  private drainAll(): Promise<void> {
    // If already drained, resolve immediately
    if (this.inFlight === 0 && this.pendingChunks.size === 0) {
      this.sendInOrder();
      return Promise.resolve();
    }

    if (this.cancelled) {
      return Promise.resolve();
    }

    const DRAIN_TIMEOUT_MS = 30_000;
    return new Promise((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        if (this.drainResolve === resolve) {
          this.drainResolve = null;
          this.drainTimeout = null;
          this.sendInOrder();
          resolve();
        }
      }, DRAIN_TIMEOUT_MS);
    });
  }
}
