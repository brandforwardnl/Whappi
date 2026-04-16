import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'data.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS queue_jobs (
    message_id TEXT PRIMARY KEY,
    to_number TEXT NOT NULL,
    message TEXT NOT NULL,
    quoty_customer_id TEXT,
    metadata TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages_history (
    message_id TEXT PRIMARY KEY,
    to_number TEXT NOT NULL,
    status TEXT NOT NULL,
    at TEXT NOT NULL,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_history_at ON messages_history(at DESC);

  CREATE TABLE IF NOT EXISTS webhook_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_next ON webhook_queue(next_attempt_at);

  CREATE TABLE IF NOT EXISTS content_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL UNIQUE,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocklist (
    phone TEXT PRIMARY KEY,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
db.exec(SCHEMA);

// Add session_id columns to existing tables (idempotent)
function addColumnIfMissing(table: string, column: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
addColumnIfMissing('queue_jobs', 'session_id', 'TEXT');
addColumnIfMissing('messages_history', 'session_id', 'TEXT');
addColumnIfMissing('messages_history', 'direction', "TEXT NOT NULL DEFAULT 'outgoing'");
addColumnIfMissing('messages_history', 'from_number', 'TEXT');
addColumnIfMissing('messages_history', 'quoty_customer_id', 'TEXT');
addColumnIfMissing('messages_history', 'metadata', 'TEXT');
addColumnIfMissing('messages_history', 'jid', 'TEXT');

export interface DbJobRow {
  message_id: string;
  to_number: string;
  message: string;
  quoty_customer_id: string | null;
  metadata: string | null;
  attempts: number;
  created_at: string;
  session_id: string | null;
}

export interface DbHistoryRow {
  message_id: string;
  to_number: string;
  status: 'sent' | 'failed' | 'received';
  at: string;
  error: string | null;
  session_id: string | null;
  direction: 'incoming' | 'outgoing';
  from_number: string | null;
  quoty_customer_id: string | null;
  metadata: string | null;
  jid: string | null;
}

export interface DbSessionRow {
  id: string;
  name: string;
  is_default: number;
  created_at: string;
}

const insertJobStmt = db.prepare(`
  INSERT INTO queue_jobs (message_id, to_number, message, quoty_customer_id, metadata, attempts, session_id)
  VALUES (@message_id, @to_number, @message, @quoty_customer_id, @metadata, 0, @session_id)
`);

const updateAttemptsStmt = db.prepare(`UPDATE queue_jobs SET attempts = ? WHERE message_id = ?`);
const deleteJobStmt = db.prepare(`DELETE FROM queue_jobs WHERE message_id = ?`);
const selectAllJobsStmt = db.prepare(`SELECT * FROM queue_jobs ORDER BY created_at ASC`);
const countJobsStmt = db.prepare(`SELECT COUNT(*) as c FROM queue_jobs`);

const insertHistoryStmt = db.prepare(`
  INSERT OR REPLACE INTO messages_history (message_id, to_number, status, at, error, session_id, direction, from_number, quoty_customer_id, metadata, jid)
  VALUES (@message_id, @to_number, @status, @at, @error, @session_id, @direction, @from_number, @quoty_customer_id, @metadata, @jid)
`);
const selectRecentHistoryStmt = db.prepare(`
  SELECT * FROM messages_history ORDER BY at DESC LIMIT ?
`);

const statsTotalsStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as received,
    COUNT(*) as total
  FROM messages_history
`);

const statsTodayStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as received
  FROM messages_history
  WHERE substr(at, 1, 10) = date('now')
`);

const statsLast7Stmt = db.prepare(`
  SELECT substr(at, 1, 10) as day, COUNT(*) as c
  FROM messages_history
  WHERE at >= datetime('now', '-7 days')
  GROUP BY day
  ORDER BY day ASC
`);

export interface Totals { sent: number; failed: number; received: number; total: number; }
export interface DayCount { day: string; c: number; }

const findLastOutgoingByJidStmt = db.prepare(`
  SELECT to_number, quoty_customer_id, metadata FROM messages_history
  WHERE direction = 'outgoing' AND jid = ?
  ORDER BY at DESC LIMIT 1
`);

export const dbApi = {
  insertJob: (row: Omit<DbJobRow, 'attempts' | 'created_at'>) => insertJobStmt.run(row),
  updateAttempts: (message_id: string, attempts: number) => updateAttemptsStmt.run(attempts, message_id),
  deleteJob: (message_id: string) => deleteJobStmt.run(message_id),
  allJobs: () => selectAllJobsStmt.all() as DbJobRow[],
  jobCount: () => (countJobsStmt.get() as { c: number }).c,
  insertHistory: (row: DbHistoryRow) => insertHistoryStmt.run({
    ...row,
    quoty_customer_id: row.quoty_customer_id ?? null,
    metadata: row.metadata ?? null,
    jid: row.jid ?? null,
  }),
  findLastOutgoingByJid: (jid: string) => findLastOutgoingByJidStmt.get(jid) as { to_number: string; quoty_customer_id: string | null; metadata: string | null } | undefined,
  recentHistory: (limit = 50) => selectRecentHistoryStmt.all(limit) as DbHistoryRow[],
  searchHistory: (opts: { status?: 'sent' | 'failed' | 'all'; direction?: 'incoming' | 'outgoing' | 'all'; q?: string; limit: number; offset: number }) => {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.status && opts.status !== 'all') {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.direction && opts.direction !== 'all') {
      where.push('direction = ?');
      params.push(opts.direction);
    }
    if (opts.q) {
      where.push('(to_number LIKE ? OR from_number LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db
      .prepare(`SELECT * FROM messages_history ${whereSql} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as DbHistoryRow[];
    const total = (db
      .prepare(`SELECT COUNT(*) as c FROM messages_history ${whereSql}`)
      .get(...params) as { c: number }).c;
    return { rows, total };
  },
  clearHistory: () => db.prepare(`DELETE FROM messages_history`).run(),

  // webhook queue
  webhookEnqueue: (payload: string) =>
    db.prepare(`INSERT INTO webhook_queue (payload) VALUES (?)`).run(payload),
  webhookDue: () =>
    db
      .prepare(`SELECT id, payload, attempts FROM webhook_queue WHERE next_attempt_at <= datetime('now') ORDER BY id ASC LIMIT 20`)
      .all() as { id: number; payload: string; attempts: number }[],
  webhookDelete: (id: number) => db.prepare(`DELETE FROM webhook_queue WHERE id = ?`).run(id),
  webhookSchedule: (id: number, attempts: number, delaySec: number, error: string) =>
    db
      .prepare(`UPDATE webhook_queue SET attempts = ?, next_attempt_at = datetime('now', ?), last_error = ? WHERE id = ?`)
      .run(attempts, `+${delaySec} seconds`, error, id),
  webhookCount: () => (db.prepare(`SELECT COUNT(*) as c FROM webhook_queue`).get() as { c: number }).c,
  totals: () => {
    const r = statsTotalsStmt.get() as { sent: number | null; failed: number | null; received: number | null; total: number };
    return { sent: r.sent || 0, failed: r.failed || 0, received: r.received || 0, total: r.total || 0 } as Totals;
  },
  today: () => {
    const r = statsTodayStmt.get() as { sent: number | null; failed: number | null; received: number | null };
    return { sent: r.sent || 0, failed: r.failed || 0, received: r.received || 0 };
  },
  last7Days: () => statsLast7Stmt.all() as DayCount[],

  // content filters
  addFilter: (pattern: string, category: string) =>
    db.prepare(`INSERT OR IGNORE INTO content_filters (pattern, category) VALUES (?, ?)`).run(pattern.toLowerCase(), category),
  removeFilter: (id: number) => db.prepare(`DELETE FROM content_filters WHERE id = ?`).run(id),
  listFilters: () => db.prepare(`SELECT * FROM content_filters ORDER BY category, pattern`).all() as { id: number; pattern: string; category: string; created_at: string }[],
  checkContent: (text: string): string | null => {
    const lower = text.toLowerCase();
    const filters = db.prepare(`SELECT pattern, category FROM content_filters`).all() as { pattern: string; category: string }[];
    for (const f of filters) {
      if (lower.includes(f.pattern)) return f.pattern;
    }
    return null;
  },

  // blocklist
  isBlocked: (phone: string) => !!db.prepare(`SELECT 1 FROM blocklist WHERE phone = ?`).get(phone),
  blockNumber: (phone: string, reason: string) =>
    db.prepare(`INSERT OR REPLACE INTO blocklist (phone, reason) VALUES (?, ?)`).run(phone, reason),
  unblockNumber: (phone: string) => db.prepare(`DELETE FROM blocklist WHERE phone = ?`).run(phone),
  listBlocked: () => db.prepare(`SELECT * FROM blocklist ORDER BY created_at DESC`).all() as { phone: string; reason: string; created_at: string }[],

  // sessions
  listSessions: () => db.prepare(`SELECT * FROM sessions ORDER BY created_at ASC`).all() as DbSessionRow[],
  getSession: (id: string) => db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as DbSessionRow | undefined,
  getDefaultSession: () => db.prepare(`SELECT * FROM sessions WHERE is_default = 1 LIMIT 1`).get() as DbSessionRow | undefined,
  addSession: (id: string, name: string, isDefault: boolean) => {
    if (isDefault) db.prepare(`UPDATE sessions SET is_default = 0`).run();
    db.prepare(`INSERT INTO sessions (id, name, is_default) VALUES (?, ?, ?)`).run(id, name, isDefault ? 1 : 0);
  },
  removeSession: (id: string) => db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id),
  setDefaultSession: (id: string) => {
    db.prepare(`UPDATE sessions SET is_default = 0`).run();
    db.prepare(`UPDATE sessions SET is_default = 1 WHERE id = ?`).run(id);
  },
  renameSession: (id: string, name: string) => db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name, id),
};
