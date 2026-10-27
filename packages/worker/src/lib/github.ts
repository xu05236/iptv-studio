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
export async function dispatchWorkflow(env: Env, inputs: Record<string, string> = {}): Promise<DispatchResult> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { ok: false, message: '未配置 GITHUB_TOKEN / GITHUB_REPO，无法远程触发采集' };
  }
  const workflow = env.GITHUB_WORKFLOW || 'collect.yml';
  const ref = env.GITHUB_REF || 'main';
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'iptv-studio-worker',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (response.status === 204) {
    return {
      ok: true,
      message: '已触发 GitHub Actions 采集任务',
      runUrl: `https://github.com/${env.GITHUB_REPO}/actions/workflows/${workflow}`,
    };
  }
  const text = await response.text();
  return { ok: false, message: `触发失败 (${response.status}): ${text.slice(0, 300)}` };
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
