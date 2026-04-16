import { FastifyRequest, FastifyReply } from 'fastify';

function ipAllowed(ip: string, allowlist: string): boolean {
  if (!allowlist.trim()) return true;
  const entries = allowlist.split(',').map((s) => s.trim()).filter(Boolean);
  return entries.includes(ip);
}

export function apiKeyGuard(getKey: () => string, getAllowlist?: () => string) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (getAllowlist) {
      const allowlist = getAllowlist();
      const ip = req.ip;
      if (!ipAllowed(ip, allowlist)) {
        reply.code(403).send({ error: 'Forbidden (IP not allowed)' });
        return;
      }
    }
    const key = req.headers['x-api-key'];
    const expected = getKey();
    if (!key || typeof key !== 'string' || key !== expected) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}
