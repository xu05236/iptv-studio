import type { Env } from '../env.js';
import { getJson } from './store.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';
import { loadTasks, type Task } from './tasks.js';

const TASK_TYPE: Record<string, string> = {
  collect: '完整采集',
  fetch: '抓源',
  publish: '发布',
  probe: '测速',
  'probe-batch': '分批探测',
  'probe-lines': '指定探测',
  liveness: '测活',
  epg: '节目单',
  export: '导出',
};

interface UsageState {
  kv?: { reads?: number; writes?: number; lists?: number; storageBytes?: number };
  d1?: { rowsRead?: number; rowsWritten?: number };
  github?: { minutes?: number; runs?: number; private?: boolean };
}

function shanghai(value?: string | null): string {
  if (!value) return '未排期';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未排期';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function progressText(task: Awaited<ReturnType<typeof loadTasks>>[number]): string {
  const { done, total, unit } = task.progress;
  if (!total) return '';
  return ` ${done}/${total}${unit ? ` ${unit}` : ''}`;
}

async function buildReply(env: Env, command: string): Promise<string> {
  const [tasks, stats, usage, fetchState, publishState, probeState] = await Promise.all([
    loadTasks(env),
    getJson<Record<string, number>>(env, 'state/pool-stats.json'),
    getRuntimeJson<UsageState>(env, 'state/usage.json'),
    getRuntimeJson<{ nextRunAt?: string }>(env, 'state/fetch-schedule.json'),
    getRuntimeJson<{ nextRunAt?: string }>(env, 'state/publish-schedule.json'),
    getRuntimeJson<{ nextRunAt?: string }>(env, 'state/probe-schedule.json'),
  ]);

  if (command === '/help' || command === '/start') {
    return [
      'IPTV Studio 命令：',
      '/status 概览',
      '/tasks 当前任务',
      '/usage 额度使用',
    ].join('\n');
  }

  if (command === '/usage') {
    const kv = usage?.kv;
    const d1 = usage?.d1;
    const gh = usage?.github;
    return [
      '📊 额度使用',
      `KV 读 ${kv?.reads ?? 0} / 写 ${kv?.writes ?? 0} / 列表 ${kv?.lists ?? 0}`,
      `D1 读 ${d1?.rowsRead ?? 0} / 写 ${d1?.rowsWritten ?? 0}`,
      gh?.private === false
        ? `GitHub Actions 公开仓库不计费 · 本月 ${gh?.runs ?? 0} 次运行`
        : `GitHub 本月 ${gh?.minutes ?? 0} 分钟 / ${gh?.runs ?? 0} 次`,
      `存储 ${Math.round((kv?.storageBytes ?? 0) / 1024 / 1024)} MB`,
    ].join('\n');
  }

  if (command === '/tasks') {
    const active = tasks.filter((task: Task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused');
    if (!active.length) return '当前没有运行或排队的任务。';
    return [
      '🧵 当前任务',
      ...active.map((task: Task) => `${TASK_TYPE[task.type] ?? task.type} · ${task.status}${progressText(task)}\n${task.message ?? ''}`),
    ].join('\n');
  }

  // /status and unknown commands: overview.
  const running = tasks.find((task: Task) => task.status === 'running');
  const queued = tasks.filter((task: Task) => task.status === 'queued').length;
  return [
    '📡 IPTV Studio 概览',
    `运行：${running ? `${TASK_TYPE[running.type] ?? running.type}${progressText(running)}` : '无'}`,
    `排队：${queued}`,
    `线路：${stats?.total ?? 0} 总 / ${stats?.alive ?? 0} 可用 / ${stats?.pending ?? 0} 待测 / ${stats?.quarantine ?? 0} 待复测`,
    `下次抓源：${shanghai(fetchState?.nextRunAt)}`,
    `下次发布：${shanghai(publishState?.nextRunAt)}`,
    `下次探测：${shanghai(probeState?.nextRunAt)}`,
    '发送 /tasks 查看任务，/usage 查看额度。',
  ].join('\n');
}

export async function sendTelegram(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
  });
}

export async function handleTelegramUpdate(
  env: Env,
  update: { message?: { chat?: { id: number }; text?: string } },
): Promise<void> {
  const chatId = env.TELEGRAM_CHAT_ID;
  const message = update.message;
  if (!chatId || !message?.text || String(message.chat?.id) !== String(chatId)) return;
  const command = message.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  if (!command.startsWith('/')) return;
  await sendTelegram(env, await buildReply(env, command));
}

const COMMANDS = [
  { command: 'status', description: '概览：任务、线路、下次运行' },
  { command: 'tasks', description: '当前运行和排队任务' },
  { command: 'usage', description: 'KV / D1 / GitHub 额度' },
  { command: 'help', description: '命令帮助' },
];

async function configureMenu(token: string, chatId: string): Promise<void> {
  const scope = { type: 'chat', chat_id: Number(chatId) };
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope, commands: COMMANDS }),
  });
  await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(chatId), menu_button: { type: 'commands' } }),
  });
}

/** Register a webhook for instant replies; polling becomes a fallback only. */
export async function registerTelegramWebhook(env: Env): Promise<{ url: string; menu: boolean }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const baseUrl = env.PUBLIC_BASE_URL;
  if (!token) throw new Error('未配置 TELEGRAM_BOT_TOKEN');
  if (!baseUrl) throw new Error('未配置 PUBLIC_BASE_URL');
  const secret = crypto.randomUUID().replace(/-/g, '');
  const url = `${baseUrl.replace(/\/+$/, '')}/api/telegram/webhook`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
  });
  const result = (await response.json()) as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(result.description ?? `Telegram HTTP ${response.status}`);
  await putRuntimeJson(env, 'state/telegram-webhook.json', { secret, url });
  let menu = false;
  try {
    if (env.TELEGRAM_CHAT_ID) await configureMenu(token, env.TELEGRAM_CHAT_ID);
    menu = true;
  } catch {
    // The webhook still works even if the client menu cannot be updated.
  }
  return { url, menu };
}

export async function verifyTelegramSecret(env: Env, header: string | null): Promise<boolean> {
  const stored = await getRuntimeJson<{ secret?: string }>(env, 'state/telegram-webhook.json');
  return Boolean(stored?.secret && header === stored.secret);
}

/** Poll Telegram once per scheduler tick and answer admin commands from the configured chat. */
export async function runTelegramCommands(env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  if (await getRuntimeJson<{ secret?: string }>(env, 'state/telegram-webhook.json')) return;
  try {
    const stored = await getRuntimeJson<{ offset?: number }>(env, 'state/telegram-offset.json');
    const offset = Number(stored?.offset ?? 0);
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}`, {
      method: 'GET',
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: Array<{ update_id: number; message?: { chat?: { id: number }; text?: string } }>;
    };
    if (!payload.ok || !payload.result?.length) return;

    let nextOffset = offset;
    for (const update of payload.result) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      await handleTelegramUpdate(env, update);
    }
    if (nextOffset !== offset) {
      await putRuntimeJson(env, 'state/telegram-offset.json', { offset: nextOffset });
    }
  } catch {
    // Telegram polling failures must not affect the scheduler.
  }
}
