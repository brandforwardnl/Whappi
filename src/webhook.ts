import { enqueueWebhook } from './webhookQueue';

export type WebhookEvent =
  | { event: 'message.sent'; message_id: string; to: string; quoty_customer_id?: string; metadata?: unknown; at: string }
  | { event: 'message.failed'; message_id: string; to: string; quoty_customer_id?: string; metadata?: unknown; error: string; at: string }
  | { event: 'message.received'; from: string; message_id: string; text: string | null; timestamp: number | null; at: string; to_number?: string; quoty_customer_id?: string; metadata?: unknown }
  | { event: 'whatsapp.disconnected'; at: string }
  | { event: 'whatsapp.connected'; at: string };

export function fireWebhook(payload: WebhookEvent): void {
  enqueueWebhook(payload);
}
