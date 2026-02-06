import { ServerMessage, SessionConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Command Context
// ---------------------------------------------------------------------------

export interface CommandContext {
  config: SessionConfig;
  updateConfig: (partial: Partial<SessionConfig>) => void;
  sendMessage: (msg: ServerMessage) => void;
}

// ---------------------------------------------------------------------------
// Command Registry
// ---------------------------------------------------------------------------

type CommandHandler = (
  args: string[],
  ctx: CommandContext,
) => Promise<{ message?: string; error?: string }>;

const COMMANDS: Record<string, CommandHandler> = {
  model: async (args, ctx) => {
    const name = args[0];
    if (!name) return { error: 'Usage: /model <name>' };
    ctx.updateConfig({ llmModel: name });
    return { message: `Switched to model: ${name}` };
  },

  agent: async (args, ctx) => {
    const name = args[0];
    if (!name) return { error: 'Usage: /agent <name>' };
    ctx.updateConfig({ agentId: name });
    return { message: `Switched to agent: ${name}` };
  },

  voice: async (args, ctx) => {
    const name = args[0];
    if (!name) return { error: 'Usage: /voice <name>' };
    ctx.updateConfig({ ttsVoice: name });
    return { message: `Switched to voice: ${name}` };
  },

  tts: async (args, ctx) => {
    const provider = args[0];
    if (!provider || !['kokoro', 'openai'].includes(provider)) {
      return { error: 'Usage: /tts kokoro|openai' };
    }
    ctx.updateConfig({ ttsProvider: provider as 'kokoro' | 'openai' });
    return { message: `Switched TTS to: ${provider}` };
  },

  stt: async (args, ctx) => {
    const provider = args[0];
    if (!provider || !['parakeet', 'cloud'].includes(provider)) {
      return { error: 'Usage: /stt parakeet|cloud' };
    }
    ctx.updateConfig({ sttProvider: provider as 'parakeet' | 'cloud' });
    return { message: `Switched STT to: ${provider}` };
  },

  clear: async () => {
    return { message: 'Conversation cleared' };
  },

  help: async () => ({
    message: [
      'Available commands:',
      '  /model <name> — Switch LLM model',
      '  /agent <name> — Switch agent/persona',
      '  /voice <name> — Switch TTS voice',
      '  /tts kokoro|openai — Switch TTS provider',
      '  /stt parakeet|cloud — Switch STT provider',
      '  /clear — Clear conversation',
      '  /help — Show this help',
    ].join('\n'),
  }),
};

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeCommand(
  name: string,
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const handler = COMMANDS[name];
  if (!handler) {
    ctx.sendMessage({
      type: 'command_result',
      name,
      result: {
        error: `Unknown command: /${name}. Type /help for available commands.`,
      },
    });
    return;
  }
  const result = await handler(args, ctx);
  ctx.sendMessage({ type: 'command_result', name, result });
}
