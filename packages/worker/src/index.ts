import { Hono } from 'hono';
import { VERSION } from '@iptv/core';
import type { AppEnv, Env } from './env.js';
import { checkAdminToken, issueSession, requireAuth } from './lib/auth.js';
import { fail, hashIp, ok, readJson } from './lib/http.js';
import { getRuntimeJson, putRuntimeJson } from './lib/runtime-state.js';
import { publicRoutes } from './routes/public.js';
import { sourceRoutes } from './routes/sources.js';
import { channelRoutes } from './routes/channels.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { adminRoutes } from './routes/admin.js';
import { artifactRoutes } from './routes/artifacts.js';
import { poolRoutes } from './routes/pool.js';
import { relayRoutes } from './routes/relay.js';
import { runCron } from './cron.js';
import { runScheduler } from './lib/schedule.js';
import { runMonitor } from './lib/monitor.js';
import { handleTelegramUpdate, runTelegramCommands, verifyTelegramSecret } from './lib/telegram.js';
import { dispatchWorkflow } from './lib/github.js';

const app = new Hono<AppEnv>();
export { app };

app.get('/api/version', (c) => {
  const commit = c.env.COMMIT_SHA ?? 'dev';
  return ok({
    commit,
    shortCommit: commit.slice(0, 7),
    deployedAt: c.env.DEPLOYED_AT || null,
    version: VERSION,
    environment: c.env.ENVIRONMENT ?? 'development',
  });
});

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
  const usage = await getRuntimeJson<Record<string, unknown>>(c.env, 'state/usage.json');
  return ok({ usage });
});

app.post('/api/admin/usage', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  if (!body || typeof body['collectedAt'] !== 'string') return fail('缺少 collectedAt');
  await putRuntimeJson(c.env, 'state/usage.json', body);
  return ok({ saved: true });
});

app.post('/api/admin/usage/refresh', async (c) => {
  const result = await dispatchWorkflow(c.env, {}, 'usage.yml');
  return ok({ ...result, message: result.ok ? '已触发用量刷新' : result.message }, result.ok ? 202 : 400);
});

app.route('/api/public', publicRoutes);
app.route('/api/admin/sources', sourceRoutes);
app.route('/api/admin/channels', channelRoutes);
app.route('/api/admin/subscriptions', subscriptionRoutes);
app.route('/api/admin/pool', poolRoutes);
app.route('/api/admin', adminRoutes);
app.route('/relay', relayRoutes);

app.post('/api/telegram/webhook', async (c) => {
  const secret = c.req.header('x-telegram-bot-api-secret-token') ?? null;
  if (!(await verifyTelegramSecret(c.env, secret))) return c.json({ ok: false }, 401);
  const update = await c.req.json().catch(() => null);
  if (update) await handleTelegramUpdate(c.env, update);
  return c.json({ ok: true });
});

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
  fetch: app.fetch,  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '17 */6 * * *') ctx.waitUntil(runCron(env));
    else ctx.waitUntil(Promise.all([runScheduler(env), runTelegramCommands(env), runMonitor(env)]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
