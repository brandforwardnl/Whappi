interface Entry {
  fails: number;
  lockedUntil: number;
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const map = new Map<string, Entry>();

export function isLocked(ip: string): boolean {
  const e = map.get(ip);
  if (!e) return false;
  if (e.lockedUntil > Date.now()) return true;
  if (e.lockedUntil > 0 && e.lockedUntil <= Date.now()) {
    map.delete(ip);
    return false;
  }
  return false;
}

export function recordFail(ip: string): void {
  const e = map.get(ip) || { fails: 0, lockedUntil: 0 };
  e.fails++;
  if (e.fails >= MAX_FAILS) {
    e.lockedUntil = Date.now() + LOCK_MS;
  }
  map.set(ip, e);
}

export function recordSuccess(ip: string): void {
  map.delete(ip);
}

export function lockedUntil(ip: string): number {
  return map.get(ip)?.lockedUntil || 0;
}
