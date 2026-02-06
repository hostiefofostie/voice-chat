import { EventEmitter } from 'events';
import { GatewayClient } from './gateway-client.js';
import { PhraseChunker } from '../tts/phrase-chunker.js';

/**
 * LLM pipeline: forwards transcripts to OpenClaw Gateway and streams tokens back.
 *
 * Events:
 *  - llm_token   { token: string, fullText: string }
 *  - llm_done    { fullText: string, cancelled?: boolean }
 *  - phrase_ready { text: string, index: number, turnId: string }
 *  - error       { error: Error, turnId: string }
 */
export class LlmPipeline extends EventEmitter {
  private gateway: GatewayClient;
  private phraseChunker: PhraseChunker;
  private accumulatedText: string = '';
  private previousBufferLength: number = 0;
  private abortController: AbortController | null = null;
  private cancelled: boolean = false;

  constructor(gateway: GatewayClient) {
    super();
    this.gateway = gateway;
    this.phraseChunker = new PhraseChunker();
  }

  async sendTranscript(text: string, sessionKey: string, turnId: string): Promise<void> {
    this.accumulatedText = '';
    this.previousBufferLength = 0;
    this.phraseChunker.reset();
    this.cancelled = false;
    this.abortController = new AbortController();

    const message = `[[voice]] Be brief.\n${text}`;

    try {
      await this.gateway.sendChat(sessionKey, message, {
        onDelta: (fullBuffer: string, _payload: Record<string, unknown>) => {
          if (this.cancelled) return; // Stop processing deltas after cancel

          // gateway-client calls onDelta with the full accumulated buffer,
          // so extract the actual new token from the difference
          const token = fullBuffer.substring(this.previousBufferLength);
          this.previousBufferLength = fullBuffer.length;
          this.accumulatedText = fullBuffer;

          if (token) {
            this.emit('llm_token', { token, fullText: this.accumulatedText });

            // Feed to phrase chunker for TTS pipelining
            const chunks = this.phraseChunker.feed(token);
            for (const chunk of chunks) {
              this.emit('phrase_ready', { text: chunk.text, index: chunk.index, turnId });
            }
          }
        },
        onFinal: (finalText: string, _payload: Record<string, unknown>) => {
          if (this.cancelled) return; // cancel() already emitted llm_done

          // Flush remaining text from chunker
          const remaining = this.phraseChunker.feed('', true);
          for (const chunk of remaining) {
            this.emit('phrase_ready', { text: chunk.text, index: chunk.index, turnId });
          }
          this.emit('llm_done', { fullText: finalText || this.accumulatedText });
        },
      });
    } catch (err) {
      if (!this.cancelled) {
        this.emit('error', { error: err, turnId });
      }
    }
  }

  cancel(): void {
    if (this.cancelled) return; // Prevent double-cancel
    this.cancelled = true;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Flush remaining text from chunker
    const remaining = this.phraseChunker.feed('', true);
    for (const chunk of remaining) {
      this.emit('phrase_ready', { text: chunk.text, index: chunk.index });
    }
    this.emit('llm_done', { fullText: this.accumulatedText, cancelled: true });
  }
}
