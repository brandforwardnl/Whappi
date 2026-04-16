import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode';
import { randomUUID } from 'crypto';
import { dbApi, DbSessionRow } from './db';
import { fireWebhook } from './webhook';
import { emitUpdate } from './events';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface RecentMessage {
  message_id: string;
  to: string;
  status: 'sent' | 'failed' | 'received';
  at: string;
  error?: string;
  session_id?: string | null;
  direction: 'incoming' | 'outgoing';
  from?: string | null;
}

const SESSIONS_ROOT = path.resolve(process.cwd(), 'sessions');

function sessionDir(id: string): string {
  return path.join(SESSIONS_ROOT, id);
}

class WhatsAppClient {
  public status: ConnectionStatus = 'closed';
  public latestQr: string | null = null;
  private sock: WASocket | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(public id: string, public name: string) {}

  async start() {
    this.stopped = false;
    const dir = sessionDir(this.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    this.status = 'connecting';
    emitUpdate();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.latestQr = qr;
        try {
          const ascii = await qrcode.toString(qr, { type: 'terminal', small: true });
          console.log(`[whatsapp:${this.name}] scan QR-code:\n` + ascii);
        } catch {
          console.log(`[whatsapp:${this.name}] QR (raw):`, qr);
        }
        emitUpdate();
      }

      if (connection === 'open') {
        const wasOpen = this.status === 'open';
        this.status = 'open';
        this.latestQr = null;
        this.reconnectAttempts = 0;
        console.log(`[whatsapp:${this.name}] connected`);
        if (!wasOpen) fireWebhook({ event: 'whatsapp.connected', at: new Date().toISOString(), session_id: this.id } as any);
        emitUpdate();
      }

      if (connection === 'close') {
        const wasOpen = this.status === 'open';
        this.status = 'closed';
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`[whatsapp:${this.name}] connection closed (code=${code}, loggedOut=${loggedOut})`);

        if (wasOpen) fireWebhook({ event: 'whatsapp.disconnected', at: new Date().toISOString(), session_id: this.id } as any);
        emitUpdate();

        if (!loggedOut && !this.stopped) {
          const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
          this.reconnectAttempts++;
          setTimeout(() => this.start().catch((e) => console.error(`[whatsapp:${this.name}] reconnect error`, e)), delay);
        }
      }
    });

    this.sock.ev.on('messages.upsert', (m) => {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
        const from = msg.key.remoteJid || '';
        const messageId = msg.key.id || `recv_${Date.now()}`;
        const at = new Date().toISOString();
        console.log(JSON.stringify({
          type: 'incoming',
          session_id: this.id,
          from,
          id: messageId,
          timestamp: msg.messageTimestamp,
          text,
        }));
        // Store in history
        const fromNumber = from.replace(/@.*$/, '');
        dbApi.insertHistory({
          message_id: messageId,
          to_number: '',
          status: 'received',
          at,
          error: null,
          session_id: this.id,
          direction: 'incoming',
          from_number: fromNumber,
        });
        emitUpdate();
        fireWebhook({
          event: 'message.received',
          from,
          message_id: messageId,
          text,
          timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp) || null,
          at,
        });
      }
    });
  }

  async stop() {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {
      // ignore
    }
    this.sock = null;
    this.status = 'closed';
  }

  async sendText(toJid: string, text: string): Promise<string> {
    if (!this.sock || this.status !== 'open') {
      throw new Error(`WhatsApp session "${this.name}" not connected`);
    }
    const result = await this.sock.sendMessage(toJid, { text });
    return result?.key?.id || '';
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      // ignore
    }
    this.sock = null;
    this.status = 'closed';
  }
}

class WhatsAppManager {
  private clients = new Map<string, WhatsAppClient>();

  async startAll() {
    if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

    // Migration: old layout (sessions/creds.json directly) → sessions/default/
    if (fs.existsSync(path.join(SESSIONS_ROOT, 'creds.json'))) {
      const defaultDir = path.join(SESSIONS_ROOT, 'default');
      if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
      for (const file of fs.readdirSync(SESSIONS_ROOT)) {
        const src = path.join(SESSIONS_ROOT, file);
        if (fs.statSync(src).isFile()) {
          fs.renameSync(src, path.join(defaultDir, file));
        }
      }
      console.log('[whatsapp] old sessions/ content migrated to sessions/default/');
    }

    let sessions = dbApi.listSessions();
    if (sessions.length === 0) {
      // First time or existing default folder without DB row
      const id = fs.existsSync(path.join(SESSIONS_ROOT, 'default')) ? 'default' : 'default';
      dbApi.addSession(id, 'Default', true);
      sessions = dbApi.listSessions();
    }

    if (!sessions.find((s) => s.is_default === 1)) {
      dbApi.setDefaultSession(sessions[0].id);
      sessions = dbApi.listSessions();
    }

    for (const s of sessions) {
      const client = new WhatsAppClient(s.id, s.name);
      this.clients.set(s.id, client);
      client.start().catch((e) => console.error(`[whatsapp:${s.name}] start error`, e));
    }
  }

