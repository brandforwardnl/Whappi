import { randomUUID } from 'crypto';
import { whatsapp, normalizePhone } from './whatsapp';
import { dbApi, DbJobRow } from './db';
import { fireWebhook } from './webhook';
import { emitUpdate } from './events';
import { waitForSlot } from './throttle';
import { settings } from './settings';

export interface SendJob {
  message_id: string;
  to: string;
  message: string;
  quoty_customer_id?: string;
  metadata?: Record<string, unknown>;
  attempts: number;
  session_id?: string | null;
}

const MAX_ATTEMPTS = 3;

function rowToJob(row: DbJobRow): SendJob {
  return {
    message_id: row.message_id,
    to: row.to_number,
    message: row.message,
    quoty_customer_id: row.quoty_customer_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    attempts: row.attempts,
    session_id: row.session_id ?? undefined,
  };
}

class SendQueue {
  private jobs: SendJob[] = [];
  private running = false;

  loadFromDb() {
    this.jobs = dbApi.allJobs().map(rowToJob);
    if (this.jobs.length > 0) {
      console.log(`[queue] ${this.jobs.length} pending jobs restored from DB`);
      this.tick();
    }
  }

  enqueue(input: Omit<SendJob, 'message_id' | 'attempts'>): string {
    const job: SendJob = {
      ...input,
      message_id: 'msg_' + randomUUID(),
      attempts: 0,
    };
    dbApi.insertJob({
      message_id: job.message_id,
      to_number: job.to,
      message: job.message,
      quoty_customer_id: job.quoty_customer_id ?? null,
      metadata: job.metadata ? JSON.stringify(job.metadata) : null,
      session_id: job.session_id ?? null,
    });
    this.jobs.push(job);
    emitUpdate();
    this.tick();
    return job.message_id;
  }

  length(): number {
    return this.jobs.length;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs[0];
        try {
          await waitForSlot(job.to);
          const jid = normalizePhone(job.to);
          await whatsapp.sendText(job.session_id || null, jid, job.message);
          const at = new Date().toISOString();
          whatsapp.recordRecent({
            message_id: job.message_id,
            to: job.to,
            status: 'sent',
            at,
            session_id: job.session_id ?? whatsapp.getDefaultId() ?? null,
          });
          fireWebhook({
            event: 'message.sent',
            message_id: job.message_id,
            to: job.to,
            quoty_customer_id: job.quoty_customer_id,
            metadata: job.metadata,
            at,
          });
          dbApi.deleteJob(job.message_id);
          this.jobs.shift();
          emitUpdate();
        } catch (err) {
          job.attempts++;
          dbApi.updateAttempts(job.message_id, job.attempts);
          const msg = err instanceof Error ? err.message : String(err);
          if (job.attempts >= MAX_ATTEMPTS) {
            console.error(JSON.stringify({
              type: 'send_failed',
              message_id: job.message_id,
              quoty_customer_id: job.quoty_customer_id,
              quote_id: (job.metadata as any)?.quote_id,
              error: msg,
            }));
            const at = new Date().toISOString();
            whatsapp.recordRecent({
              message_id: job.message_id,
              to: job.to,
              status: 'failed',
              at,
              error: msg,
              session_id: job.session_id ?? whatsapp.getDefaultId() ?? null,
            });
            fireWebhook({
              event: 'message.failed',
              message_id: job.message_id,
              to: job.to,
              quoty_customer_id: job.quoty_customer_id,
              metadata: job.metadata,
              error: msg,
              at,
            });
            dbApi.deleteJob(job.message_id);
            this.jobs.shift();
            emitUpdate();
          } else {
            console.warn(`[queue] retry ${job.attempts}/${MAX_ATTEMPTS} for ${job.message_id}: ${msg}`);
            await sleep(settings.getQueueDelaySec() * 1000 * job.attempts);
            continue;
          }
        }
        await sleep(settings.getQueueDelaySec() * 1000);
      }
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export const queue = new SendQueue();
