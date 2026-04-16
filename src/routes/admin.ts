import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import qrcode from 'qrcode';
import { whatsapp } from '../whatsapp';
import { queue } from '../queue';
import { dbApi, DbHistoryRow } from '../db';
import { settings, verifyPassword } from '../settings';
import { bus, emitUpdate } from '../events';
import { isLocked, recordFail, recordSuccess, lockedUntil } from '../loginGuard';
import { buildHelpPage } from './helpPage';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PKG_VERSION = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version as string;

interface AdminOpts {
  secret: string;
}

const COOKIE_NAME = 'whappi_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] as string));
}

function sparkline(values: number[], max: number): string {
  if (values.length === 0) return '';
  const w = 240;
  const h = 56;
  const pad = 4;
  const step = values.length === 1 ? 0 : (w - pad * 2) / (values.length - 1);
  const top = max || 1;
  const points = values
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v / top) * (h - pad * 2));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const area = `${pad},${h - pad} ${points} ${w - pad},${h - pad}`;
  return `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#22c55e" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="${area}" fill="url(#sparkFill)" />
      <polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function buildLast7(rows: { day: string; c: number }[]): { labels: string[]; values: number[]; max: number } {
  const map = new Map(rows.map((r) => [r.day, r.c]));
  const labels: string[] = [];
  const values: number[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    values.push(map.get(key) || 0);
  }
  return { labels, values, max: Math.max(...values, 1) };
}

type NavKey = 'dashboard' | 'queue' | 'messages' | 'blocklist' | 'filters' | 'sessions' | 'settings' | 'help';

function renderSidebar(active: NavKey, currentUser: string): string {
  const item = (key: NavKey, href: string, icon: string, label: string) => {
    const cls = key === active ? 'active' : '';
    return `<a href="${href}" class="${cls}">${icon}${label}</a>`;
  };
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    messages: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    filters: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    blocklist: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    sessions: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    brand: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  };
  return `<div class="mobile-backdrop" onclick="document.querySelector('.sidebar').classList.remove('open');this.classList.remove('show');"></div>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-dot">${icons.brand}</div>
      <span>Whappi</span>
    </div>
    <div class="nav-section">Management</div>
    <nav class="nav">
      ${item('dashboard', '/admin', icons.dashboard, 'Dashboard')}
      ${item('queue', '/admin/queue', icons.queue, 'Queue')}
      ${item('messages', '/admin/messages', icons.messages, 'Messages')}
      ${item('blocklist', '/admin/blocklist', icons.blocklist, 'Blocklist')}
      ${item('filters', '/admin/filters', icons.filters, 'Content Filter')}
      ${item('sessions', '/admin/sessions', icons.sessions, 'Sessions')}
      ${item('settings', '/admin/settings', icons.settings, 'Settings')}
      ${item('help', '/admin/help', icons.help, 'Help & API')}
    </nav>
    <div class="sidebar-foot">
      <div class="theme-toggle">
        <button type="button" class="theme-btn" data-set="light" title="Light mode">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </button>
        <button type="button" class="theme-btn" data-set="system" title="System default">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </button>
        <button type="button" class="theme-btn" data-set="dark" title="Dark mode">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
      <form method="POST" action="/logout">
        <button type="submit" class="logout-btn">${icons.logout}Log out (${escapeHtml(currentUser)})</button>
      </form>
    </div>
  </aside>
  <button class="mobile-menu-btn" type="button" aria-label="Menu" onclick="document.querySelector('.sidebar').classList.toggle('open');document.querySelector('.mobile-backdrop').classList.toggle('show');">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>`;
}

const SIDEBAR_CSS = `
  .sidebar { width: 240px; background: linear-gradient(180deg, #0f172a 0%, #111827 100%); color: #cbd5e1; padding: 28px 20px; flex-shrink: 0; height: 100vh; position: sticky; top: 0; display: flex; flex-direction: column; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; color: #fff; margin-bottom: 36px; }
  .brand-dot { width: 32px; height: 32px; background: linear-gradient(135deg, #22c55e, #16a34a); border-radius: 9px; display: grid; place-items: center; box-shadow: 0 8px 24px -8px rgba(34,197,94,0.6); }
  .brand-dot svg { width: 18px; height: 18px; }
  .nav-section { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin: 18px 0 10px; }
  .nav a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: var(--text-light); text-decoration: none; font-weight: 500; transition: background 0.15s, color 0.15s; }
  .nav a svg { width: 18px; height: 18px; stroke: currentColor; flex-shrink: 0; }
  .nav a.active { background: linear-gradient(135deg, rgba(34,197,94,0.18), rgba(34,197,94,0.06)); color: #fff; box-shadow: inset 0 0 0 1px rgba(34,197,94,0.25); }
  .nav a.active svg { color: #22c55e; }
  .nav a:hover { background: rgba(255,255,255,0.05); color: #fff; }
  .sidebar-foot { margin-top: auto; padding-top: 12px; }
  .theme-toggle { display: flex; gap: 4px; padding: 4px 8px; margin-bottom: 8px; }
  .theme-btn { width: 30px; height: 28px; border-radius: 6px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, color 0.15s; }
  .theme-btn svg { width: 14px; height: 14px; }
  .theme-btn:hover { background: rgba(255,255,255,0.08); color: #cbd5e1; }
  .theme-btn.active { background: rgba(34,197,94,0.18); color: #22c55e; }
  .logout-btn { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: transparent; border: none; cursor: pointer; color: #cbd5e1; font-family: inherit; font-size: 11px; font-weight: 500; text-align: left; opacity: 0.7; transition: opacity 0.15s; }
  .logout-btn:hover { opacity: 1; }
  .logout-btn svg { width: 13px; height: 13px; }
  .version-footer { text-align: center; padding: 40px 0 20px; font-size: 12px; color: var(--text-light); }
  .version-footer span { background: var(--bg-card); border: 1px solid var(--border); padding: 4px 14px; border-radius: 999px; font-weight: 500; }
  .mobile-menu-btn { display: none; position: fixed; top: 14px; left: 14px; z-index: 100; width: 42px; height: 42px; border-radius: 10px; background: #0f172a; color: #fff; border: 1px solid rgba(255,255,255,0.08); cursor: pointer; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(15,23,42,0.2); }
  .mobile-menu-btn svg { width: 20px; height: 20px; }
  .mobile-backdrop { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.5); z-index: 90; }
  .mobile-backdrop.show { display: block; }
  @media (max-width: 720px) {
    .mobile-menu-btn { display: flex; }
    .sidebar { display: flex; position: fixed; top: 0; left: 0; height: 100vh; transform: translateX(-100%); transition: transform 0.25s ease; z-index: 95; box-shadow: 4px 0 24px rgba(0,0,0,0.3); }
    .sidebar.open { transform: translateX(0); }
    .sidebar.open ~ .mobile-menu-btn { display: none; }
    .main { padding: 70px 16px 24px !important; max-width: 100% !important; width: 100%; min-width: 0; }
    h1 { font-size: 20px !important; }
    .header { flex-direction: column; align-items: flex-start !important; gap: 12px; }
    .grid-stats { grid-template-columns: 1fr 1fr !important; gap: 12px !important; }
    .grid-main, .grid-actions { grid-template-columns: 1fr !important; }
    .card { padding: 16px 18px !important; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .stat-value { font-size: 22px !important; }
    .stat-label { font-size: 11px !important; }
    table { font-size: 12px !important; min-width: 480px; }
    th, td { padding: 8px 6px !important; }
    .toolbar { flex-direction: column; align-items: stretch !important; gap: 10px !important; }
    .toolbar form.search, .toolbar .tabs { width: 100%; }
    .session-card { padding: 16px !important; }
    .help-section { padding: 20px 18px !important; }
    .help-section h2 { font-size: 16px !important; }
    .code pre { padding: 12px 14px !important; }
    .code code { font-size: 11px !important; }
    .footer { flex-direction: column; gap: 12px; align-items: stretch !important; }
    .pager { justify-content: center; }
    .add-row { flex-direction: column; align-items: stretch !important; }
    .add-row input[type=text] { min-width: 0 !important; }
    body { display: block; }
    .main { display: block; }
  }
`;

const STATUS_LABEL: Record<string, string> = {
  open: 'Connected',
  connecting: 'Connecting…',
  closed: 'Offline',
};

const THEME_CSS = `
  :root {
    --bg: #f5f6fa; --bg-card: #fff; --bg-input: #f8fafc;
    --text: #0f172a; --text-muted: #64748b; --text-light: #94a3b8; --text-mid: #475569;
    --border: #e2e8f0; --border-light: #f1f5f9; --border-card: rgba(15,23,42,0.04);
    --shadow-card: 0 1px 2px rgba(15,23,42,0.04), 0 4px 16px -8px rgba(15,23,42,0.08);
    --pill-ok-bg: #dcfce7; --pill-ok-text: #15803d;
    --pill-fail-bg: #fee2e2; --pill-fail-text: #b91c1c;
    --pill-in-bg: #dbeafe; --pill-in-text: #1d4ed8;
    --pill-out-bg: #f3e8ff; --pill-out-text: #7c3aed;
    --status-ok: #22c55e; --status-warn: #f59e0b; --status-err: #ef4444;
    --table-stripe: #f8fafc;
  }
  [data-theme="dark"] {
    --bg: #0f172a; --bg-card: #1e293b; --bg-input: #1e293b;
    --text: #e2e8f0; --text-muted: #94a3b8; --text-light: #64748b; --text-mid: #cbd5e1;
    --border: #334155; --border-light: #1e293b; --border-card: rgba(255,255,255,0.06);
    --shadow-card: 0 1px 2px rgba(0,0,0,0.2), 0 4px 16px -8px rgba(0,0,0,0.3);
    --pill-ok-bg: rgba(34,197,94,0.15); --pill-ok-text: #4ade80;
    --pill-fail-bg: rgba(239,68,68,0.15); --pill-fail-text: #fca5a5;
    --pill-in-bg: rgba(59,130,246,0.15); --pill-in-text: #60a5fa;
    --pill-out-bg: rgba(139,92,246,0.15); --pill-out-text: #a78bfa;
    --table-stripe: #1a2332;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f172a; --bg-card: #1e293b; --bg-input: #1e293b;
      --text: #e2e8f0; --text-muted: #94a3b8; --text-light: #64748b; --text-mid: #cbd5e1;
      --border: #334155; --border-light: #1e293b; --border-card: rgba(255,255,255,0.06);
      --shadow-card: 0 1px 2px rgba(0,0,0,0.2), 0 4px 16px -8px rgba(0,0,0,0.3);
      --pill-ok-bg: rgba(34,197,94,0.15); --pill-ok-text: #4ade80;
      --pill-fail-bg: rgba(239,68,68,0.15); --pill-fail-text: #fca5a5;
      --table-stripe: #1a2332;
    }
  }
`;

function themeAttr(): string {
  const t = settings.getTheme();
  if (t === 'light' || t === 'dark') return ` data-theme="${t}"`;
  return '';
}

const THEME_SCRIPT = `
<script>
(function(){
  var theme = document.documentElement.getAttribute('data-theme');
  var btns = document.querySelectorAll('.theme-btn');
  function setActive(t) {
    btns.forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-set') === t); });
  }
  setActive(theme || 'system');
  btns.forEach(function(b) {
    b.addEventListener('click', function() {
      var t = b.getAttribute('data-set');
      if (t === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      setActive(t);
      fetch('/admin/theme', {method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({theme:t})});
    });
  });
})();
</script>
`;

const BASE_CSS = `
  ${THEME_CSS}
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-size: 14px;
  }
`;

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body {
      background: radial-gradient(ellipse at top, #1e293b 0%, #0f172a 60%);
      display: grid; place-items: center;
      color: #fff;
    }
    .login-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(10px);
      padding: 40px;
      border-radius: 20px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 30px 80px -20px rgba(0,0,0,0.5);
    }
    .brand {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 28px;
    }
    .brand-dot {
      width: 40px; height: 40px;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      border-radius: 11px;
      display: grid; place-items: center;
      box-shadow: 0 12px 28px -8px rgba(34,197,94,0.6);
    }
    .brand-dot svg { width: 22px; height: 22px; }
    .brand span { font-size: 20px; font-weight: 700; }
    h1 { font-size: 22px; margin: 0 0 6px; font-weight: 700; }
    p.sub { color: var(--text-light); margin: 0 0 24px; font-size: 13px; }
    label {
      display: block; font-size: 12px; font-weight: 600;
      color: #cbd5e1; margin-bottom: 6px;
    }
    input {
      width: 100%; padding: 12px 14px; border-radius: 11px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      color: #fff; font-size: 14px; font-family: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    input:focus {
      outline: none;
      border-color: #22c55e;
      background: rgba(255,255,255,0.07);
      box-shadow: 0 0 0 3px rgba(34,197,94,0.15);
    }
    .field { margin-bottom: 16px; }
    button {
      width: 100%; padding: 12px; border-radius: 11px; border: none;
      font-weight: 600; font-size: 14px; cursor: pointer;
      font-family: inherit; color: #fff;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      box-shadow: 0 12px 28px -10px rgba(34,197,94,0.6);
      margin-top: 6px;
    }
    button:hover { box-shadow: 0 16px 36px -10px rgba(34,197,94,0.7); }
    .error {
      background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.3);
      color: #fca5a5;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <form class="login-card" method="POST" action="/login">
    <div class="brand">
      <div class="brand-dot">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      </div>
      <span>Whappi</span>
    </div>
    <h1>Welcome back</h1>
    <p class="sub">Log in to manage your dashboard.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <div class="field">
      <label>Username</label>
      <input type="text" name="username" autocomplete="username" required autofocus />
    </div>
    <div class="field">
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required />
    </div>
    <button type="submit">Log in</button>
  </form>
${THEME_SCRIPT}
</body>
</html>`;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminOpts) {
  await app.register(cookie, { secret: opts.secret });

  function isAuthed(req: FastifyRequest): boolean {
    const raw = req.cookies[COOKIE_NAME];
    if (!raw) return false;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value === settings.getAdminUser();
  }

  // Prevent Cloudflare/browser from caching HTML responses
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
  });

  function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
    if (isAuthed(req)) return true;
    reply.redirect('/login');
    return false;
  }

  // GET /login
  app.get('/login', async (req, reply) => {
    if (isAuthed(req)) return reply.redirect('/admin');
    reply.type('text/html').send(loginPage());
  });

  // POST /login
  app.post<{ Body: { username?: string; password?: string } }>('/login', async (req, reply) => {
    const ip = req.ip;
    if (isLocked(ip)) {
      const mins = Math.ceil((lockedUntil(ip) - Date.now()) / 60000);
      reply.code(429).type('text/html').send(loginPage(`Too many failed attempts. Please try again in ${mins} minutes.`));
      return;
    }
    const u = (req.body?.username || '').trim();
    const p = req.body?.password || '';
    const expectedUser = settings.getAdminUser();
    const hash = settings.getAdminPasswordHash();
    if (u !== expectedUser || !verifyPassword(p, hash)) {
      recordFail(ip);
      reply.code(401).type('text/html').send(loginPage('Invalid username or password.'));
      return;
    }
    recordSuccess(ip);
    reply.setCookie(COOKIE_NAME, expectedUser, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: COOKIE_MAX_AGE,
    });
    reply.redirect('/admin');
  });

  // POST /logout
  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    reply.redirect('/login');
  });

  // GET /admin
  app.get('/admin', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const status = whatsapp.getStatus();
    const qr = whatsapp.getQr();
    const recent = whatsapp.getRecent();
    const totals = dbApi.totals();
    const today = dbApi.today();
    const series = buildLast7(dbApi.last7Days());
    const queueLen = queue.length();

    let qrBlock = '';
    if (qr) {
      const dataUrl = await qrcode.toDataURL(qr, { width: 220, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
      qrBlock = `
        <div class="qr-wrap">
          <img src="${dataUrl}" alt="QR" />
          <p class="muted">Scan with WhatsApp → Linked devices</p>
        </div>`;
    } else if (status === 'open') {
      qrBlock = `<div class="qr-wrap connected"><div class="checkmark">✓</div><p>Connected — no QR needed</p></div>`;
    } else {
      qrBlock = `<div class="qr-wrap"><p class="muted">Connecting…</p></div>`;
    }

    const recentRows = recent.length === 0
      ? `<tr><td colspan="6" class="empty">No messages yet.</td></tr>`
      : recent
          .map((r) => {
            const time = new Date(r.at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            const dirPill = r.direction === 'incoming'
              ? `<span class="pill pill-in">↓ in</span>`
              : `<span class="pill pill-out">↑ out</span>`;
            const statusPill = r.status === 'sent'
              ? `<span class="pill pill-ok">sent</span>`
              : r.status === 'received'
              ? `<span class="pill pill-ok">received</span>`
              : `<span class="pill pill-fail">failed</span>`;
            const number = r.direction === 'incoming' ? (r.from || '—') : r.to;
            return `
              <tr>
                <td>${escapeHtml(time)}</td>
                <td>${dirPill}</td>
                <td class="mono">${escapeHtml(number)}</td>
                <td>${statusPill}</td>
                <td class="mono small">${escapeHtml(r.message_id)}</td>
                <td class="error">${escapeHtml(r.error || '')}</td>
              </tr>`;
          })
          .join('');

    const sparkSvg = sparkline(series.values, series.max);
    const dayLabels = series.labels.map((l) => `<span>${l}</span>`).join('');

    const statusClass = status;
    const statusLabel = STATUS_LABEL[status] || status;

    const html = `<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}

    .main { flex: 1; padding: 32px 40px; max-width: 1280px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
    .header p { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
    .status-chip {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 999px;
      font-weight: 600; font-size: 12px;
      background: var(--bg-card); box-shadow: 0 2px 8px rgba(15,23,42,0.06);
    }
    .status-chip .dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-chip.open { color: #15803d; }
    .status-chip.open .dot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.18); }
    .status-chip.connecting { color: #b45309; }
    .status-chip.connecting .dot { background: #f59e0b; }
    .status-chip.closed { color: #b91c1c; }
    .status-chip.closed .dot { background: #ef4444; }

    .grid-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin-bottom: 24px; }
    .card {
      background: var(--bg-card); border-radius: 16px; padding: 20px 22px;
      box-shadow: var(--shadow-card);
      border: 1px solid var(--border-card);
    }
    .stat-label { color: var(--text-muted); font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat-value { font-size: 30px; font-weight: 700; margin: 6px 0 4px; letter-spacing: -0.02em; }
    .stat-sub { font-size: 12px; color: var(--text-muted); }
    .stat-sub.up { color: #15803d; }
    .stat-sub.down { color: #b91c1c; }

    .grid-main { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; margin-bottom: 24px; }
    .card h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; color: var(--text); }
    .card .subtle { color: var(--text-light); font-size: 12px; font-weight: 400; margin-left: 6px; }

    .spark-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-light); margin-top: 6px; }

    .qr-wrap { text-align: center; padding: 8px 0; }
    .qr-wrap img { border-radius: 12px; border: 1px solid var(--border); padding: 10px; background: var(--bg-card); }
    .qr-wrap.connected .checkmark {
      width: 80px; height: 80px; border-radius: 50%;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      color: #fff; font-size: 40px; font-weight: 700;
      display: grid; place-items: center; margin: 20px auto;
      box-shadow: 0 16px 40px -12px rgba(34,197,94,0.5);
    }
    .qr-wrap p { margin: 10px 0 0; }
    .muted { color: var(--text-light); font-size: 12px; }

    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; font-size: 13px; }
    th { color: var(--text-light); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
    td { border-bottom: 1px solid var(--border-light); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; }
    .small { color: var(--text-light); }
    .empty { text-align: center; color: var(--text-light); padding: 30px 0; }
    .error { color: #b91c1c; font-size: 12px; }

    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .pill-ok { background: var(--pill-ok-bg); color: var(--pill-ok-text); }
    .pill-fail { background: var(--pill-fail-bg); color: var(--pill-fail-text); }
    .pill-in { background: var(--pill-in-bg); color: var(--pill-in-text); }
    .pill-out { background: var(--pill-out-bg); color: var(--pill-out-text); }

    .grid-actions { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--text-mid); margin-bottom: 6px; }
    input[type=text], textarea {
      width: 100%; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--bg-input);
      font-size: 13px; font-family: inherit; color: var(--text);
      transition: border-color 0.15s, background 0.15s;
    }
    input[type=text]:focus, textarea:focus {
      outline: none; border-color: #22c55e; background: var(--bg-card);
      box-shadow: 0 0 0 3px rgba(34,197,94,0.12);
    }
    textarea { resize: vertical; min-height: 80px; }
    .field { margin-bottom: 14px; }
    button.btn {
      padding: 10px 18px; border-radius: 10px; border: none;
      font-weight: 600; font-size: 13px; cursor: pointer;
      font-family: inherit;
    }
    .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; box-shadow: 0 8px 20px -8px rgba(34,197,94,0.5); }
    .btn-primary:hover { box-shadow: 0 12px 28px -10px rgba(34,197,94,0.6); }
    .btn-danger { background: var(--bg-card); color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fef2f2; }

    @media (max-width: 1100px) {
      .grid-stats { grid-template-columns: repeat(2, 1fr); }
      .grid-main, .grid-actions { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .main { padding: 20px; padding-top: 70px; }
    }
  </style>
</head>
<body>
  ${renderSidebar('dashboard', settings.getAdminUser())}

  <main class="main">
    <div class="header">
      <div>
        <h1>Dashboard</h1>
        <p>Real-time overview of your WhatsApp service</p>
      </div>
      <span class="status-chip ${statusClass}"><span class="dot"></span>${statusLabel}</span>
    </div>

    <section class="grid-stats">
      <div class="card">
        <div class="stat-label">Sent today</div>
        <div class="stat-value">${today.sent}</div>
        <div class="stat-sub up">${today.failed} failed</div>
      </div>
      <div class="card">
        <div class="stat-label">Received today</div>
        <div class="stat-value">${today.received}</div>
        <div class="stat-sub">${totals.received} all-time</div>
      </div>
      <div class="card">
        <div class="stat-label">Total sent</div>
        <div class="stat-value">${totals.sent}</div>
        <div class="stat-sub">all-time</div>
      </div>
      <div class="card">
        <div class="stat-label">In queue</div>
        <div class="stat-value">${queueLen}</div>
        <div class="stat-sub">jobs in queue</div>
      </div>
    </section>

    <section class="grid-main">
      <div class="card">
        <h3>Activity <span class="subtle">last 7 days</span></h3>
        ${sparkSvg}
        <div class="spark-labels">${dayLabels}</div>
      </div>
      <div class="card" id="sessie">
        <h3>WhatsApp connection</h3>
        ${qrBlock}
      </div>
    </section>

    <section class="grid-actions">
      <div class="card" id="test">
        <h3>Send test message</h3>
        <form method="POST" action="/admin/test-send">
          <div class="field">
            <label>Phone number(s) <span style="color:#94a3b8;font-weight:400">— one per line or comma-separated</span></label>
            <textarea name="to" rows="3" placeholder="31612345678&#10;31698765432" required>${escapeHtml(settings.getLastTestNumber())}</textarea>
          </div>
          <div class="field">
            <label>Message</label>
            <textarea name="message" required>Test from Whappi ✅</textarea>
          </div>
          <button type="submit" class="btn btn-primary">Send test message</button>
        </form>
      </div>
      <div class="card">
        <h3>Session management</h3>
        <p class="muted">Reset to scan a new QR code. The existing linked session will be removed.</p>
        <form method="POST" action="/admin/reset" onsubmit="return confirm('Reset session and scan QR again?');">
          <button type="submit" class="btn btn-danger">Reset session</button>
        </form>
      </div>
    </section>

    <section class="card" id="history" style="margin-top: 18px;">
      <h3>Recent messages <span class="subtle">last 50</span> <span id="live-dot" class="live-dot" title="Real-time connected"></span></h3>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Dir</th>
            <th>Number</th>
            <th>Status</th>
            <th>Message ID</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="recent-tbody">${recentRows}</tbody>
      </table>
    </section>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>

  <style>
    .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; margin-left: 8px; vertical-align: middle; transition: background 0.2s, box-shadow 0.2s; }
    .live-dot.on { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.18); }
  </style>

  <script>
  (function() {
    var H = 'inner' + 'HTML';
    function fmt(at) {
      var d = new Date(at);
      return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    }
    function statusChip(s) {
      var labels = { open: 'Connected', connecting: 'Connecting…', closed: 'Offline' };
      var chip = document.querySelector('.status-chip');
      if (!chip) return;
      chip.className = 'status-chip ' + s;
      chip[H] = '<span class="dot"></span>' + (labels[s] || s);
    }
    function refresh() {
      fetch('/admin/data.json', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var stats = document.querySelectorAll('.stat-value');
          if (stats[0]) stats[0].textContent = data.today.sent;
          if (stats[1]) stats[1].textContent = data.today.received;
          if (stats[2]) stats[2].textContent = data.totals.sent;
          if (stats[3]) stats[3].textContent = data.queue_length;
          var subs = document.querySelectorAll('.stat-sub');
          if (subs[0]) subs[0].textContent = data.today.failed + ' failed';
          if (subs[1]) subs[1].textContent = data.totals.received + ' all-time';
          statusChip(data.whatsapp_status);

          var tbody = document.getElementById('recent-tbody');
          if (tbody) {
            if (data.recent.length === 0) {
              tbody[H] = '<tr><td colspan="6" class="empty">No messages yet.</td></tr>';
            } else {
              tbody[H] = data.recent.map(function(r) {
                var dirPill = r.direction === 'incoming'
                  ? '<span class="pill pill-in">\u2193 in</span>'
                  : '<span class="pill pill-out">\u2191 out</span>';
                var statusPill = r.status === 'sent'
                  ? '<span class="pill pill-ok">sent</span>'
                  : r.status === 'received'
                  ? '<span class="pill pill-ok">received</span>'
                  : '<span class="pill pill-fail">failed</span>';
                var num = r.direction === 'incoming' ? (r.from || '\u2014') : r.to;
                return '<tr><td>' + esc(fmt(r.at)) + '</td><td>' + dirPill + '</td><td class="mono">' + esc(num) + '</td><td>' + statusPill + '</td><td class="mono small">' + esc(r.message_id) + '</td><td class="error">' + esc(r.error) + '</td></tr>';
              }).join('');
            }
          }
        })
        .catch(function() {});
    }
    var dot = document.getElementById('live-dot');
    var es = new EventSource('/admin/events');
    es.addEventListener('ready', function() { if (dot) dot.classList.add('on'); });
    es.addEventListener('update', function() { refresh(); });
    es.onerror = function() { if (dot) dot.classList.remove('on'); };
  })();
  </script>
${THEME_SCRIPT}
</body>
</html>`;

    reply.type('text/html').send(html);
  });

  app.post<{ Body: { to?: string; message?: string } }>('/admin/test-send', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const rawTo = (req.body?.to || '').trim();
    const message = (req.body?.message || '').trim();
    if (!rawTo || !message) {
      reply.code(400).send('Fields "to" and "message" are required. <a href="/admin">Back</a>');
      return;
    }
    const numbers = rawTo
      .split(/[\s,;]+/)
      .map((n) => n.replace(/[^\d]/g, ''))
      .filter((n) => n.length > 0);
    if (numbers.length === 0) {
      reply.code(400).send('No valid numbers found. <a href="/admin">Back</a>');
      return;
    }
    const blockedWord = dbApi.checkContent(message);
    if (blockedWord) {
      reply.code(400).send(`Message blocked by content filter: "${escapeHtml(blockedWord)}". <a href="/admin">Back</a>`);
      return;
    }
    for (const to of numbers) {
      if (dbApi.isBlocked(to)) continue;
      queue.enqueue({ to, message });
    }
    settings.setLastTestNumber(numbers.join('\n'));
    reply.redirect('/admin');
  });

  app.post('/admin/reset', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const def = whatsapp.getDefaultId();
    if (def) whatsapp.resetSession(def).catch((e) => console.error('[admin] reset error', e));
    reply.redirect('/admin');
  });

  // ---- Sessions management ----
  app.post<{ Body: { name?: string; default?: string } }>('/admin/sessions/add', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const name = (req.body?.name || '').trim() || 'New number';
    const makeDefault = req.body?.default === 'on';
    await whatsapp.addSession(name, makeDefault);
    reply.redirect('/admin/sessions');
  });

  app.post<{ Params: { id: string } }>('/admin/sessions/:id/remove', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    await whatsapp.removeSession(req.params.id);
    reply.redirect('/admin/sessions');
  });

  app.post<{ Params: { id: string } }>('/admin/sessions/:id/default', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    whatsapp.setDefault(req.params.id);
    reply.redirect('/admin/sessions');
  });

  app.post<{ Params: { id: string } }>('/admin/sessions/:id/reset', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    whatsapp.resetSession(req.params.id).catch((e) => console.error('[admin] reset error', e));
    reply.redirect('/admin/sessions');
  });

  app.post<{ Params: { id: string }; Body: { name?: string } }>('/admin/sessions/:id/rename', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const name = (req.body?.name || '').trim();
    if (name) whatsapp.rename(req.params.id, name);
    reply.redirect('/admin/sessions');
  });

  // POST /admin/theme
  app.post<{ Body: { theme?: string } }>('/admin/theme', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const theme = req.body?.theme || 'system';
    if (['light', 'dark', 'system'].includes(theme)) {
      settings.setTheme(theme);
    }
    reply.send({ ok: true, theme });
  });

  // GET /admin/queue
  app.get('/admin/queue', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const jobs = dbApi.allJobs();
    const delaySec = settings.getQueueDelaySec();
    const sessionsList = whatsapp.list();
    const sessionMap = new Map(sessionsList.map((s) => [s.id, s]));

    const rows = jobs.length === 0
      ? `<tr><td colspan="6" class="empty">Queue is empty — all messages have been sent.</td></tr>`
      : jobs.map((j, idx) => {
          const sess = sessionMap.get(j.session_id || '');
          const sessName = sess?.name || 'default';
          const eta = idx * delaySec;
          const etaLabel = eta === 0 ? 'now' : `~${eta}s`;
          return `<tr>
            <td class="mono small">${escapeHtml(j.message_id)}</td>
            <td class="mono">${escapeHtml(j.to_number)}</td>
            <td>${escapeHtml(j.message.length > 60 ? j.message.slice(0, 60) + '…' : j.message)}</td>
            <td>${escapeHtml(sessName)}</td>
            <td>${j.attempts > 0 ? `<span class="pill pill-fail">${j.attempts}/3</span>` : '<span class="pill pill-ok">0</span>'}</td>
            <td class="muted">${etaLabel}</td>
          </tr>`;
        }).join('');

    reply.type('text/html').send(`<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Queue</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}

    .main { flex: 1; padding: 32px 40px; max-width: 1280px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }

    .stats-row { display: flex; gap: 18px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card { background: var(--bg-card); border-radius: 14px; padding: 18px 22px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); min-width: 160px; }
    .stat-card .label { font-size: 12px; color: var(--text-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }

    .card { background: var(--bg-card); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); }
    .card h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
    .card .subtle { color: var(--text-light); font-size: 12px; font-weight: 400; margin-left: 6px; }

    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; font-size: 13px; }
    th { color: var(--text-light); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
    td { border-bottom: 1px solid var(--border-light); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono','Menlo',monospace; font-size: 12px; }
    .small { color: var(--text-light); }
    .muted { color: var(--text-light); font-size: 12px; }
    .empty { text-align: center; color: var(--text-light); padding: 40px 0; }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .pill-ok { background: var(--pill-ok-bg); color: var(--pill-ok-text); }
    .pill-fail { background: var(--pill-fail-bg); color: var(--pill-fail-text); }
    .pill-in { background: var(--pill-in-bg); color: var(--pill-in-text); }
    .pill-out { background: var(--pill-out-bg); color: var(--pill-out-text); }
    .progress { height: 4px; background: var(--border-light); border-radius: 4px; overflow: hidden; margin-top: 18px; }
    .progress-bar { height: 100%; background: linear-gradient(90deg, #22c55e, #16a34a); border-radius: 4px; transition: width 0.5s ease; }

    @media (max-width: 720px) { .main { padding: 70px 16px 24px !important; } .stats-row { flex-direction: column; } .stat-card { min-width: 0; } table { min-width: 480px; } .card { overflow-x: auto; -webkit-overflow-scrolling: touch; } }
  </style>
</head>
<body>
  ${renderSidebar('queue', settings.getAdminUser())}

  <main class="main">
    <h1>Queue</h1>
    <p class="sub">Live overview of messages waiting to be sent. Delay: <strong>${delaySec}s</strong> per message.</p>

    <div class="stats-row">
      <div class="stat-card">
        <div class="label">In queue</div>
        <div class="value">${jobs.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Delay per message</div>
        <div class="value">${delaySec}s</div>
      </div>
      <div class="stat-card">
        <div class="label">Estimated total wait time</div>
        <div class="value">${jobs.length > 0 ? `~${jobs.length * delaySec}s` : '—'}</div>
      </div>
    </div>

    <div class="card">
      <h3>Messages in queue <span class="subtle">${jobs.length} items</span></h3>
      ${jobs.length > 0 ? '<div class="progress"><div class="progress-bar" style="width: 100%; animation: pulse 1.5s infinite;"></div></div>' : ''}
      <style>@keyframes pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }</style>
      <table>
        <thead>
          <tr>
            <th>Message ID</th>
            <th>To</th>
            <th>Message</th>
            <th>Session</th>
            <th>Retries</th>
            <th>ETA</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>

  <script>
  (function() {
    var es = new EventSource('/admin/events');
    var pending = false;
    es.addEventListener('update', function() {
      if (pending) return;
      pending = true;
      setTimeout(function() { location.reload(); }, 600);
    });
  })();
  </script>
</body>
</html>`);
  });

  // Content filters
  app.get('/admin/filters', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const filters = dbApi.listFilters();
    const categories = [...new Set(filters.map((f) => f.category))].sort();

    const groupedHtml = categories.length === 0
      ? `<tr><td colspan="4" class="empty">No filters configured.</td></tr>`
      : categories.map((cat) => {
          const items = filters.filter((f) => f.category === cat);
          return `<tr><td colspan="4" style="background:#f8fafc;font-weight:600;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;padding:10px 8px;">${escapeHtml(cat)} (${items.length})</td></tr>` +
            items.map((f) => `<tr>
              <td class="mono">${escapeHtml(f.pattern)}</td>
              <td>${escapeHtml(f.category)}</td>
              <td class="muted">${new Date(f.created_at).toLocaleDateString('en-US')}</td>
              <td><form method="POST" action="/admin/filters/remove" style="margin:0;"><input type="hidden" name="id" value="${f.id}" /><button class="btn btn-danger" type="submit">Remove</button></form></td>
            </tr>`).join('');
        }).join('');

    reply.type('text/html').send(`<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Content filter</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}
    .main { flex: 1; padding: 32px 40px; max-width: 1280px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }
    .card { background: var(--bg-card); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); margin-bottom: 18px; }
    .card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .card .help { color: var(--text-light); font-size: 12px; margin: 0 0 14px; }
    .add-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .add-row input, .add-row select { flex: 1; min-width: 140px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-input); font-size: 13px; font-family: inherit; }
    .add-row input:focus, .add-row select:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; font-size: 13px; }
    th { color: var(--text-light); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
    td { border-bottom: 1px solid var(--border-light); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono','Menlo',monospace; font-size: 12px; }
    .muted { color: var(--text-light); font-size: 12px; }
    .empty { text-align: center; color: var(--text-light); padding: 40px 0; }
    .btn { padding: 6px 12px; border-radius: 8px; border: none; font-weight: 600; font-size: 12px; cursor: pointer; font-family: inherit; }
    .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; box-shadow: 0 8px 20px -8px rgba(34,197,94,0.5); padding: 10px 18px; font-size: 13px; }
    .btn-danger { background: var(--bg-card); color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fef2f2; }
    .count { color: var(--text-muted); font-size: 13px; margin-top: 14px; }
    @media (max-width: 720px) { .main { padding: 70px 16px 24px !important; } .add-row { flex-direction: column; align-items: stretch; } .add-row input, .add-row select { min-width: 0; } table { min-width: 400px; } .card { overflow-x: auto; -webkit-overflow-scrolling: touch; } }
  </style>
</head>
<body>
  ${renderSidebar('filters', settings.getAdminUser())}

  <main class="main">
    <h1>Content filter</h1>
    <p class="sub">Messages containing these words/phrases will be rejected by <span class="mono">/api/send</span>. Case-insensitive substring match.</p>

    <div class="card">
      <h3>Add filter</h3>
      <p class="help">Add a word or phrase. Choose a category.</p>
      <form method="POST" action="/admin/filters/add">
        <div class="add-row">
          <input type="text" name="pattern" placeholder="E.g. free, click here, crypto" required />
          <select name="category">
            <option value="spam">Spam</option>
            <option value="phishing">Phishing</option>
            <option value="promotion">Promotion</option>
            <option value="other">Other</option>
          </select>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3>Active filters</h3>
      <table>
        <thead><tr><th>Pattern</th><th>Category</th><th>Added</th><th></th></tr></thead>
        <tbody>${groupedHtml}</tbody>
      </table>
      <div class="count">${filters.length} ${filters.length === 1 ? 'filter' : 'filters'} active</div>
    </div>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>
</body>
</html>`);
  });

  app.post<{ Body: { pattern?: string; category?: string } }>('/admin/filters/add', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const pattern = (req.body?.pattern || '').trim();
    const category = (req.body?.category || 'other').trim();
    if (pattern) dbApi.addFilter(pattern, category);
    reply.redirect('/admin/filters');
  });

  app.post<{ Body: { id?: string } }>('/admin/filters/remove', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const id = parseInt(req.body?.id || '', 10);
    if (id) dbApi.removeFilter(id);
    reply.redirect('/admin/filters');
  });

  // Seed default filters if table is empty
  {
    const existing = dbApi.listFilters();
    if (existing.length === 0) {
      const defaults: [string, string][] = [
        // Spam triggers
        ['gratis geld', 'spam'],
        ['free money', 'spam'],
        ['win een', 'spam'],
        ['you have won', 'spam'],
        ['congratulations you won', 'spam'],
        ['claim your prize', 'spam'],
        ['lottery', 'spam'],
        ['loterij', 'spam'],
        ['jackpot', 'spam'],
        ['100% gratis', 'spam'],
        ['100% free', 'spam'],
        ['act now', 'spam'],
        ['limited time offer', 'spam'],
        ['once in a lifetime', 'spam'],
        ['no cost', 'spam'],
        ['risk free', 'spam'],
        // Phishing
        ['verify your account', 'phishing'],
        ['confirm your identity', 'phishing'],
        ['update your payment', 'phishing'],
        ['your account has been suspended', 'phishing'],
        ['click here to verify', 'phishing'],
        ['log in immediately', 'phishing'],
        ['urgent action required', 'phishing'],
        ['we noticed suspicious activity', 'phishing'],
        ['bevestig uw identiteit', 'phishing'],
        ['uw account is geblokkeerd', 'phishing'],
        // Crypto / finance scams
        ['crypto investment', 'spam'],
        ['bitcoin opportunity', 'spam'],
        ['guaranteed return', 'spam'],
        ['gegarandeerd rendement', 'spam'],
        ['earn money fast', 'spam'],
        ['snel geld verdienen', 'spam'],
        ['forex signal', 'spam'],
        ['investment opportunity', 'spam'],
        // Promotion / aggressive marketing
        ['klik hier voor korting', 'promotion'],
        ['exclusive deal', 'promotion'],
        ['buy now', 'promotion'],
        ['order now', 'promotion'],
        ['unsubscribe', 'promotion'],
        ['uitschrijven', 'promotion'],
      ];
      for (const [p, c] of defaults) {
        dbApi.addFilter(p, c);
      }
    }
  }

  // Blocklist
  app.get('/admin/blocklist', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const list = dbApi.listBlocked();
    const rows = list.length === 0
      ? `<tr><td colspan="4" class="empty">No blocked numbers.</td></tr>`
      : list.map((b) => `<tr>
          <td class="mono">${escapeHtml(b.phone)}</td>
          <td>${escapeHtml(b.reason || '—')}</td>
          <td class="muted">${new Date(b.created_at).toLocaleString('en-US')}</td>
          <td><form method="POST" action="/admin/blocklist/remove" style="margin:0;"><input type="hidden" name="phone" value="${escapeHtml(b.phone)}" /><button class="btn btn-danger" type="submit">Unblock</button></form></td>
        </tr>`).join('');

    reply.type('text/html').send(`<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Blocklist</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}
    .main { flex: 1; padding: 32px 40px; max-width: 1280px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }
    .card { background: var(--bg-card); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); margin-bottom: 18px; }
    .card h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
    .add-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .add-row input { flex: 1; min-width: 160px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-input); font-size: 13px; font-family: inherit; }
    .add-row input:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--text-mid); margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; font-size: 13px; }
    th { color: var(--text-light); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
    td { border-bottom: 1px solid var(--border-light); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono','Menlo',monospace; font-size: 12px; }
    .muted { color: var(--text-light); font-size: 12px; }
    .empty { text-align: center; color: var(--text-light); padding: 40px 0; }
    .btn { padding: 6px 12px; border-radius: 8px; border: none; font-weight: 600; font-size: 12px; cursor: pointer; font-family: inherit; }
    .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; box-shadow: 0 8px 20px -8px rgba(34,197,94,0.5); padding: 10px 18px; font-size: 13px; }
    .btn-danger { background: var(--bg-card); color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fef2f2; }
    .count { color: var(--text-muted); font-size: 13px; margin-top: 14px; }
    @media (max-width: 720px) { .main { padding: 70px 16px 24px !important; } .add-row { flex-direction: column; align-items: stretch; } .add-row input { min-width: 0; } table { min-width: 400px; } .card { overflow-x: auto; -webkit-overflow-scrolling: touch; } }
  </style>
</head>
<body>
  ${renderSidebar('blocklist', settings.getAdminUser())}

  <main class="main">
    <h1>Blocklist</h1>
    <p class="sub">Numbers on this list will be rejected by <span class="mono">/api/send</span>. Whappi will not send messages to blocked numbers.</p>

    <div class="card">
      <h3>Block number</h3>
      <form method="POST" action="/admin/blocklist/add">
        <div class="add-row">
          <input type="text" name="phone" placeholder="31612345678" required />
          <input type="text" name="reason" placeholder="Reason (optional)" />
          <button type="submit" class="btn btn-primary">Block</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3>Blocked numbers</h3>
      <table>
        <thead><tr><th>Number</th><th>Reason</th><th>Blocked on</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="count">${list.length} ${list.length === 1 ? 'number' : 'numbers'} blocked</div>
    </div>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>
</body>
</html>`);
  });

  app.post<{ Body: { phone?: string; reason?: string } }>('/admin/blocklist/add', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const phone = (req.body?.phone || '').trim().replace(/[^\d]/g, '');
    const reason = (req.body?.reason || '').trim();
    if (phone) dbApi.blockNumber(phone, reason);
    reply.redirect('/admin/blocklist');
  });

  app.post<{ Body: { phone?: string } }>('/admin/blocklist/remove', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const phone = (req.body?.phone || '').trim();
    if (phone) dbApi.unblockNumber(phone);
    reply.redirect('/admin/blocklist');
  });

  // GET /admin/help
  app.get('/admin/help', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const apiKey = settings.getApiKey();
    const baseUrl = `${req.protocol}://${req.headers.host || 'localhost:3100'}`;
    reply.type('text/html').send(buildHelpPage({
      baseUrl,
      apiKey,
      sidebarHtml: renderSidebar('help', settings.getAdminUser()),
      baseCss: BASE_CSS,
      sidebarCss: SIDEBAR_CSS,
    }));
  });

  app.get('/admin/sessions', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const list = whatsapp.list();
    const cards: string[] = [];
    for (const s of list) {
      let qrBlock = '';
      if (s.latestQr) {
        const dataUrl = await qrcode.toDataURL(s.latestQr, { width: 200, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
        qrBlock = `<img src="${dataUrl}" alt="QR" style="border-radius:10px;border:1px solid #e2e8f0;padding:8px;background:#fff;" />`;
      } else if (s.status === 'open') {
        qrBlock = `<div style="width:200px;height:200px;display:grid;place-items:center;background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:14px;color:#fff;font-size:60px;font-weight:700;box-shadow:0 12px 30px -10px rgba(34,197,94,0.5);">✓</div>`;
      } else {
        qrBlock = `<div style="width:200px;height:200px;display:grid;place-items:center;background:#f1f5f9;border-radius:14px;color:#94a3b8;">connecting…</div>`;
      }
      const statusLabel = s.status === 'open' ? 'Connected' : s.status === 'connecting' ? 'Connecting…' : 'Offline';
      cards.push(`
        <div class="session-card">
          <div class="session-head">
            <form method="POST" action="/admin/sessions/${escapeHtml(s.id)}/rename" class="rename">
              <input type="text" name="name" value="${escapeHtml(s.name)}" />
            </form>
            <span class="status-chip ${s.status}"><span class="dot"></span>${statusLabel}</span>
          </div>
          ${s.isDefault ? '<div class="default-badge">★ Default session</div>' : ''}
          <div class="qr-area">${qrBlock}</div>
          <div class="actions">
            ${!s.isDefault ? `<form method="POST" action="/admin/sessions/${escapeHtml(s.id)}/default"><button class="btn btn-secondary">Make default</button></form>` : ''}
            <form method="POST" action="/admin/sessions/${escapeHtml(s.id)}/reset" onsubmit="return confirm('Reset session? You will need to scan the QR again.');"><button class="btn btn-secondary">Reset</button></form>
            <form method="POST" action="/admin/sessions/${escapeHtml(s.id)}/remove" onsubmit="return confirm('Permanently remove this session?');"><button class="btn btn-danger">Remove</button></form>
          </div>
          <div class="muted mono">${escapeHtml(s.id)}</div>
        </div>
      `);
    }
    reply.type('text/html').send(sessionsPage(cards.join('')));
  });

  // GET /admin/messages
  app.get<{ Querystring: { status?: string; direction?: string; q?: string; page?: string } }>('/admin/messages', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const status = (['sent', 'failed', 'all'].includes(req.query?.status || '') ? req.query!.status : 'all') as 'sent' | 'failed' | 'all';
    const direction = (['incoming', 'outgoing', 'all'].includes(req.query?.direction || '') ? req.query!.direction : 'all') as 'incoming' | 'outgoing' | 'all';
    const q = (req.query?.q || '').trim();
    const page = Math.max(1, parseInt(req.query?.page || '1', 10) || 1);
    const limit = 100;
    const offset = (page - 1) * limit;
    const { rows, total } = dbApi.searchHistory({ status, direction, q, limit, offset });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    reply.type('text/html').send(messagesPage({ rows, total, page, totalPages, status, direction, q }));
  });

  // CSV export
  app.get<{ Querystring: { status?: string; direction?: string; q?: string } }>('/admin/messages.csv', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const status = (['sent', 'failed', 'all'].includes(req.query?.status || '') ? req.query!.status : 'all') as 'sent' | 'failed' | 'all';
    const direction = (['incoming', 'outgoing', 'all'].includes(req.query?.direction || '') ? req.query!.direction : 'all') as 'incoming' | 'outgoing' | 'all';
    const q = (req.query?.q || '').trim();
    const { rows } = dbApi.searchHistory({ status, direction, q, limit: 100000, offset: 0 });
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = ['at,direction,number,status,message_id,error'];
    for (const r of rows) {
      const number = r.direction === 'incoming' ? (r.from_number || '') : r.to_number;
      lines.push([escape(r.at), escape(r.direction || 'outgoing'), escape(number), escape(r.status), escape(r.message_id), escape(r.error || '')].join(','));
    }
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="whappi-messages-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(lines.join('\n'));
  });

  app.post('/admin/messages/clear', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    dbApi.clearHistory();
    emitUpdate();
    reply.redirect('/admin/messages');
  });

  // JSON snapshot for client-side updates
  app.get('/admin/data.json', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const recent = whatsapp.getRecent().slice(0, 50).map((r) => ({
      message_id: r.message_id,
      to: r.to,
      status: r.status,
      at: r.at,
      error: r.error || null,
      direction: r.direction || 'outgoing',
      from: r.from || null,
    }));
    reply.send({
      whatsapp_status: whatsapp.getStatus(),
      queue_length: queue.length(),
      totals: dbApi.totals(),
      today: dbApi.today(),
      recent,
    });
  });

  // Server-Sent Events stream
  app.get('/admin/events', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: 3000\n\n`);
    reply.raw.write(`event: ready\ndata: {}\n\n`);

    const onUpdate = () => {
      reply.raw.write(`event: update\ndata: ${Date.now()}\n\n`);
    };
    bus.on('update', onUpdate);

    const ka = setInterval(() => {
      reply.raw.write(`: ka\n\n`);
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(ka);
      bus.off('update', onUpdate);
    });
  });

  // GET /admin/settings
  app.get<{ Querystring: { ok?: string; err?: string } }>('/admin/settings', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const ok = req.query?.ok;
    const err = req.query?.err;
    reply.type('text/html').send(settingsPage({ ok, err }));
  });

  // POST /admin/settings
  app.post<{ Body: { admin_user?: string; new_password?: string; api_key?: string; webhook_url?: string; recipient_throttle_sec?: string; burst_per_minute?: string; queue_delay_sec?: string; api_ip_allowlist?: string; current_password?: string } }>('/admin/settings', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const newUser = (req.body?.admin_user || '').trim();
    const newPassword = req.body?.new_password || '';
    const newApiKey = (req.body?.api_key || '').trim();
    const newWebhookUrl = (req.body?.webhook_url || '').trim();
    const newThrottleSec = parseInt(req.body?.recipient_throttle_sec || '60', 10);
    const newBurst = parseInt(req.body?.burst_per_minute || '30', 10);
    const newQueueDelay = parseInt(req.body?.queue_delay_sec || '5', 10);
    const newAllowlist = (req.body?.api_ip_allowlist || '').trim();
    const currentPassword = req.body?.current_password || '';

    if (!newUser) return reply.redirect('/admin/settings?err=' + encodeURIComponent('Username cannot be empty'));
    if (newApiKey && newApiKey.length < 32) {
      return reply.redirect('/admin/settings?err=' + encodeURIComponent('API key must be at least 32 characters'));
    }
    if (newWebhookUrl && !/^https?:\/\//i.test(newWebhookUrl)) {
      return reply.redirect('/admin/settings?err=' + encodeURIComponent('Webhook URL must start with http:// or https://'));
    }
    if (!verifyPassword(currentPassword, settings.getAdminPasswordHash())) {
      return reply.redirect('/admin/settings?err=' + encodeURIComponent('Current password is incorrect'));
    }

    settings.setAdminUser(newUser);
    if (newPassword) settings.setAdminPassword(newPassword);
    if (newApiKey) settings.setApiKey(newApiKey);
    settings.setWebhookUrl(newWebhookUrl);
    settings.setRecipientThrottleSec(Number.isFinite(newThrottleSec) && newThrottleSec >= 0 ? newThrottleSec : 60);
    settings.setBurstPerMinute(Number.isFinite(newBurst) && newBurst >= 0 ? newBurst : 30);
    settings.setQueueDelaySec(Number.isFinite(newQueueDelay) && newQueueDelay >= 1 ? newQueueDelay : 5);
    settings.setApiIpAllowlist(newAllowlist);

    // Re-set cookie if username changed
    reply.setCookie(COOKIE_NAME, newUser, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: COOKIE_MAX_AGE,
    });

    reply.redirect('/admin/settings?ok=1');
  });
}

interface MessagesPageOpts {
  rows: DbHistoryRow[];
  total: number;
  page: number;
  totalPages: number;
  status: 'sent' | 'failed' | 'all';
  direction: 'incoming' | 'outgoing' | 'all';
  q: string;
}

function messagesPage(opts: MessagesPageOpts): string {
  const { rows, total, page, totalPages, status, direction, q } = opts;

  const statusTabs = (['all', 'sent', 'failed'] as const)
    .map((s) => {
      const params = new URLSearchParams();
      if (s !== 'all') params.set('status', s);
      if (direction !== 'all') params.set('direction', direction);
      if (q) params.set('q', q);
      const label = s === 'all' ? 'All' : s === 'sent' ? 'Sent' : 'Failed';
      const cls = s === status ? 'tab active' : 'tab';
      return `<a class="${cls}" href="/admin/messages?${params.toString()}">${label}</a>`;
    })
    .join('');

  const dirTabs = (['all', 'incoming', 'outgoing'] as const)
    .map((d) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (d !== 'all') params.set('direction', d);
      if (q) params.set('q', q);
      const label = d === 'all' ? 'All' : d === 'incoming' ? '↓ Incoming' : '↑ Outgoing';
      const cls = d === direction ? 'tab active' : 'tab';
      return `<a class="${cls}" href="/admin/messages?${params.toString()}">${label}</a>`;
    })
    .join('');

  const tableRows = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No messages found.</td></tr>`
    : rows
        .map((r) => {
          const time = new Date(r.at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
          const dir = (r.direction || 'outgoing') as string;
          const dirPill = dir === 'incoming'
            ? `<span class="pill pill-in">↓ in</span>`
            : `<span class="pill pill-out">↑ out</span>`;
          const statusPill = r.status === 'sent'
            ? `<span class="pill pill-ok">sent</span>`
            : r.status === 'received'
            ? `<span class="pill pill-ok">received</span>`
            : `<span class="pill pill-fail">failed</span>`;
          const number = dir === 'incoming' ? (r.from_number || '—') : r.to_number;
          return `
            <tr>
              <td>${escapeHtml(time)}</td>
              <td>${dirPill}</td>
              <td class="mono">${escapeHtml(number)}</td>
              <td>${statusPill}</td>
              <td class="mono small">${escapeHtml(r.message_id)}</td>
              <td class="error">${escapeHtml(r.error || '')}</td>
            </tr>`;
        })
        .join('');

  const pagerLink = (p: number, label: string, disabled = false) => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (direction !== 'all') params.set('direction', direction);
    if (q) params.set('q', q);
    if (p > 1) params.set('page', String(p));
    return disabled
      ? `<span class="pager-btn disabled">${label}</span>`
      : `<a class="pager-btn" href="/admin/messages?${params.toString()}">${label}</a>`;
  };

  return `<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Messages</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}

    .main { flex: 1; padding: 32px 40px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }
    .card { background: var(--bg-card); border-radius: 16px; padding: 22px 26px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); }

    .toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
    .tabs { display: flex; gap: 4px; background: var(--border-light); padding: 4px; border-radius: 10px; }
    .tab { padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--text-muted); text-decoration: none; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--bg-card); color: var(--text); box-shadow: 0 1px 3px rgba(15,23,42,0.08); }
    form.search { display: flex; gap: 8px; flex: 1; min-width: 220px; }
    form.search input {
      flex: 1; padding: 9px 12px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--bg-input);
      font-size: 13px; font-family: inherit;
    }
    form.search input:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    .btn { padding: 9px 16px; border-radius: 10px; border: none; font-weight: 600; font-size: 13px; cursor: pointer; font-family: inherit; }
    .btn-secondary { background: var(--border-light); color: var(--text-mid); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-danger { background: var(--bg-card); color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fef2f2; }

    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 11px 8px; font-size: 13px; }
    th { color: var(--text-light); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; border-bottom: 1px solid var(--border-light); }
    td { border-bottom: 1px solid var(--border-light); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono','Menlo',monospace; font-size: 12px; }
    .small { color: var(--text-light); }
    .empty { text-align: center; color: var(--text-light); padding: 40px 0; }
    .error { color: #b91c1c; font-size: 12px; }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .pill-ok { background: var(--pill-ok-bg); color: var(--pill-ok-text); }
    .pill-fail { background: var(--pill-fail-bg); color: var(--pill-fail-text); }
    .pill-in { background: var(--pill-in-bg); color: var(--pill-in-text); }
    .pill-out { background: var(--pill-out-bg); color: var(--pill-out-text); }

    .footer { display: flex; align-items: center; justify-content: space-between; margin-top: 18px; }
    .count { color: var(--text-muted); font-size: 13px; }
    .pager { display: flex; gap: 6px; }
    .pager-btn { padding: 7px 12px; border-radius: 8px; background: var(--border-light); color: var(--text-mid); text-decoration: none; font-size: 13px; font-weight: 500; }
    .pager-btn:hover { background: #e2e8f0; color: var(--text); }
    .pager-btn.disabled { opacity: 0.4; pointer-events: none; }

    @media (max-width: 720px) { .main { padding: 20px; padding-top: 70px; } }
  </style>
</head>
<body>
  ${renderSidebar('messages', settings.getAdminUser())}

  <main class="main">
    <h1>Messages</h1>
    <p class="sub">Complete message history with filtering and search.</p>

    <div class="card">
      <div class="toolbar">
        <div class="tabs">${statusTabs}</div>
        <div class="tabs">${dirTabs}</div>
        <form class="search" method="GET" action="/admin/messages">
          ${status !== 'all' ? `<input type="hidden" name="status" value="${status}" />` : ''}
          ${direction !== 'all' ? `<input type="hidden" name="direction" value="${direction}" />` : ''}
          <input type="text" name="q" placeholder="Search by phone number…" value="${escapeHtml(q)}" />
          <button type="submit" class="btn btn-secondary">Search</button>
        </form>
        <a class="btn btn-secondary" href="/admin/messages.csv?${new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(direction !== 'all' ? { direction } : {}), ...(q ? { q } : {}) }).toString()}" style="text-decoration:none;display:inline-block;">Export CSV</a>
        <form method="POST" action="/admin/messages/clear" onsubmit="return confirm('Delete all messages? This cannot be undone.');">
          <button type="submit" class="btn btn-danger">Clear log</button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Dir</th>
            <th>Number</th>
            <th>Status</th>
            <th>Message ID</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div class="footer">
        <div class="count">${total} ${total === 1 ? 'message' : 'messages'}${q || status !== 'all' ? ' (filtered)' : ''}</div>
        <div class="pager">
          ${pagerLink(page - 1, '← Previous', page <= 1)}
          <span class="pager-btn disabled">Page ${page} / ${totalPages}</span>
          ${pagerLink(page + 1, 'Next →', page >= totalPages)}
        </div>
      </div>
    </div>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>
  <script>
  (function() {
    var es = new EventSource('/admin/events');
    var pending = false;
    es.addEventListener('update', function() {
      if (pending) return;
      pending = true;
      setTimeout(function() { location.reload(); }, 600);
    });
  })();
  </script>
${THEME_SCRIPT}
</body>
</html>`;
}

