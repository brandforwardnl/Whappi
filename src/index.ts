import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import './db';
import { initSettings, settings } from './settings';
import { queue } from './queue';
import { whatsapp } from './whatsapp';
import './webhook';
import { startWebhookWorker } from './webhookQueue';
import { sendRoutes } from './routes/send';
import { statusRoutes } from './routes/status';
import { adminRoutes } from './routes/admin';
import { apiKeyGuard } from './middleware/apiKey';

async function main() {
  const port = Number(process.env.PORT || 3100);
  const apiKey = process.env.INTERNAL_API_KEY;
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!apiKey || apiKey.length < 32) {
    console.error('INTERNAL_API_KEY is missing or shorter than 32 characters.');
    process.exit(1);
  }
  if (!adminUser || !adminPassword) {
    console.error('ADMIN_USER and ADMIN_PASSWORD are required.');
    process.exit(1);
  }

  // Seed settings from .env on first start
  initSettings({ adminUser, adminPassword, apiKey });

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(formbody);

  // Healthcheck (no auth) - for monitoring/load balancers
  app.get('/healthz', async (_req, reply) => {
    const status = whatsapp.getStatus();
    const ok = status === 'open';
    reply.code(ok ? 200 : 503).send({
      ok,
      whatsapp: status,
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  // API routes (x-api-key) - reads live from settings
  await app.register(async (api) => {
    api.addHook('onRequest', apiKeyGuard(() => settings.getApiKey(), () => settings.getApiIpAllowlist()));
    await sendRoutes(api);
    await statusRoutes(api);
  });

  // Admin routes (cookie session via login) - own plugin scope
  await app.register(async (admin) => {
    await adminRoutes(admin, { secret: apiKey });
  });

  // Start all WhatsApp sessions (non-blocking)
  whatsapp.startAll().catch((e) => console.error('[whatsapp] start error', e));

  // Load pending jobs from DB (surviving jobs from previous run)
  queue.loadFromDb();

  // Start webhook retry worker
  startWebhookWorker();

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[server] listening on :${port}`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
