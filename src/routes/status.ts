import { FastifyInstance } from 'fastify';
import { whatsapp } from '../whatsapp';
import { queue } from '../queue';

const startedAt = Date.now();

export async function statusRoutes(app: FastifyInstance) {
  app.get('/status', async () => ({
    whatsapp: whatsapp.getStatus(),
    queue_length: queue.length(),
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
