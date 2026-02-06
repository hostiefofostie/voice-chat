import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeCommand, type CommandContext } from '../commands.js';
import type { ServerMessage, SessionConfig, DEFAULT_CONFIG } from '../../types.js';

function createContext(config?: Partial<SessionConfig>): CommandContext & { messages: ServerMessage[] } {
  const cfg: SessionConfig = {
    autoSendDelayMs: 1500,
    ttsProvider: 'kokoro',
    ttsVoice: 'af_heart',
    sttProvider: 'parakeet',
    vadSensitivity: 0.5,
    llmModel: 'sonnet',
    agentId: 'default',
    sessionKey: '',
    ...config,
  };
  const messages: ServerMessage[] = [];
  return {
    config: cfg,
    updateConfig: (partial) => Object.assign(cfg, partial),
    sendMessage: (msg) => messages.push(msg),
    messages,
  };
}

describe('Commands', () => {
  describe('/help', () => {
    it('returns available commands', async () => {
      const ctx = createContext();
      await executeCommand('help', [], ctx);
      expect(ctx.messages.length).toBe(1);
      const msg = ctx.messages[0];
      expect(msg.type).toBe('command_result');
      if (msg.type === 'command_result') {
        expect(msg.name).toBe('help');
        expect((msg.result as { message: string }).message).toContain('Available commands');
        expect((msg.result as { message: string }).message).toContain('/model');
        expect((msg.result as { message: string }).message).toContain('/voice');
      }
    });
  });

  describe('/model', () => {
    it('updates llmModel config', async () => {
      const ctx = createContext();
      await executeCommand('model', ['gpt-4'], ctx);
      expect(ctx.config.llmModel).toBe('gpt-4');
      const msg = ctx.messages[0] as { type: string; result: { message: string } };
      expect(msg.result.message).toContain('gpt-4');
    });

    it('returns error when no model name provided', async () => {
      const ctx = createContext();
      await executeCommand('model', [], ctx);
      const msg = ctx.messages[0] as { type: string; result: { error: string } };
      expect(msg.result.error).toContain('Usage');
    });
  });

  describe('/voice', () => {
    it('updates ttsVoice config', async () => {
      const ctx = createContext();
      await executeCommand('voice', ['nova'], ctx);
      expect(ctx.config.ttsVoice).toBe('nova');
    });

    it('returns error when no voice name provided', async () => {
      const ctx = createContext();
      await executeCommand('voice', [], ctx);
      const msg = ctx.messages[0] as { type: string; result: { error: string } };
      expect(msg.result.error).toContain('Usage');
    });
  });

  describe('/tts', () => {
    it('switches to openai', async () => {
      const ctx = createContext();
      await executeCommand('tts', ['openai'], ctx);
      expect(ctx.config.ttsProvider).toBe('openai');
    });

    it('switches to kokoro', async () => {
      const ctx = createContext({ ttsProvider: 'openai' });
      await executeCommand('tts', ['kokoro'], ctx);
      expect(ctx.config.ttsProvider).toBe('kokoro');
    });

    it('rejects invalid provider', async () => {
      const ctx = createContext();
      await executeCommand('tts', ['invalid'], ctx);
      const msg = ctx.messages[0] as { type: string; result: { error: string } };
      expect(msg.result.error).toContain('Usage');
      expect(ctx.config.ttsProvider).toBe('kokoro'); // unchanged
    });
  });

  describe('/stt', () => {
    it('switches to cloud', async () => {
      const ctx = createContext();
      await executeCommand('stt', ['cloud'], ctx);
      expect(ctx.config.sttProvider).toBe('cloud');
    });

    it('rejects invalid provider', async () => {
      const ctx = createContext();
      await executeCommand('stt', ['whisper'], ctx);
      const msg = ctx.messages[0] as { type: string; result: { error: string } };
      expect(msg.result.error).toContain('Usage');
    });
  });

  describe('/agent', () => {
    it('updates agentId config', async () => {
      const ctx = createContext();
      await executeCommand('agent', ['assistant'], ctx);
      expect(ctx.config.agentId).toBe('assistant');
    });
  });

  describe('/clear', () => {
    it('returns success message', async () => {
      const ctx = createContext();
      await executeCommand('clear', [], ctx);
      const msg = ctx.messages[0] as { type: string; result: { message: string } };
      expect(msg.result.message).toContain('cleared');
    });
  });

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const ctx = createContext();
      await executeCommand('nonexistent', [], ctx);
      const msg = ctx.messages[0] as { type: string; result: { error: string } };
      expect(msg.result.error).toContain('Unknown command');
    });
  });
});
