function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] as string));
}

interface HelpSection {
  id: string;
  title: string;
  body: string;
}

export function buildHelpPage(opts: {
  baseUrl: string;
  apiKey: string;
  sidebarHtml: string;
  baseCss: string;
  sidebarCss: string;
}): string {
  const { baseUrl: u, apiKey, sidebarHtml, baseCss, sidebarCss } = opts;
  const k = apiKey || '<YOUR_API_KEY>';
  const code = (lang: string, body: string) =>
    `<div class="code"><div class="code-head"><span>${lang}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${escapeHtml(body)}</code></pre></div>`;

  const sections: HelpSection[] = [
    {
      id: 'getting-started',
      title: 'Getting started',
      body: `
        <p>Whappi is a microservice that sends WhatsApp messages via Baileys from one or more WhatsApp numbers. Quoty (or another application) calls the REST API; Whappi handles sending, queueing, retries and webhooks back.</p>
        <h4>1. Link a session</h4>
        <p>Go to <a href="/admin/sessions">Sessions</a> and scan the QR code with WhatsApp → Linked devices → Link a device. Once the status is "Connected", you can start sending.</p>
        <h4>2. Find your API key</h4>
        <p>Your API key can be found on <a href="/admin/settings">Settings</a>. It goes as the <span class="mono">x-api-key</span> header with every API call.</p>
        <h4>3. First test message</h4>
        <p>The <a href="/admin">Dashboard</a> has a test message form. Or use curl, see the API tab below.</p>
      `,
    },
    {
      id: 'sessions',
      title: 'Sessions (multiple WhatsApp numbers)',
      body: `
        <p>You can link multiple WhatsApp numbers at the same time. Each session has a unique <span class="mono">session_id</span>. One session is always the default — it is used when you don't include a <span class="mono">session_id</span> in an API call.</p>
        <h4>Add a new session</h4>
        <ol>
          <li>Go to <a href="/admin/sessions">Sessions</a></li>
          <li>Enter a name (e.g. "Sales NL", "Support") and click Add</li>
          <li>Scan the QR code that appears</li>
        </ol>
        <h4>Change default session</h4>
        <p>Click "Make default" on the desired session. From that point on, all calls without a <span class="mono">session_id</span> will go through that number.</p>
        <h4>Delete / reset a session</h4>
        <p>Reset = scan the QR again, the session remains. Delete = the session is permanently removed, including auth state.</p>
      `,
    },
    {
      id: 'api-send',
      title: 'API: send a message',
      body: `
        <p>Endpoint: <span class="mono">POST ${u}/send</span></p>
        <p><strong>Headers:</strong></p>
        <ul>
          <li><span class="mono">Content-Type: application/json</span></li>
          <li><span class="mono">x-api-key: ${escapeHtml(k)}</span></li>
        </ul>
        <p><strong>Body fields:</strong></p>
        <ul>
          <li><span class="mono">to</span> — string or array of strings (phone number(s) with country code, digits only)</li>
          <li><span class="mono">message</span> — string, free text</li>
          <li><span class="mono">session_id</span> — optional, choose a specific WhatsApp session. Empty = default session</li>
          <li><span class="mono">quoty_customer_id</span> — optional, returned in webhook</li>
          <li><span class="mono">metadata</span> — optional object, returned in webhook</li>
        </ul>

        <h4>Example: single message (curl)</h4>
        ${code('bash', `curl -X POST ${u}/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${k}" \\
  -d '{"to":"31612345678","message":"Hello from Whappi"}'`)}

        <h4>Example: one-liner (curl)</h4>
        ${code('bash', `curl -X POST ${u}/send -H "Content-Type: application/json" -H "x-api-key: ${k}" -d '{"to":"31612345678","message":"Hello"}'`)}

        <h4>Example: multiple recipients</h4>
        ${code('bash', `curl -X POST ${u}/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${k}" \\
  -d '{"to":["31612345678","31698765432"],"message":"Bulk message"}'`)}

        <h4>Example: specific session + metadata</h4>
        ${code('bash', `curl -X POST ${u}/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${k}" \\
  -d '{
    "to": "31612345678",
    "message": "Your quote is ready",
    "session_id": "<session_uuid>",
    "quoty_customer_id": "cust_abc",
    "metadata": { "quote_id": "quote_xyz" }
  }'`)}

        <h4>Example: Node.js / Next.js (fetch)</h4>
        ${code('javascript', `const res = await fetch('${u}/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.WHAPPI_API_KEY,
  },
  body: JSON.stringify({
    to: '31612345678',
    message: 'Dear customer, your quote is ready.',
    quoty_customer_id: 'cust_abc',
    metadata: { quote_id: 'quote_xyz' },
  }),
});
const { message_id } = await res.json();`)}

        <h4>Example: PHP (without curl)</h4>
        ${code('php', `<?php
$opts = [
  'http' => [
    'method' => 'POST',
    'header' => "Content-Type: application/json\\r\\nx-api-key: ${k}\\r\\n",
    'content' => json_encode([
      'to' => '31612345678',
      'message' => 'Hello from PHP',
    ]),
  ],
];
$ctx = stream_context_create($opts);
$response = json_decode(file_get_contents('${u}/send', false, $ctx), true);`)}

        <h4>Response</h4>
        ${code('json', `{ "queued": true, "message_id": "msg_a1b2c3d4-..." }`)}
        <p>For an array of recipients:</p>
        ${code('json', `{ "queued": true, "message_ids": ["msg_...", "msg_..."] }`)}
      `,
    },
    {
      id: 'api-status',
      title: 'API: status & healthcheck',
      body: `
        <h4>GET /status (requires x-api-key)</h4>
        ${code('bash', `curl ${u}/status -H "x-api-key: ${k}"`)}
        ${code('json', `{ "whatsapp": "open", "queue_length": 0, "uptime_seconds": 3600 }`)}

        <h4>GET /healthz (public, no auth)</h4>
        <p>Suitable for monitoring / load balancers. Returns <span class="mono">200</span> when WhatsApp is connected, otherwise <span class="mono">503</span>.</p>
        ${code('bash', `curl ${u}/healthz`)}
        ${code('json', `{ "ok": true, "whatsapp": "open", "uptime_seconds": 3600 }`)}
      `,
    },
    {
      id: 'webhooks',
      title: 'Receiving webhooks',
      body: `
        <p>Whappi POSTs events to the webhook URL you configure on <a href="/admin/settings">Settings</a>. Messages are placed in a persistent queue and retried with exponential backoff (5s → 30s → 2m → 10m → 1h → 6h, max 6 attempts).</p>

        <h4>Headers</h4>
        <ul>
          <li><span class="mono">Content-Type: application/json</span></li>
          <li><span class="mono">x-whappi-timestamp</span> — Unix timestamp in seconds</li>
          <li><span class="mono">x-whappi-signature</span> — HMAC-SHA256 hex of <span class="mono">{timestamp}.{body}</span> with your API key as secret</li>
        </ul>

        <h4>Event payloads</h4>
        ${code('json', `{
  "event": "message.sent",
  "message_id": "msg_...",
  "to": "31612345678",
  "quoty_customer_id": "cust_abc",
  "metadata": { "quote_id": "quote_xyz" },
  "at": "2026-04-15T18:42:00.000Z"
}`)}
        ${code('json', `{
  "event": "message.failed",
  "message_id": "msg_...",
  "to": "31612345678",
  "error": "WhatsApp not connected",
  "at": "..."
}`)}
        ${code('json', `{ "event": "whatsapp.disconnected", "session_id": "...", "at": "..." }`)}
        ${code('json', `{ "event": "whatsapp.connected", "session_id": "...", "at": "..." }`)}

        <h4>Validating webhooks (Next.js)</h4>
        ${code('typescript', `import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const ts = req.headers.get('x-whappi-timestamp');
  const sig = req.headers.get('x-whappi-signature');
  if (!ts || !sig) return NextResponse.json({ error: 'missing signature' }, { status: 401 });

  const expected = crypto
    .createHmac('sha256', process.env.WHAPPI_API_KEY!)
    .update(\`\${ts}.\${body}\`)
    .digest('hex');

  if (sig !== expected) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // Optional: replay protection (max 5 min old)
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) {
    return NextResponse.json({ error: 'expired' }, { status: 401 });
  }

  const event = JSON.parse(body);
  // ... handle event
  return NextResponse.json({ ok: true });
}`)}
      `,
    },
    {
      id: 'rate-limits',
      title: 'Rate limiting & throttling',
      body: `
        <p>Whappi has three built-in protections to prevent bans on the WhatsApp number. Manage them on <a href="/admin/settings">Settings → Rate limiting</a>.</p>
        <ul>
          <li><strong>Throttle per recipient</strong> — minimum time between two messages to the same number (default 60s).</li>
          <li><strong>Burst limit</strong> — maximum messages per minute globally (default 30).</li>
          <li><strong>Fixed delay</strong> — 2 seconds between each sent message (hardcoded).</li>
        </ul>
        <p>The queue automatically waits until a slot is free — you don't need to do anything as an API caller.</p>
      `,
    },
    {
      id: 'security',
      title: 'Security',
      body: `
        <h4>API key</h4>
        <p>Used for <span class="mono">x-api-key</span> authentication and as the secret for HMAC webhook signing. Min. 32 characters. Change on <a href="/admin/settings">Settings</a>.</p>
        <h4>IP allowlist</h4>
        <p>Restrict which IPs can call <span class="mono">/send</span> and <span class="mono">/status</span>. Comma-separated list, empty = open to all IPs with a valid API key.</p>
        <h4>Brute-force protection</h4>
        <p>After 5 failed login attempts, the IP is blocked for 15 minutes from the admin dashboard.</p>
        <h4>Cookie session</h4>
        <p>Admin login uses an HttpOnly signed cookie (valid for 7 days). No more Basic Auth.</p>
      `,
    },
    {
      id: 'troubleshooting',
      title: 'Troubleshooting',
      body: `
        <h4>"WhatsApp not connected"</h4>
        <p>Check <a href="/admin/sessions">Sessions</a>. Status must be "Connected". If not: scan the QR again.</p>
        <h4>Messages are not arriving</h4>
        <ol>
          <li>Check if the number is correct (digits only, with country code, no + or spaces)</li>
          <li>Check the <a href="/admin/messages">Messages</a> log for errors</li>
          <li>Verify that the receiving number uses WhatsApp</li>
        </ol>
        <h4>Webhook events are not coming in</h4>
        <ol>
          <li>Check that your webhook URL is reachable from the Whappi server</li>
          <li>Your endpoint must respond with HTTP 200, otherwise Whappi retries with backoff</li>
          <li>Verify that HMAC validation is correctly implemented (see Webhooks tab)</li>
        </ol>
        <h4>"Too many failed attempts"</h4>
        <p>Brute-force lock: wait 15 minutes or restart the server to clear the in-memory lock.</p>
      `,
    },
  ];

  const tocItems = sections.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`).join('');
  const sectionHtml = sections
    .map(
      (s) => `
      <section class="help-section" id="${s.id}" data-search="${escapeHtml(s.title.toLowerCase())} ${escapeHtml(s.body.toLowerCase().replace(/<[^>]+>/g, ' '))}">
        <h2>${escapeHtml(s.title)}</h2>
        ${s.body}
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Whappi · Help & API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    ${baseCss}
    ${sidebarCss}
    body { display: flex; }
    .main { flex: 1; padding: 32px 40px; max-width: 980px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; }
    .sub { color: #64748b; font-size: 13px; margin: 0 0 24px; }

    .search-wrap { position: sticky; top: 0; background: #f5f6fa; padding: 12px 0; z-index: 5; margin-bottom: 8px; }
    .search-wrap input { width: 100%; padding: 14px 18px; border-radius: 12px; border: 1px solid #e2e8f0; background: #fff; font-size: 14px; font-family: inherit; box-shadow: 0 2px 12px rgba(15,23,42,0.05); }
    .search-wrap input:focus { outline: none; border-color: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.12); }

    .toc { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
    .toc a { padding: 6px 12px; background: #fff; color: #475569; border-radius: 999px; font-size: 12px; font-weight: 500; text-decoration: none; border: 1px solid #e2e8f0; }
    .toc a:hover { background: #f1f5f9; color: #0f172a; }

    .help-section { background: #fff; border-radius: 16px; padding: 28px 32px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 4px 16px -8px rgba(15,23,42,0.08); border: 1px solid rgba(15,23,42,0.04); scroll-margin-top: 80px; }
    .help-section.hidden { display: none; }
    .help-section h2 { margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #0f172a; }
    .help-section h4 { margin: 22px 0 8px; font-size: 14px; font-weight: 600; color: #0f172a; }
    .help-section p { margin: 8px 0; color: #475569; line-height: 1.6; font-size: 14px; }
    .help-section ul, .help-section ol { color: #475569; line-height: 1.7; font-size: 14px; padding-left: 20px; }
    .help-section li { margin: 4px 0; }
    .help-section a { color: #16a34a; text-decoration: none; font-weight: 500; }
    .help-section a:hover { text-decoration: underline; }
    .mono { font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace; font-size: 12px; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #0f172a; }

    .code { background: #0f172a; border-radius: 12px; margin: 12px 0; overflow: hidden; border: 1px solid #1e293b; }
    .code-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; background: #1e293b; }
    .code-head span { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .copy-btn { background: rgba(255,255,255,0.05); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.08); padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; transition: background 0.15s, color 0.15s; }
    .copy-btn:hover { background: rgba(34,197,94,0.15); color: #22c55e; border-color: rgba(34,197,94,0.3); }
    .copy-btn.copied { background: #22c55e; color: #fff; border-color: #22c55e; }
    .code pre { margin: 0; padding: 16px 18px; overflow-x: auto; }
    .code code { font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace; font-size: 12px; color: #e2e8f0; line-height: 1.55; white-space: pre; }

    .empty-search { text-align: center; padding: 60px 20px; color: #94a3b8; font-size: 14px; display: none; }
    .empty-search.show { display: block; }

    @media (max-width: 720px) { .main { padding: 20px; } }
  </style>
</head>
<body>
  ${sidebarHtml}

  <main class="main">
    <h1>Help &amp; API</h1>
    <p class="sub">Documentation, examples and troubleshooting. Searchable — type in the search field to filter sections.</p>

    <div class="search-wrap">
      <input type="search" id="help-search" placeholder="Search help (e.g. 'webhook', 'curl', 'session')..." autocomplete="off" />
    </div>

    <div class="toc">${tocItems}</div>

    ${sectionHtml}

    <div class="empty-search" id="empty-search">No results found for this search query.</div>
  </main>

  <script>
  (function() {
    var input = document.getElementById('help-search');
    var sections = document.querySelectorAll('.help-section');
    var empty = document.getElementById('empty-search');
    input.addEventListener('input', function() {
      var q = this.value.toLowerCase().trim();
      var visible = 0;
      sections.forEach(function(s) {
        var hay = s.getAttribute('data-search') || '';
        var match = q === '' || hay.indexOf(q) !== -1;
        s.classList.toggle('hidden', !match);
        if (match) visible++;
      });
      empty.classList.toggle('show', visible === 0);
    });

    document.querySelectorAll('.copy-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var pre = btn.closest('.code').querySelector('code');
        var text = pre.textContent || '';
        navigator.clipboard.writeText(text).then(function() {
          var orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(function() {
            btn.textContent = orig;
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    });
  })();
  </script>
</body>
</html>`;
}
