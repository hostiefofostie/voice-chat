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
  private totalChunks: number = -1; // -1 = unknown (streaming)

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
    this.totalChunks = this.pendingChunks.size + this.completedAudio.size + this.inFlight;
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
    this.totalChunks = -1;
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
    try {
      const { audio } = await this.ttsRouter.synthesize(text);
      this.completedAudio.set(index, audio);
      this.inFlight--;
      this.sendInOrder();
      this.dispatch();
    } catch (err) {
      this.inFlight--;
      this.emit('error', err);
    }
  }

  private sendInOrder() {
    while (this.completedAudio.has(this.nextSendIndex)) {
      const audio = this.completedAudio.get(this.nextSendIndex)!;
      this.completedAudio.delete(this.nextSendIndex);

      // Parse WAV header for metadata
      const sampleRate = audio.readUInt32LE(24);
      const durationMs = Math.round((audio.length - 44) / (sampleRate * 2) * 1000);

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
    return new Promise((resolve) => {
      const check = () => {
        if (this.inFlight === 0 && this.pendingChunks.size === 0) {
          this.sendInOrder();
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }
}
