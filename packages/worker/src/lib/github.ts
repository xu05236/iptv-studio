import type { Env } from '../env.js';

export interface DispatchResult {
  ok: boolean;
  message: string;
  runUrl?: string;
}

/**
 * Trigger the GitHub Actions collector. The Worker never probes thousands of
 * streams itself — heavy work lives in Actions, Cloudflare only distributes.
 */
export async function dispatchWorkflow(
  env: Env,
  inputs: Record<string, string> = {},
  workflowOverride?: string,
): Promise<DispatchResult> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { ok: false, message: '未配置 GITHUB_TOKEN / GITHUB_REPO，无法远程触发采集' };
  }
  const workflow = workflowOverride || env.GITHUB_WORKFLOW || 'collect.yml';
  const ref = env.GITHUB_REF || 'main';
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`;

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'iptv-studio-worker',
    'content-type': 'application/json',
  };
  let lastMessage = 'GitHub API 暂不可用';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref, inputs }),
      });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : 'GitHub 请求失败';
      if (attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }
      return { ok: false, message: `触发失败：${lastMessage}（已重试 3 次）` };
    }

    if (response.status === 204) {
      return {
        ok: true,
        message: '已触发 GitHub Actions 采集任务',
        runUrl: `https://github.com/${env.GITHUB_REPO}/actions/workflows/${workflow}`,
      };
    }

    const text = (await response.text()).trim();
    lastMessage = text ? text.slice(0, 300) : 'GitHub 返回空响应';
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < 3) {
      await sleep(500 * attempt);
      continue;
    }
    return {
      ok: false,
      message: `触发失败 (${response.status}): ${lastMessage}${transient ? `（已重试 ${attempt} 次）` : ''}`,
    };
  }

  return { ok: false, message: `触发失败：${lastMessage}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkflowRun {
  id: number;
  name?: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url?: string;
}

export async function listWorkflowRuns(env: Env, perPage = 30): Promise<WorkflowRun[]> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return [];
  const workflow = env.GITHUB_WORKFLOW || 'collect.yml';
  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/runs?per_page=${perPage}&event=workflow_dispatch`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'iptv-studio-worker',
        },
      },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { workflow_runs?: WorkflowRun[] };
    return data.workflow_runs ?? [];
  } catch {
    return [];
  }
}

export async function workflowRunStatus(env: Env): Promise<unknown> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  const workflow = env.GITHUB_WORKFLOW || 'collect.yml';
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/runs?per_page=3`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'iptv-studio-worker',
      },
    },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  return (data.workflow_runs ?? []).map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    url: run.html_url,
  }));
}
