import 'dotenv/config';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { registerWebSocket } from './ws/handler.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined
  }
});

// Register plugins
await app.register(cors, { origin: true });
await app.register(websocket, {
  options: {
    maxPayload: 1024 * 1024 * 5 // 5MB max for audio chunks
  }
});

// WebSocket handler
registerWebSocket(app);

// Health endpoint
app.get('/health', async () => ({
  ok: true,
  uptime: process.uptime(),
  timestamp: new Date().toISOString()
}));

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down...');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start server
const start = async () => {
  await app.listen({ port: Number(process.env.PORT || 8788), host: '0.0.0.0' });
};
start();

export default app;
