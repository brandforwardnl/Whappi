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

  const app = Fastify({ logger: { level: 'info' }, trustProxy: true });
  await app.register(formbody);

  // Homepage → redirect to admin/login
  app.get('/', async (_req, reply) => {
    reply.redirect('/admin');
  });

  // API routes under /api/ prefix
  await app.register(async (apiScope) => {
    // Healthcheck (no auth) - for monitoring/load balancers
    apiScope.get('/healthz', async (_req, reply) => {
      const status = whatsapp.getStatus();
      const ok = status === 'open';
      reply.code(ok ? 200 : 503).send({
        ok,
        whatsapp: status,
        uptime_seconds: Math.floor(process.uptime()),
      });
    });

    // Authenticated API routes (x-api-key)
    await apiScope.register(async (authed) => {
      authed.addHook('onRequest', apiKeyGuard(() => settings.getApiKey(), () => settings.getApiIpAllowlist()));
      await sendRoutes(authed);
      await statusRoutes(authed);
    });
  }, { prefix: '/api' });

  // Legacy routes (backwards compatibility) — redirect to /api/
  app.get('/healthz', async (_req, reply) => { reply.redirect(301, '/api/healthz'); });
  app.all('/send', async (_req, reply) => { reply.redirect(307, '/api/send'); });
  app.get('/status', async (_req, reply) => { reply.redirect(301, '/api/status'); });

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