function sessionsPage(cardsHtml: string): string {
  return `<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Sessions</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}

    .main { flex: 1; padding: 32px 40px; max-width: 1280px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
    .session-card { background: var(--bg-card); border-radius: 16px; padding: 20px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); }
    .session-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }
    .session-head .rename { flex: 1; }
    .session-head .rename input { width: 100%; padding: 6px 8px; font-size: 14px; font-weight: 600; border: 1px solid transparent; background: transparent; border-radius: 8px; font-family: inherit; }
    .session-head .rename input:hover { border-color: #e2e8f0; }
    .session-head .rename input:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    .default-badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; margin-bottom: 10px; }
    .qr-area { display: grid; place-items: center; padding: 12px 0; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
    .actions form { margin: 0; }
    .btn { padding: 6px 12px; border-radius: 8px; border: none; font-weight: 600; font-size: 12px; cursor: pointer; font-family: inherit; }
    .btn-secondary { background: var(--border-light); color: var(--text-mid); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-danger { background: var(--bg-card); color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fef2f2; }
    .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; box-shadow: 0 8px 20px -8px rgba(34,197,94,0.5); padding: 10px 18px; font-size: 13px; }
    .muted { color: var(--text-light); font-size: 11px; margin-top: 8px; word-break: break-all; }
    .mono { font-family: 'SF Mono','Menlo',monospace; }
    .status-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; font-weight: 600; font-size: 11px; background: var(--bg-card); box-shadow: 0 1px 4px rgba(15,23,42,0.06); }
    .status-chip .dot { width: 7px; height: 7px; border-radius: 50%; }
    .status-chip.open { color: #15803d; }
    .status-chip.open .dot { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.18); }
    .status-chip.connecting { color: #b45309; }
    .status-chip.connecting .dot { background: #f59e0b; }
    .status-chip.closed { color: #b91c1c; }
    .status-chip.closed .dot { background: #ef4444; }

    .add-card { background: var(--bg-card); border-radius: 16px; padding: 24px 28px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); margin-bottom: 24px; }
    .add-card h3 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
    .add-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .add-row input[type=text] { flex: 1; min-width: 200px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-input); font-size: 13px; font-family: inherit; }
    .add-row input[type=text]:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    .add-row label.cb { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-mid); }

    @media (max-width: 720px) { .main { padding: 20px; padding-top: 70px; } }
  </style>
</head>
<body>
  ${renderSidebar('sessions', settings.getAdminUser())}

  <main class="main">
    <h1>Sessions</h1>
    <p class="sub">Manage multiple WhatsApp numbers. The default session is used when <span class="mono">session_id</span> is not provided.</p>

    <div class="add-card">
      <h3>Add new session</h3>
      <form method="POST" action="/admin/sessions/add">
        <div class="add-row">
          <input type="text" name="name" placeholder="E.g. Sales NL or Support" required />
          <label class="cb"><input type="checkbox" name="default" /> Make default immediately</label>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    </div>

    <div class="grid">${cardsHtml || '<p class="sub">No sessions yet.</p>'}</div>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>
  <script>
  (function() {
    var es = new EventSource('/admin/events');
    var pending = false;
    es.addEventListener('update', function() {
      if (pending) return;
      pending = true;
      setTimeout(function() { location.reload(); }, 800);
    });
  })();
  </script>
${THEME_SCRIPT}
</body>
</html>`;
}

