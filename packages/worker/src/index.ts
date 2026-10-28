import { Hono } from 'hono';
import { VERSION } from '@iptv/core';
import type { AppEnv, Env } from './env.js';
import { checkAdminToken, issueSession, requireAuth } from './lib/auth.js';
import { fail, hashIp, ok, readJson } from './lib/http.js';
import { publicRoutes } from './routes/public.js';
import { sourceRoutes } from './routes/sources.js';
import { channelRoutes } from './routes/channels.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { adminRoutes } from './routes/admin.js';
import { artifactRoutes } from './routes/artifacts.js';
import { relayRoutes } from './routes/relay.js';
import { runCron } from './cron.js';

const app = new Hono<AppEnv>();

app.get('/api/health', (c) =>
  ok({
    ok: true,
    version: VERSION,
    environment: c.env.ENVIRONMENT ?? 'development',
    time: new Date().toISOString(),
    bindings: {
      d1: Boolean(c.env.DB),
      kv: Boolean(c.env.KV),
    },
  }),
);

app.post('/api/admin/login', async (c) => {
  const body = await readJson<{ token?: string }>(c);
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  const key = `login:${hashIp(ip)}`;
  const attempts = Number((await c.env.KV.get(key)) ?? '0');
  if (attempts >= 8) return fail('尝试次数过多，请 10 分钟后再试', 429);

  if (!body?.token || !checkAdminToken(c.env, body.token)) {
    await c.env.KV.put(key, String(attempts + 1), { expirationTtl: 600 });
    return fail('管理令牌不正确', 401);
  }
  await c.env.KV.delete(key);
  const token = await issueSession(c.env);
  return ok({ token, expiresIn: 7 * 86_400 });
});

app.use('/api/admin/*', requireAuth);

app.get('/api/admin/me', (c) => ok({ actor: c.get('actor'), ok: true }));

app.get('/api/admin/usage', async (c) => {
  const usage = await c.env.KV.get('state/usage.json', 'json');
  return ok({ usage });
});

app.post('/api/admin/usage', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  if (!body || typeof body['collectedAt'] !== 'string') return fail('缺少 collectedAt');
  await c.env.KV.put('state/usage.json', JSON.stringify(body));
  return ok({ saved: true });
});

app.route('/api/public', publicRoutes);
app.route('/api/admin/sources', sourceRoutes);
app.route('/api/admin/channels', channelRoutes);
app.route('/api/admin/subscriptions', subscriptionRoutes);
app.route('/api/admin', adminRoutes);
app.route('/relay', relayRoutes);
app.route('/', artifactRoutes);

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return fail('接口不存在', 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error('worker error', error);
  if (c.req.path.startsWith('/api/')) return fail('服务器内部错误', 500);
  return new Response('Internal Error', { status: 500 });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
