import { FastifyInstance } from 'fastify';
import { queue } from '../queue';
import { whatsapp } from '../whatsapp';
import { dbApi } from '../db';

interface SendBody {
  to: string | string[];
  message: string;
  session_id?: string;
  quoty_customer_id?: string;
  metadata?: Record<string, unknown>;
}

export async function sendRoutes(app: FastifyInstance) {
  app.post<{ Body: SendBody }>('/send', async (req, reply) => {
    const { to, message, session_id, quoty_customer_id, metadata } = req.body || ({} as SendBody);

    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ error: 'Field "message" is required' });
    }
    if (!to) {
      return reply.code(400).send({ error: 'Field "to" is required' });
    }

    if (session_id && !whatsapp.getClient(session_id)) {
      return reply.code(400).send({ error: `Unknown session_id "${session_id}"` });
    }

    const blocked_word = dbApi.checkContent(message);
    if (blocked_word) {
      return reply.code(400).send({ error: `Message blocked by content filter: "${blocked_word}"` });
    }

    const recipients = Array.isArray(to) ? to : [to];
    const blocked: string[] = [];
    const ids: string[] = [];
    for (const r of recipients) {
      if (typeof r !== 'string' || !r.trim()) continue;
      const digits = r.trim().replace(/[^\d]/g, '');
      if (dbApi.isBlocked(digits)) {
        blocked.push(digits);
        continue;
      }
      const id = queue.enqueue({
        to: r.trim(),
        message,
        quoty_customer_id,
        metadata,
        session_id: session_id ?? null,
      });
      ids.push(id);
    }

    if (ids.length === 0) {
      return reply.code(400).send({ error: 'No valid recipients' });
    }

    const result: any = Array.isArray(to)
      ? { queued: true, message_ids: ids }
      : { queued: true, message_id: ids[0] };
    if (blocked.length > 0) result.blocked = blocked;
    return result;
  });
}