function settingsPage(opts: { ok?: string; err?: string }): string {
  const generatedKey = randomBytes(32).toString('hex');
  const currentApiKey = settings.getApiKey();
  const currentUser = settings.getAdminUser();
  const okBanner = opts.ok ? `<div class="banner banner-ok">Settings saved.</div>` : '';
  const errBanner = opts.err ? `<div class="banner banner-err">${escapeHtml(opts.err)}</div>` : '';

  return `<!doctype html>
<html lang="en"${themeAttr()}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Settings</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${BASE_CSS}
    body { display: flex; }
    ${SIDEBAR_CSS}

    .main { flex: 1; padding: 32px 40px; max-width: 760px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }
    .card { background: var(--bg-card); border-radius: 16px; padding: 24px 28px; box-shadow: var(--shadow-card); border: 1px solid var(--border-card); margin-bottom: 18px; }
    .card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .card .help { color: var(--text-light); font-size: 12px; margin: 0 0 18px; }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--text-mid); margin-bottom: 6px; }
    input[type=text], input[type=password] {
      width: 100%; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--bg-input);
      font-size: 13px; font-family: inherit; color: var(--text);
    }
    input[type=text]:focus, input[type=password]:focus { outline: none; border-color: #22c55e; background: var(--bg-card); box-shadow: 0 0 0 3px rgba(34,197,94,0.15); }
    .field { margin-bottom: 16px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row input { flex: 1; }
    .btn { padding: 10px 18px; border-radius: 10px; border: none; font-weight: 600; font-size: 13px; cursor: pointer; font-family: inherit; }
    .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; box-shadow: 0 8px 20px -8px rgba(34,197,94,0.5); }
    .btn-secondary { background: var(--border-light); color: var(--text-mid); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #e2e8f0; }
    .mono { font-family: 'SF Mono','Menlo',monospace; font-size: 12px; }
    .banner { padding: 12px 16px; border-radius: 10px; margin-bottom: 18px; font-size: 13px; font-weight: 500; }
    .banner-ok { background: var(--pill-ok-bg); color: var(--pill-ok-text); }
    .banner-err { background: var(--pill-fail-bg); color: var(--pill-fail-text); }
    @media (max-width: 720px) { .main { padding: 20px; padding-top: 70px; } }
  </style>
</head>
<body>
  ${renderSidebar('settings', settings.getAdminUser())}

  <main class="main">
    <h1>Settings</h1>
    <p class="sub">Manage your login and API key.</p>
    ${okBanner}${errBanner}

    <form method="POST" action="/admin/settings">
      <div class="card">
        <h3>Account</h3>
        <p class="help">Login for the dashboard.</p>
        <div class="field">
          <label>Username</label>
          <input type="text" name="admin_user" value="${escapeHtml(currentUser)}" required />
        </div>
        <div class="field">
          <label>New password <span style="color:#94a3b8;font-weight:400">(leave empty to keep current)</span></label>
          <input type="password" name="new_password" autocomplete="new-password" />
        </div>
      </div>

      <div class="card">
        <h3>API key</h3>
        <p class="help">Used for the <span class="mono">x-api-key</span> header on <span class="mono">/api/send</span> and <span class="mono">/api/status</span>. Min. 32 characters.</p>
        <div class="field">
          <label>Current key</label>
          <div class="row">
            <input type="text" value="${escapeHtml(currentApiKey)}" readonly onclick="this.select()" />
          </div>
        </div>
        <div class="field">
          <label>New key <span style="color:#94a3b8;font-weight:400">(leave empty to keep current)</span></label>
          <div class="row">
            <input type="text" name="api_key" id="api_key_input" placeholder="hex string of min. 32 characters" />
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('api_key_input').value='${generatedKey}'">Generate</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Webhook</h3>
        <p class="help">Whappi POSTs events with a persistent retry queue (5s → 6h backoff, max 6 attempts). Header <span class="mono">x-whappi-signature</span> contains HMAC-SHA256 of <span class="mono">timestamp.body</span> with the API key as secret.</p>
        <div class="field">
          <label>Webhook URL <span style="color:#94a3b8;font-weight:400">(empty = disabled)</span></label>
          <input type="text" name="webhook_url" placeholder="https://quoty.nl/api/whappi-webhook" value="${escapeHtml(settings.getWebhookUrl())}" />
        </div>
      </div>

      <div class="card">
        <h3>Rate limiting</h3>
        <p class="help">Protect the Quoty number against WhatsApp bans.</p>
        <div class="field">
          <label>Throttle per recipient (seconds) <span style="color:#94a3b8;font-weight:400">(0 = off)</span></label>
          <input type="text" name="recipient_throttle_sec" value="${settings.getRecipientThrottleSec()}" />
        </div>
        <div class="field">
          <label>Burst limit (messages per minute, global) <span style="color:#94a3b8;font-weight:400">(0 = off)</span></label>
          <input type="text" name="burst_per_minute" value="${settings.getBurstPerMinute()}" />
        </div>
        <div class="field">
          <label>Delay per message (seconds) <span style="color:#94a3b8;font-weight:400">(min. 1)</span></label>
          <input type="text" name="queue_delay_sec" value="${settings.getQueueDelaySec()}" />
        </div>
      </div>

      <div class="card">
        <h3>API IP allowlist</h3>
        <p class="help">Comma-separated list of IPs allowed to call <span class="mono">/api/send</span> and <span class="mono">/api/status</span>. Empty = anyone with a valid API key.</p>
        <div class="field">
          <label>Allowed IPs</label>
          <input type="text" name="api_ip_allowlist" placeholder="1.2.3.4, 5.6.7.8" value="${escapeHtml(settings.getApiIpAllowlist())}" />
        </div>
      </div>

      <div class="card">
        <h3>Confirmation</h3>
        <p class="help">Enter your current password to confirm changes.</p>
        <div class="field">
          <label>Current password</label>
          <input type="password" name="current_password" autocomplete="current-password" required />
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
    <div class="version-footer"><span>Whappi v${PKG_VERSION}</span></div>
  </main>
${THEME_SCRIPT}
</body>
</html>`;
}

