import { EventEmitter } from 'events';
import { ParakeetClient } from './parakeet-client.js';

/**
 * Rolling-window STT processor.
 *
 * During LISTENING state, audio chunks accumulate in a buffer. Every
 * `intervalMs` a decode cycle sends the last `windowSeconds` of audio
 * to the Parakeet STT service. Text confirmed across consecutive
 * decodes becomes the stable prefix; the remainder is unstable.
 *
 * Events:
 *   transcript_partial — { stable: string, unstable: string, text: string }
 *   transcript_final   — { text: string }
 *   error              — Error
 */
export class RollingWindowSTT extends EventEmitter {
  private audioBuffer: Buffer[] = [];
  private audioBytes: number = 0;
  private decodeHistory: string[] = [];
  private stablePrefix: string = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: boolean = false;
  private sttClient: ParakeetClient;

  // Config
  private intervalMs: number = 500;
  private windowSeconds: number = 6;
  private sampleRate: number = 16000;
  private bytesPerSample: number = 2; // 16-bit PCM
  private stabilityThreshold: number = 2;

  constructor(sttClient: ParakeetClient) {
    super();
    this.sttClient = sttClient;
  }

  /** Begin periodic decode cycles. Resets any prior state. */
  start() {
    this.reset();
    this.timer = setInterval(() => this.decodeCycle(), this.intervalMs);
  }

  /** Append an incoming PCM audio chunk to the buffer. */
  appendAudio(chunk: Buffer) {
    this.audioBuffer.push(chunk);
    this.audioBytes += chunk.length;
  }

  /**
   * Final decode using ALL accumulated audio.
   * Stops the periodic timer and emits transcript_final.
   */
  async finalize(): Promise<{ text: string }> {
    this.stopTimer();
    const fullAudio = this.buildWav(Buffer.concat(this.audioBuffer));
    const result = await this.sttClient.transcribe(fullAudio);
    this.emit('transcript_final', { text: result.text });
    return { text: result.text };
  }

  /**
   * Stop the periodic timer and return all accumulated audio as a WAV buffer.
   * Does NOT perform a final decode — the caller is responsible for transcribing
   * through the SttRouter (which has proper failover via circuit breaker).
   */
  stop(): Buffer {
    this.stopTimer();
    return this.buildWav(Buffer.concat(this.audioBuffer));
  }

  /** Stop timer and clear all accumulated state. */
  reset() {
    this.stopTimer();
    this.audioBuffer = [];
    this.audioBytes = 0;
    this.decodeHistory = [];
    this.stablePrefix = '';
    this.inFlight = false;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async decodeCycle() {
    if (this.inFlight) return; // debounce — skip if previous decode still running
    if (this.audioBytes === 0) return;

    this.inFlight = true;
    try {
      const windowAudio = this.getWindowedAudio();
      const wav = this.buildWav(windowAudio);
      const result = await this.sttClient.transcribe(wav);
      const { stable, unstable } = this.processDecodeResult(result.text);
      this.emit('transcript_partial', { stable, unstable, text: result.text });
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.inFlight = false;
    }
  }

  /** Extract the last `windowSeconds` of audio from the accumulated buffer. */
  private getWindowedAudio(): Buffer {
    const maxBytes = this.windowSeconds * this.sampleRate * this.bytesPerSample;
    const all = Buffer.concat(this.audioBuffer);
    if (all.length <= maxBytes) return all;
    return all.subarray(all.length - maxBytes);
  }

  /**
   * Compare the new transcript against recent decode history.
   * Text that is identical across `stabilityThreshold` consecutive decodes
   * (up to a word boundary) becomes the stable prefix.
   */
  private processDecodeResult(transcript: string): { stable: string; unstable: string } {
    this.decodeHistory.push(transcript);

    if (this.decodeHistory.length < this.stabilityThreshold) {
      return { stable: this.stablePrefix, unstable: transcript };
    }

    // Compare the most recent N decodes
    const recent = this.decodeHistory.slice(-this.stabilityThreshold);
    let commonPrefix = '';
    for (let i = 0; i < recent[0].length; i++) {
      if (recent.every(t => t[i] === recent[0][i])) {
        commonPrefix += recent[0][i];
      } else {
        break;
      }
    }

    // Snap to word boundary — only advance the stable prefix
    const lastSpace = commonPrefix.lastIndexOf(' ');
    if (lastSpace > this.stablePrefix.length) {
      this.stablePrefix = commonPrefix.substring(0, lastSpace + 1).trimEnd();
    }

    const unstable = transcript.substring(this.stablePrefix.length);
    return { stable: this.stablePrefix, unstable };
  }

  /** Construct a valid WAV file (16 kHz, 16-bit, mono) from raw PCM data. */
  private buildWav(pcmData: Buffer): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20);  // PCM format
    header.writeUInt16LE(1, 22);  // mono channel
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * this.bytesPerSample, 28); // byte rate
    header.writeUInt16LE(this.bytesPerSample, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);
    return Buffer.concat([header, pcmData]);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
