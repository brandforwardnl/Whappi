import { createHmac } from 'crypto';
import { dbApi } from './db';
import { settings } from './settings';

const MAX_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 2000;

function backoffSeconds(attempts: number): number {
  // 5s, 30s, 2m, 10m, 1h, 6h
  const ladder = [5, 30, 120, 600, 3600, 21600];
  return ladder[Math.min(attempts, ladder.length - 1)];
}

export function enqueueWebhook(payload: object): void {
  if (!settings.getWebhookUrl()) return;
  dbApi.webhookEnqueue(JSON.stringify(payload));
}

async function processOne(job: { id: number; payload: string; attempts: number }) {
  const url = settings.getWebhookUrl();
  if (!url) {
    dbApi.webhookDelete(job.id);
    return;
  }

  const apiKey = settings.getApiKey();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = `${timestamp}.${job.payload}`;
  const signature = createHmac('sha256', apiKey).update(signaturePayload).digest('hex');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-whappi-timestamp': timestamp,
        'x-whappi-signature': signature,
      },
      body: job.payload,
    });
    if (res.ok) {
      dbApi.webhookDelete(job.id);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      console.error(`[webhook] gave up after ${attempts} attempts: ${msg}`);
      dbApi.webhookDelete(job.id);
    } else {
      const delay = backoffSeconds(attempts);
      console.warn(`[webhook] retry #${attempts} in ${delay}s: ${msg}`);
      dbApi.webhookSchedule(job.id, attempts, delay, msg);
    }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const jobs = dbApi.webhookDue();
    for (const job of jobs) {
      await processOne(job);
    }
  } finally {
    running = false;
  }
}

export function startWebhookWorker() {
  setInterval(() => {
    tick().catch((e) => console.error('[webhook] tick error', e));
  }, POLL_INTERVAL_MS);
}