  list(): { id: string; name: string; status: ConnectionStatus; isDefault: boolean; latestQr: string | null }[] {
    return dbApi.listSessions().map((s) => {
      const c = this.clients.get(s.id);
      return {
        id: s.id,
        name: s.name,
        status: c?.status || 'closed',
        isDefault: s.is_default === 1,
        latestQr: c?.latestQr || null,
      };
    });
  }

  getClient(id: string): WhatsAppClient | undefined {
    return this.clients.get(id);
  }

  getDefaultId(): string | null {
    return dbApi.getDefaultSession()?.id || null;
  }

  resolveSessionId(requested?: string | null): string | null {
    if (requested) {
      return this.clients.has(requested) ? requested : null;
    }
    return this.getDefaultId();
  }

  async addSession(name: string, makeDefault = false): Promise<string> {
    const id = randomUUID();
    dbApi.addSession(id, name, makeDefault);
    const client = new WhatsAppClient(id, name);
    this.clients.set(id, client);
    client.start().catch((e) => console.error(`[whatsapp:${name}] start error`, e));
    emitUpdate();
    return id;
  }

  async removeSession(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
      await client.stop();
    }
    this.clients.delete(id);
    const dir = sessionDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    const wasDefault = dbApi.getSession(id)?.is_default === 1;
    dbApi.removeSession(id);

    if (wasDefault) {
      const remaining = dbApi.listSessions();
      if (remaining.length > 0) dbApi.setDefaultSession(remaining[0].id);
    }
    emitUpdate();
  }

  setDefault(id: string): void {
    if (this.clients.has(id)) {
      dbApi.setDefaultSession(id);
      emitUpdate();
    }
  }

  rename(id: string, name: string): void {
    dbApi.renameSession(id, name);
    const c = this.clients.get(id);
    if (c) c.name = name;
    emitUpdate();
  }

  async resetSession(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) return;
    await client.logout();
    await client.stop();
    const dir = sessionDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const fresh = new WhatsAppClient(id, client.name);
    this.clients.set(id, fresh);
    fresh.start().catch((e) => console.error(`[whatsapp:${client.name}] reset error`, e));
    emitUpdate();
  }

  async sendText(sessionId: string | null, toJid: string, text: string): Promise<string> {
    const id = this.resolveSessionId(sessionId);
    if (!id) throw new Error('No WhatsApp session available');
    const client = this.clients.get(id);
    if (!client) throw new Error(`Session "${id}" not found`);
    return client.sendText(toJid, text);
  }

  // Compatibility shims for existing code
  getStatus(): ConnectionStatus {
    const def = this.getDefaultId();
    if (!def) return 'closed';
    return this.clients.get(def)?.status || 'closed';
  }
  getQr(): string | null {
    const def = this.getDefaultId();
    if (!def) return null;
    return this.clients.get(def)?.latestQr || null;
  }
  getRecent(): RecentMessage[] {
    return dbApi.recentHistory(50).map((r: any) => ({
      message_id: r.message_id,
      to: r.to_number,
      status: r.status,
      at: r.at,
      error: r.error ?? undefined,
      session_id: r.session_id ?? undefined,
      direction: r.direction || 'outgoing',
      from: r.from_number ?? undefined,
    }));
  }
  recordRecent(entry: RecentMessage) {
    dbApi.insertHistory({
      message_id: entry.message_id,
      to_number: entry.to,
      status: entry.status,
      at: entry.at,
      error: entry.error ?? null,
      session_id: entry.session_id ?? null,
      direction: entry.direction,
      from_number: entry.from ?? null,
    });
  }
  async start() {
    return this.startAll();
  }
}

export const whatsapp = new WhatsAppManager();

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) throw new Error('Invalid phone number');
  return `${digits}@s.whatsapp.net`;
}
