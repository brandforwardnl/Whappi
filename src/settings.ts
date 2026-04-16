import { db } from './db';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const SETTINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
db.exec(SETTINGS_SCHEMA);

const getStmt = db.prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`);
const setStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

function get(key: string): string | null {
  const row = getStmt.get(key);
  return row?.value ?? null;
}

function set(key: string, value: string): void {
  setStmt.run(key, value);
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface InitialSettings {
  adminUser: string;
  adminPassword: string;
  apiKey: string;
}

export function initSettings(initial: InitialSettings): void {
  if (!get('admin_user')) set('admin_user', initial.adminUser);
  if (!get('admin_password_hash')) set('admin_password_hash', hashPassword(initial.adminPassword));
  if (!get('api_key')) set('api_key', initial.apiKey);
}

export const settings = {
  getAdminUser: () => get('admin_user') || '',
  getAdminPasswordHash: () => get('admin_password_hash') || '',
  getApiKey: () => get('api_key') || '',
  getLastTestNumber: () => get('last_test_number') || '',
  getWebhookUrl: () => get('webhook_url') || '',
  getRecipientThrottleSec: () => parseInt(get('recipient_throttle_sec') || '60', 10),
  getBurstPerMinute: () => parseInt(get('burst_per_minute') || '30', 10),
  getApiIpAllowlist: () => get('api_ip_allowlist') || '',
  getQueueDelaySec: () => parseInt(get('queue_delay_sec') || '5', 10),
  getTheme: () => (get('theme') || 'system') as 'light' | 'dark' | 'system',
  setAdminUser: (v: string) => set('admin_user', v),
  setAdminPassword: (plain: string) => set('admin_password_hash', hashPassword(plain)),
  setApiKey: (v: string) => set('api_key', v),
  setLastTestNumber: (v: string) => set('last_test_number', v),
  setWebhookUrl: (v: string) => set('webhook_url', v),
  setRecipientThrottleSec: (v: number) => set('recipient_throttle_sec', String(v)),
  setBurstPerMinute: (v: number) => set('burst_per_minute', String(v)),
  setApiIpAllowlist: (v: string) => set('api_ip_allowlist', v),
  setQueueDelaySec: (v: number) => set('queue_delay_sec', String(v)),
  setTheme: (v: string) => set('theme', v),
};
