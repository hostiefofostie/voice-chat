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
  private inFlight: number = 0;
  private cancelled: boolean = false;
  // Generation counter — incremented on reset() so stale in-flight synthesis
  // from a previous turn does not corrupt state (e.g. decrementing inFlight
  // below zero after reset set it to 0).
  private generation: number = 0;

  constructor(options: TtsPipelineOptions) {
    super();
    this.ttsRouter = options.ttsRouter;
    this.sendJson = options.sendJson;
    this.sendBinary = options.sendBinary;
    this.maxParallel = options.maxParallel || 2;
  }

  async processChunk(text: string, index: number, turnId: string) {
    if (this.cancelled) return;
    this.pendingChunks.set(index, { text, turnId });
    await this.dispatch();
  }

  async finish() {
    await this.drainAll();
    if (!this.cancelled) {
      this.sendJson({ type: 'tts_done' });
      this.emit('done');
    }
  }

  cancel() {
    this.cancelled = true;
    this.pendingChunks.clear();
    this.completedAudio.clear();
    this.sendJson({ type: 'tts_done' });
    this.emit('cancelled');
  }

  reset() {
    this.pendingChunks.clear();
    this.completedAudio.clear();
    this.nextSendIndex = 0;
    this.inFlight = 0;
    this.cancelled = false;
    this.generation++;
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
      this.inFlight--;
      this.sendInOrder();
      await this.dispatch();
    } catch (err) {
      if (gen !== this.generation) return;
      this.inFlight--;
      this.emit('error', err);
    }
  }

  private sendInOrder() {
    while (this.completedAudio.has(this.nextSendIndex)) {
      if (this.cancelled) {
        // Discard completed audio after cancel — don't send stale chunks
        this.completedAudio.clear();
        return;
      }

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
    }
  }

  private drainAll(): Promise<void> {
    const DRAIN_TIMEOUT_MS = 30_000;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (this.cancelled) {
          resolve();
          return;
        }
        if (this.inFlight === 0 && this.pendingChunks.size === 0) {
          this.sendInOrder();
          resolve();
          return;
        }
        if (Date.now() - startedAt > DRAIN_TIMEOUT_MS) {
          // Safety timeout — don't hang forever if inFlight is stuck
          this.sendInOrder();
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
}
