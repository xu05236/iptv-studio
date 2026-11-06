import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight, Ban, Cloud, Database, Download, Layers3, ListChecks, Pause, Play, PlayCircle, RefreshCw, RadioTower, Share2, Tv, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminStats, UsageSnapshot } from '../../lib/types';
import { formatDuration, timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Skeleton, useToast } from '../../components/ui';

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function UsageBar({ label, used, limit, format = formatNumber }: { label: string; used: number; limit: number; format?: (value: number) => string }) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const color = percent >= 90 ? 'var(--red)' : percent >= 70 ? 'var(--orange)' : 'var(--green)';
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row row--between caption">
        <span>{label}</span>
        <span>{format(used)} / {format(limit)}</span>
      </div>
      <div className="meter" style={{ marginTop: 4 }}>
        <div className="meter__fill" style={{ width: `${Math.max(1, percent)}%`, background: color }} />
      </div>
    </div>
  );
}

function formatSnapshot(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface TaskPhase {
  id: 'pending' | 'quarantine';
  label: string;
  count: number;
  estimatedBatches: number;
  paused: boolean;
}

interface TaskItem {
  id: string;
  type: string;
  source: 'schedule' | 'manual' | 'detection' | 'source' | 'cli';
  status: 'scheduled' | 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  priority: number;
  payload: Record<string, string>;
  progress: { done: number; total: number; unit: string };
  message?: string;
  label?: string;
  failureReason?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

const TASK_SOURCE_LABEL: Record<TaskItem['source'], string> = {
  schedule: '定时',
  manual: '手动',
  detection: '检测中心',
  source: '新增源',
  cli: 'CLI',
};

const TASK_TYPE_LABEL: Record<string, string> = {
  collect: '全量采集',
  fetch: '抓源',
  'probe-batch': '分批探测',
  'probe-lines': '指定线路探测',
  publish: '发布',
  epg: 'EPG 刷新',
  liveness: '池内测活',
  export: '重建导出',
};

const PHASE_DETAIL: Record<string, string> = {
  pending: '从未完整探测的线路',
  quarantine: '已到期、等待复测的线路',
};

const PHASE_MESSAGE_KEY: Record<string, string> = {
  pending: '待测',
  quarantine: '待复测',
};

function describeScheduleResult(result: string): string {
  if (result === 'idle: no due lines') return '暂无到期线路，本轮跳过';
  if (result === 'skipped: running') return '有任务正在运行，本轮跳过';
  if (result === 'skipped: quota') return 'KV 写入接近上限，本轮跳过';
  if (result === 'queued') return '已派发';
  if (result === 'fetch added pending') return '抓源新增待测线路，已提前唤醒';
  return result;
}

interface TaskBoard {
  batchSize: number;
  intervalHours: number;
  phases: TaskPhase[];
  statsGeneratedAt?: string | null;
  items?: TaskItem[];
  schedules: {
    probe: { enabled: boolean; nextAt: string | null; lastRunAt: string | null; result: string | null };
    fetch: { enabled: boolean; intervalDays: number; nextAt: string | null; lastRunAt: string | null; result: string | null };
    publish: { enabled: boolean; times: string; nextAt: string | null; lastRunAt: string | null; result: string | null };
  };
}

function taskEta(task: TaskItem): string {
  if (!task.startedAt) return '等待开始';
  const elapsedSec = Math.max(1, (Date.now() - Date.parse(task.startedAt)) / 1000);
  const { done, total } = task.progress;
  if (total > 0 && done > 0) {
    const remaining = Math.max(0, total - done);
    const etaSec = remaining / (done / elapsedSec);
    return etaSec > 0 ? `预计剩余 ${Math.max(1, Math.ceil(etaSec / 60))} 分钟` : '即将完成';
  }
  return `已运行 ${Math.max(0, Math.floor(elapsedSec / 60))} 分钟`;
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<AdminStats>('/api/admin/stats'),
  });

  const usageQuery = useQuery({
    queryKey: ['admin', 'usage'],
    queryFn: () => api.get<{ usage: UsageSnapshot | null }>('/api/admin/usage'),
  });

  const epgCoverage = useQuery({
    queryKey: ['admin', 'epg-coverage'],
    queryFn: () =>
      api.get<{
        total: number;
        covered: number;
        percent: number;
        missing: Array<{ id: string; name: string; group: string }>;
        missingTotal: number;
      }>('/api/admin/epg/coverage'),
  });

  const dispatch = useMutation({
    mutationFn: (command: 'collect' | 'export' | 'probe') => api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { command }),
    onSuccess: (result) => {
      show(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const tasks = useQuery({
    queryKey: ['admin', 'tasks'],
    queryFn: () => api.get<TaskBoard>('/api/admin/tasks'),
    refetchInterval: 15_000,
  });

  const runTask = useMutation({
    mutationFn: (body: { command: 'probe-batch' | 'fetch' | 'publish' | 'epg'; phase?: string }) =>
      api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', body),
    onSuccess: (result) => {
      show(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const taskAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.patch<{ message: string }>(`/api/admin/tasks/${id}`, { action }),
    onSuccess: (result) => {
      show(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const recoverStuck = useMutation({
    mutationFn: () => api.post<{ cancelled: number; failed: number }>('/api/admin/actions/recover-stuck'),
    onSuccess: (result) => {
      show(`已结束 ${result.failed} 个卡死任务${result.cancelled ? `，取消 ${result.cancelled} 个 Actions 运行` : ''}`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const savePhasePlan = useMutation({
    mutationFn: (patch: { probePhaseOrder?: string; probePausedPhases?: string }) =>
      api.put<{ settings: unknown }>('/api/admin/settings', patch),
    onSuccess: () => {
      show('分批阶段已更新');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const refreshUsage = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/admin/usage/refresh'),
    onSuccess: async (result) => {
      const before = usageQuery.data?.usage?.collectedAt ?? '';
      show(`${result.message}，等待新快照…`);
      // The workflow takes 2–4 minutes (npm ci + Cloudflare GraphQL), so a
      // single 60s refetch usually showed the old snapshot again.
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        try {
          const next = await api.get<{ usage: UsageSnapshot | null }>('/api/admin/usage');
          if (next.usage?.collectedAt !== before) {
            queryClient.setQueryData(['admin', 'usage'], next);
            show('用量快照已更新');
            return;
          }
        } catch {
          // Network hiccup or the workflow is still queued — keep polling.
        }
      }
      show('用量快照尚未更新，请稍后再试', 'error');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'usage'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const backup = useMutation({
    mutationFn: () => api.get<unknown>('/api/admin/backup'),
    onSuccess: (payload) => {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `iptv-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      show('备份已导出');
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const taskItems = tasks.data?.items ?? [];
  const runningTask = taskItems.find((task) => task.status === 'running');
  const scheduledTasks = taskItems.filter((task) => task.status === 'scheduled');
  const queuedTasks = taskItems
    .filter((task) => task.status === 'queued' || task.status === 'paused')
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const recentTasks = taskItems
    .filter((task) => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
    .slice(0, 5);

  const movePhase = (index: number, delta: number): void => {
    const board = tasks.data;
    if (!board) return;
    const ids = board.phases.map((phase) => phase.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    savePhasePlan.mutate({ probePhaseOrder: ids.join(',') });
  };

  const togglePhase = (id: TaskPhase['id']): void => {
    const board = tasks.data;
    if (!board) return;
    const paused = new Set(board.phases.filter((phase) => phase.paused).map((phase) => phase.id));
    if (paused.has(id)) paused.delete(id);
    else paused.add(id);
    savePhasePlan.mutate({ probePausedPhases: [...paused].join(',') });
  };

  if (isLoading) {
    return (
      <div className="stack">
        <Skeleton height={34} width={200} />
        <div className="grid">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={92} radius={16} />)}
        </div>
        <Skeleton height={240} radius={16} />
      </div>
    );
  }

  const stats = data!;
  const ready = stats.index.ready;
  const poolTotal = stats.pool?.total ?? stats.index.totals.lines;
  const poolAlive = stats.pool?.alive ?? stats.index.totals.alive;
  const poolRatio = poolTotal ? Math.round((poolAlive / poolTotal) * 100) : 0;
  const publishedRatio = stats.index.totals.lines ? Math.round((stats.index.totals.alive / stats.index.totals.lines) * 100) : 0;
  const usage = usageQuery.data?.usage;
  const today = new Date().toISOString().slice(0, 10);
  // The snapshot is written up to 6 hours apart; right after UTC midnight it
  // still carries yesterday's totals. Only trust it when its day matches today.
  const kvToday = usage?.kv.day === today ? usage.kv : null;
  const d1Today = usage?.d1.day === today ? usage.d1 : null;
  const kvWrites = kvToday?.writes ?? 0;
  const kvReads = kvToday?.reads ?? 0;
  const kvLists = kvToday?.lists ?? 0;
  const d1Writes = d1Today?.rowsWritten ?? 0;
  const d1Reads = d1Today?.rowsRead ?? 0;
  const kvBlocked = kvWrites >= 920;
  const kvWarn = kvWrites >= 850;
  const kvListWarn = kvLists >= 850;

  return (
    <div className="stack">
      <div className="admin-hero">
        <div className="admin-hero__content">
          <div className="admin-eyebrow">CONTROL CENTER</div>
          <h1 className="large-title">概览</h1>
          <p className="subhead" style={{ marginTop: 4 }}>
            {ready ? `数据更新于 ${timeAgo(stats.index.generatedAt)}` : '还没有生成频道数据'}
          </p>
          {ready ? (
            <p className="caption" style={{ marginTop: 2 }}>
              已发布 {stats.index.generatedAt ? formatSnapshot(stats.index.generatedAt) : '—'} · 线路池 {stats.pool?.generatedAt ? formatSnapshot(stats.pool.generatedAt) : '—'}
            </p>
          ) : null}
          <div className="row row--wrap" style={{ marginTop: 12, gap: 6 }}>
            <Badge tone={ready ? 'green' : 'orange'}>{ready ? '数据已就绪' : '等待首次采集'}</Badge>
            <Badge tone={kvBlocked ? 'red' : kvWarn ? 'orange' : 'blue'}>KV {formatNumber(kvWrites)}/1000</Badge>
            <Badge>{stats.index.totals.channels} 频道 · {stats.index.totals.alive} 可用</Badge>
          </div>
        </div>
        <div className="admin-hero__actions">
          <Button variant="primary" loading={dispatch.isPending} disabled={kvBlocked} onClick={() => dispatch.mutate('collect')}>
            <PlayCircle size={15} /> 立即采集
          </Button>
          <Button loading={runTask.isPending} onClick={() => runTask.mutate({ command: 'publish' })}>
            <RefreshCw size={15} /> 发布更新
          </Button>
          <div className="admin-more">
            <Button onClick={() => setMoreOpen((value) => !value)}>更多操作</Button>
            {moreOpen ? (
              <div className="admin-more__menu">
                <button className="admin-more__item" disabled={refreshUsage.isPending} onClick={() => { setMoreOpen(false); refreshUsage.mutate(); }}>
                  <RefreshCw size={14} /> 刷新用量
                </button>
                <button className="admin-more__item" disabled={dispatch.isPending || kvBlocked} onClick={() => { setMoreOpen(false); dispatch.mutate('export'); }}>
                  <RefreshCw size={14} /> 重建导出
                </button>
                <button className="admin-more__item" disabled={backup.isPending} onClick={() => { setMoreOpen(false); backup.mutate(); }}>
                  <Download size={14} /> 备份配置
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {kvWarn ? (
        <div className="caption" style={{ color: kvBlocked ? 'var(--red)' : 'var(--orange)', padding: '0 2px' }}>
          KV 今日已写入 {formatNumber(kvWrites)} / 1,000
          {kvBlocked ? '，已暂停触发采集与导出，请等 UTC 00:00 重置。' : '，接近上限，请避免频繁采集。'}
        </div>
      ) : null}
      {kvListWarn ? (
        <div className="caption" style={{ color: 'var(--orange)', padding: '0 2px' }}>
          KV 今日列表 {formatNumber(kvLists)} / 1,000，接近免费额度。
        </div>
      ) : null}

      {!ready ? (
        <Card>
          <EmptyState
            icon={<Database size={24} />}
            title="等待第一次采集"
            description="点击「立即采集」触发 GitHub Actions：抓取源 → 测速 → 聚合 → 发布到 R2。也可以在仓库 Actions 页面手动触发。"
            action={<Button variant="primary" onClick={() => dispatch.mutate('collect')}>立即采集</Button>}
          />
        </Card>
      ) : null}

      <div className="dashboard-stats">
        <div className="dash-stat">
          <span className="dash-stat__icon dash-stat__icon--blue"><Tv size={16} /></span>
          <div><div className="dash-stat__value">{formatNumber(stats.index.totals.channels)}</div><div className="dash-stat__label">已发布频道</div></div>
        </div>
        <div className="dash-stat">
          <span className="dash-stat__icon dash-stat__icon--green"><RadioTower size={16} /></span>
          <div><div className="dash-stat__value">{formatNumber(stats.index.totals.alive)}</div><div className="dash-stat__label">已发布可用 · {publishedRatio}% / 共 {formatNumber(stats.index.totals.lines)}</div></div>
        </div>
        <div className="dash-stat">
          <span className="dash-stat__icon dash-stat__icon--teal"><Layers3 size={16} /></span>
          <div><div className="dash-stat__value">{formatNumber(poolAlive)}</div><div className="dash-stat__label">线路池可用 · {poolRatio}% / 共 {formatNumber(poolTotal)}</div></div>
        </div>
        <div className="dash-stat">
          <span className="dash-stat__icon dash-stat__icon--orange"><RadioTower size={16} /></span>
          <div><div className="dash-stat__value">{formatNumber(stats.sources.enabled)}</div><div className="dash-stat__label">启用源 / 共 {formatNumber(stats.sources.total)}</div></div>
        </div>
        <div className="dash-stat">
          <span className="dash-stat__icon dash-stat__icon--purple"><Share2 size={16} /></span>
          <div><div className="dash-stat__value">{formatNumber(stats.subscriptions)}</div><div className="dash-stat__label">订阅出口</div></div>
        </div>
      </div>

      {stats.pool?.generatedAt && stats.index.generatedAt && Date.parse(stats.pool.generatedAt) > Date.parse(stats.index.generatedAt) ? (
        <Card className="publish-warning">
          <div className="publish-warning__icon"><RadioTower size={18} /></div>
          <div className="grow">
            <div className="publish-warning__title">线路池已更新，尚未发布到前台</div>
            <div className="caption">探测结果只更新线路池；发布后频道、订阅和节目单才会变化。</div>
          </div>
          <Button variant="primary" loading={runTask.isPending} onClick={() => runTask.mutate({ command: 'publish' })}>
            发布更新
          </Button>
        </Card>
      ) : null}

      <Card className="task-board">
        <div className="row row--between row--wrap task-board__header">
          <div className="row" style={{ gap: 8 }}>
            <span className="task-board__icon"><ListChecks size={17} /></span>
            <div>
              <div className="title-3">任务中心</div>
              <div className="caption">
                {tasks.data ? `每 ${tasks.data.intervalHours} 小时一批 · 每批 ${tasks.data.batchSize} 条` : '加载中'}
              </div>
            </div>
          </div>
          {tasks.data ? (
            <div className="row row--wrap" style={{ gap: 6 }}>
              <Badge tone={runningTask ? 'green' : 'default'}>{runningTask ? '运行中 1' : '空闲'}</Badge>
              <Badge tone={queuedTasks.length ? 'blue' : 'default'}>排队 {queuedTasks.length}</Badge>
              <Badge>计划 {scheduledTasks.length}</Badge>
            </div>
          ) : null}
        </div>
        {tasks.data ? (
          <>
            <div className="task-section">
              <div className="task-section__head">
                <span>运行中</span>
                <div className="row" style={{ gap: 8 }}>
                  <span className="caption">{runningTask ? taskEta(runningTask) : '当前空闲'}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={recoverStuck.isPending}
                    onClick={() => {
                      if (confirm('取消 GitHub 上运行中/排队的 Actions，并把本地所有运行中任务标记失败？')) recoverStuck.mutate();
                    }}
                  >
                    <Ban size={13} /> 结束卡死
                  </Button>
                </div>
              </div>
              {runningTask ? (
                <div className="task-running">
                  <div className="grow">
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      <Badge tone="blue">{TASK_SOURCE_LABEL[runningTask.source]}</Badge>
                      <span className="task-running__title">{runningTask.label ?? TASK_TYPE_LABEL[runningTask.type] ?? runningTask.type}</span>
                      <Badge tone="green">运行中</Badge>
                    </div>
                    <div className="caption" style={{ marginTop: 4 }}>
                      {runningTask.message ?? '执行中'}
                      {runningTask.progress.total > 0 ? ` · ${runningTask.progress.done}/${runningTask.progress.total} ${runningTask.progress.unit}` : ''}
                    </div>
                    {runningTask.progress.total > 0 ? (
                      <div className="meter" style={{ marginTop: 8 }}>
                        <div className="meter__fill" style={{ width: `${Math.min(100, Math.max(1, (runningTask.progress.done / runningTask.progress.total) * 100))}%`, background: 'var(--green)' }} />
                      </div>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={taskAction.isPending}
                    onClick={() => {
                      if (confirm('强制结束这个任务？GitHub Actions 运行可能还在继续，必要时再点「结束卡死」。')) taskAction.mutate({ id: runningTask.id, action: 'force-fail' });
                    }}
                  >
                    强制结束
                  </Button>
                </div>
              ) : (
                <div className="task-empty">当前没有运行中的任务</div>
              )}
            </div>

            <div className="task-columns">
              <div className="task-section">
                <div className="task-section__head">
                  <span>计划任务</span>
                  <span className="caption">到点自动执行</span>
                </div>
                <div className="task-plan-grid">
                  {scheduledTasks.map((task) => {
                    const isPolicy = task.payload.afterPublish === 'true';
                    return (
                      <div className="task-plan task-plan--blue" key={task.id}>
                        <div className="grow">
                          <div className="task-plan__title">{task.label ?? TASK_TYPE_LABEL[task.type] ?? task.type}</div>
                          <div className="caption">
                            {isPolicy ? '发布成功后自动执行' : task.payload.nextAt ? `下次 ${formatSnapshot(task.payload.nextAt)}` : '等待新线路'}
                          </div>
                          {task.payload.result && task.payload.result !== 'queued' ? (
                            <div className="caption" style={{ marginTop: 2, color: task.payload.result.startsWith('skipped') ? 'var(--orange)' : undefined }}>
                              上次调度：{describeScheduleResult(task.payload.result)}
                              {task.payload.lastRunAt ? ` · ${formatSnapshot(task.payload.lastRunAt)}` : ''}
                            </div>
                          ) : null}
                        </div>
                        {!isPolicy ? (
                          <Button loading={runTask.isPending} onClick={() => runTask.mutate({ command: task.type as 'probe-batch' | 'fetch' | 'publish' | 'epg' })}>
                            {task.type === 'probe-batch' ? '立即探测' : '立即执行'}
                          </Button>
                        ) : (
                          <Badge tone="green">发布后</Badge>
                        )}
                      </div>
                    );
                  })}
                  {!scheduledTasks.length ? <div className="task-empty">没有启用的定时任务</div> : null}
                </div>
              </div>

              <div className="task-section">
                <div className="task-section__head">
                  <span>排队中</span>
                  <span className="caption">手动/检测优先</span>
                </div>
                <div className="task-list">
                  {queuedTasks.map((task, index) => {
                    const tone = task.status === 'paused' ? 'orange' : task.source === 'source' ? 'green' : task.source === 'manual' || task.source === 'detection' ? 'blue' : 'default';
                    return (
                    <div className={`task-item task-item--${tone}`} key={task.id}>
                      <div className="grow">
                        <div className="row row--wrap" style={{ gap: 6 }}>
                          <Badge tone={task.source === 'manual' || task.source === 'detection' ? 'blue' : task.source === 'source' ? 'green' : 'default'}>
                            {TASK_SOURCE_LABEL[task.source]}
                          </Badge>
                          <span className="task-item__title">{task.label ?? TASK_TYPE_LABEL[task.type] ?? task.type}</span>
                          {task.status === 'paused' ? <Badge tone="orange">已暂停</Badge> : null}
                        </div>
                        <div className="caption" style={{ marginTop: 3 }}>
                          {task.progress.total > 0 ? `${task.progress.done}/${task.progress.total} ${task.progress.unit} · ` : ''}
                          {task.message ?? '等待执行'} · {timeAgo(task.createdAt)}
                        </div>
                      </div>
                      <div className="task-item__actions">
                        <Button size="sm" variant="ghost" disabled={index === 0} title="提升" onClick={() => taskAction.mutate({ id: task.id, action: 'move-up' })}><ArrowUp size={14} /></Button>
                        <Button size="sm" variant="ghost" disabled={index === queuedTasks.length - 1} title="延后" onClick={() => taskAction.mutate({ id: task.id, action: 'move-down' })}><ArrowDown size={14} /></Button>
                        <Button size="sm" variant="ghost" title={task.status === 'paused' ? '恢复' : '暂停'} onClick={() => taskAction.mutate({ id: task.id, action: task.status === 'paused' ? 'resume' : 'pause' })}>{task.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}</Button>
                        <Button size="sm" variant="ghost" title="取消" onClick={() => taskAction.mutate({ id: task.id, action: 'cancel' })}>取消</Button>
                        <Button size="sm" variant="glass" title="插到队首" onClick={() => taskAction.mutate({ id: task.id, action: 'run-now' })}>插队</Button>
                      </div>
                    </div>
                    );
                  })}
                  {!queuedTasks.length ? <div className="task-empty">队列为空</div> : null}
                </div>
              </div>
            </div>

            <div className="task-section">
              <div className="task-section__head">
                <span>最近完成</span>
                <span className="caption">保留最近 30 条</span>
              </div>
              <div className="task-list">
                {recentTasks.map((task) => (
                  <div className={`task-item task-item--${task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : 'orange'}`} key={task.id}>
                    <div className="grow">
                      <div className="row row--wrap" style={{ gap: 6 }}>
                        <Badge tone={task.source === 'manual' || task.source === 'detection' ? 'blue' : 'default'}>{TASK_SOURCE_LABEL[task.source]}</Badge>
                        <span className="task-item__title">{task.label ?? TASK_TYPE_LABEL[task.type] ?? task.type}</span>
                        <Badge tone={task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : 'default'}>
                          {task.status === 'done' ? '完成' : task.status === 'failed' ? '失败' : '取消'}
                        </Badge>
                      </div>
                      <div className="caption" style={{ marginTop: 3 }}>{task.message ?? ''} · {task.finishedAt ? timeAgo(task.finishedAt) : ''}</div>
                      {task.failureReason ? <div className="caption task-failure">失败原因：{task.failureReason}</div> : null}
                    </div>
                    {task.status === 'failed' || task.status === 'cancelled' ? (
                      <Button size="sm" onClick={() => taskAction.mutate({ id: task.id, action: 'retry' })}>重试</Button>
                    ) : null}
                  </div>
                ))}
                {!recentTasks.length ? <div className="task-empty">还没有完成记录</div> : null}
              </div>
            </div>

            <div className="task-foot">
              <div className="row row--wrap" style={{ gap: 8 }}>
                <Badge>{`待测 ${tasks.data.phases.find((phase) => phase.id === 'pending')?.count ?? 0}`}</Badge>
                <Badge>{`待复测 ${tasks.data.phases.find((phase) => phase.id === 'quarantine')?.count ?? 0}`}</Badge>
                <span className="caption">抓源 {tasks.data.schedules.fetch.enabled ? `每 ${tasks.data.schedules.fetch.intervalDays} 天` : '关闭'}</span>
                <span className="caption">发布 {tasks.data.schedules.publish.enabled ? tasks.data.schedules.publish.times : '关闭'}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="glass" loading={runTask.isPending} onClick={() => runTask.mutate({ command: 'fetch' })}>立即抓源</Button>
                <Button size="sm" variant="glass" loading={runTask.isPending} onClick={() => runTask.mutate({ command: 'publish' })}>立即发布</Button>
              </div>
            </div>

            <details className="task-phases">
              <summary className="caption">分批阶段设置（到期可测 / 顺序 / 暂停）</summary>
              <div className="caption" style={{ marginBottom: 8 }}>
                这里的数量只统计已到期可测的线路；可用线路未到复测时间时不会出现在待测/待复测里。
                {tasks.data.statsGeneratedAt ? ` 统计更新于 ${formatSnapshot(tasks.data.statsGeneratedAt)}。` : ' 暂无到期统计。'}
              </div>
              <div className="task-phase-list">
                {tasks.data.phases.map((phase, index) => {
                  const backlog = tasks.data!.phases.reduce((sum, item) => sum + item.count, 0);
                  const phaseKey = PHASE_MESSAGE_KEY[phase.id] ?? phase.label;
                  const lastBatch = recentTasks.find((task) => task.type === 'probe-batch' && task.message?.includes(phaseKey))
                    ?? recentTasks.find((task) => task.type === 'probe-batch');
                  return (
                    <div className="task-phase" key={phase.id}>
                      <div className="task-phase__order">{index + 1}</div>
                      <div className="grow">
                        <div className="row row--wrap" style={{ gap: 6 }}>
                          <span className="task-phase__title">{phase.label}</span>
                          <Badge tone={phase.paused ? 'orange' : 'blue'}>{phase.paused ? '已暂停' : '自动执行'}</Badge>
                        </div>
                        <div className="caption" style={{ marginTop: 3 }}>{PHASE_DETAIL[phase.id] ?? phase.label}</div>
                        <div className="task-phase__stats">
                          <span><strong>{formatNumber(phase.count)}</strong> 条到期可测</span>
                          <span>预计 <strong>{phase.estimatedBatches}</strong> 批</span>
                          <span>每批 <strong>{tasks.data!.batchSize}</strong> 条</span>
                          <span>下次 {tasks.data!.schedules.probe.nextAt ? formatSnapshot(tasks.data!.schedules.probe.nextAt) : '待定'}</span>
                        </div>
                        <div className="task-phase__track">
                          <div className="task-phase__fill" style={{ width: `${backlog > 0 ? Math.max(2, (phase.count / backlog) * 100) : 0}%` }} />
                        </div>
                        {lastBatch ? (
                          <div className="task-phase__last">
                            <div className="task-phase__last-head">
                              <span>最近一批</span>
                              <span>{lastBatch.finishedAt ? timeAgo(lastBatch.finishedAt) : ''}</span>
                            </div>
                            <div>{lastBatch.message}</div>
                            {lastBatch.failureReason ? <div className="task-failure">失败原因：{lastBatch.failureReason}</div> : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="task-phase__actions">
                        <Button size="sm" variant="glass" disabled={index === 0 || savePhasePlan.isPending} onClick={() => movePhase(index, -1)}>
                          <ArrowUp size={14} /> 上移
                        </Button>
                        <Button size="sm" variant="glass" disabled={index === tasks.data!.phases.length - 1 || savePhasePlan.isPending} onClick={() => movePhase(index, 1)}>
                          <ArrowDown size={14} /> 下移
                        </Button>
                        <Button size="sm" variant="glass" disabled={savePhasePlan.isPending} onClick={() => togglePhase(phase.id)}>
                          {phase.paused ? <Play size={14} /> : <Pause size={14} />}
                          {phase.paused ? '恢复' : '暂停'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          </>
        ) : (
          <Skeleton height={90} radius={12} />
        )}
      </Card>

      {epgCoverage.data ? (
        <Card className="epg-card">
          <div className="epg-card__head">
            <span className="epg-card__icon"><Tv size={17} /></span>
            <div className="grow">
              <div className="title-3">EPG 覆盖率</div>
              <div className="caption">{epgCoverage.data.covered} / {epgCoverage.data.total} 频道有节目单</div>
            </div>
            <div className="epg-card__percent">{epgCoverage.data.percent}%</div>
          </div>
          <UsageBar label="有节目单" used={epgCoverage.data.covered} limit={epgCoverage.data.total} />
          <div className="caption" style={{ marginTop: 10 }}>
            缺少节目单 {epgCoverage.data.missingTotal} 个
            {epgCoverage.data.missing.length
              ? ` · ${epgCoverage.data.missing.slice(0, 6).map((item) => item.name).join(' / ')}${epgCoverage.data.missingTotal > 6 ? ' …' : ''}`
              : ''}
          </div>
        </Card>
      ) : null}

      <div className="grid grid--wide usage-grid">
        {(() => {
          const snapshot = usageQuery.data?.usage ?? null;
          const yesterday = snapshot?.history?.at(-2);
          return (
            <>
              <Card className="usage-card usage-card--github">
                <div className="usage-card__head">
                  <span className="usage-card__icon"><ListChecks size={17} /></span>
                  <div className="grow">
                    <div className="title-3">GitHub Actions</div>
                    <div className="caption">{snapshot ? timeAgo(snapshot.collectedAt) : '等待用量快照'}</div>
                  </div>
                </div>
                {snapshot ? (
                  <>
                    <UsageBar label="本月已用（估算）" used={snapshot.github.minutes} limit={2000} format={(value) => `${value} 分钟`} />
                    <div className="caption" style={{ marginTop: 8 }}>
                      本月 {snapshot.github.runs} 次运行 · 剩余约 {Math.max(0, 2000 - snapshot.github.minutes)} 分钟
                    </div>
                  </>
                ) : (
                  <div className="caption" style={{ marginTop: 10 }}>采集结束自动更新用量快照，也可以手动刷新</div>
                )}
                <div className="caption" style={{ marginTop: 6 }}>私有仓库免费 2000 分钟/月，按运行时长估算，账单日重置</div>
              </Card>

              <Card className="usage-card usage-card--kv">
                <div className="usage-card__head">
                  <span className="usage-card__icon"><Cloud size={17} /></span>
                  <div className="grow">
                    <div className="title-3">Cloudflare KV</div>
                    <div className="caption">{snapshot ? `快照 ${formatSnapshot(snapshot.collectedAt)}` : '等待快照'}</div>
                  </div>
                </div>
                {snapshot ? (
                  <>
                    <UsageBar label="今日写入" used={kvWrites} limit={1000} />
                    <UsageBar label="今日读取" used={kvReads} limit={100000} />
                    <UsageBar label="今日列表" used={kvLists} limit={1000} />
                    <UsageBar label="存储占用" used={snapshot.kv.storageBytes} limit={1024 ** 3} format={formatBytes} />
                    <div className="caption" style={{ marginTop: 8 }}>
                      {kvToday
                        ? '免费额度每日 UTC 00:00（北京时间 08:00）重置'
                        : `额度已重置，快照仍是 ${snapshot.kv.day} 的数据，等下一轮刷新`}
                      {yesterday ? ` · 昨日（${yesterday.date}）写 ${formatNumber(yesterday.kvWrites)}` : ''}
                    </div>
                  </>
                ) : (
                  <div className="caption" style={{ marginTop: 10 }}>等待用量工作流采集</div>
                )}
              </Card>

              <Card className="usage-card usage-card--d1">
                <div className="usage-card__head">
                  <span className="usage-card__icon"><Database size={17} /></span>
                  <div className="grow">
                    <div className="title-3">Cloudflare D1</div>
                    <div className="caption">{snapshot ? `快照 ${formatSnapshot(snapshot.collectedAt)}` : '等待快照'}</div>
                  </div>
                </div>
                {snapshot ? (
                  <>
                    <UsageBar label="今日写入行数" used={d1Writes} limit={100000} />
                    <UsageBar label="今日读取行数" used={d1Reads} limit={5000000} />
                    <div className="caption" style={{ marginTop: 8 }}>
                      {d1Today
                        ? `写入已用 ${Math.round((d1Writes / 100000) * 100)}%`
                        : `额度已重置，快照仍是 ${snapshot.d1.day} 的数据，等下一轮刷新`} · 免费额度每日 UTC 00:00 重置
                      {yesterday ? ` · 昨日（${yesterday.date}）写 ${formatNumber(yesterday.d1Writes)}` : ''}
                    </div>
                  </>
                ) : (
                  <div className="caption" style={{ marginTop: 10 }}>等待用量工作流采集</div>
                )}
              </Card>

              {snapshot?.history?.length ? (
                <Card className="usage-trend">
                  <div className="row row--between">
                    <div className="title-3">近 7 天趋势</div>
                    <span className="caption">UTC 日期 · KV / D1 / Actions</span>
                  </div>
                  <div className="table-wrap" style={{ marginTop: 8, border: 0 }}>
                    <table className="table" style={{ minWidth: 360 }}>
                      <thead>
                        <tr><th>日期</th><th>KV 写</th><th>D1 写</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {snapshot.history.map((day) => (
                          <tr key={day.date}>
                            <td className="caption">{day.date.slice(5)}</td>
                            <td style={{ color: day.kvWrites > 800 ? 'var(--orange)' : undefined }}>{formatNumber(day.kvWrites)}</td>
                            <td style={{ color: day.d1Writes > 80000 ? 'var(--orange)' : undefined }}>{formatNumber(day.d1Writes)}</td>
                            <td>{day.githubMinutes} 分</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}
            </>
          );
        })()}
      </div>

      <div className="grid grid--wide dashboard-bottom-grid">
        <Card className="health-card">
          <div className="row row--between">
            <div>
              <div className="title-3">源健康度</div>
              <div className="caption">{stats.sources.total} 个采集站</div>
            </div>
            <Link to="/admin/sources" className="caption">管理 <ArrowUpRight size={12} /></Link>
          </div>
          {(() => {
            const total = Math.max(1, stats.sources.reputation.high + stats.sources.reputation.normal + stats.sources.reputation.low);
            const items = [
              { label: '优质', value: stats.sources.reputation.high, tone: 'green' },
              { label: '正常', value: stats.sources.reputation.normal, tone: 'orange' },
              { label: '降权', value: stats.sources.reputation.low, tone: 'red' },
            ];
            return (
              <>
                <div className="health-stats">
                  {items.map((item) => (
                    <div className={`health-stat health-stat--${item.tone}`} key={item.label}>
                      <span className="health-stat__dot" />
                      <div>
                        <div className="health-stat__value">{formatNumber(item.value)}</div>
                        <div className="health-stat__label">{item.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="health-bar">
                  {items.map((item) => (
                    <span key={item.label} className={`health-bar__part health-bar__part--${item.tone}`} style={{ width: `${(item.value / total) * 100}%` }} />
                  ))}
                </div>
              </>
            );
          })()}
          {stats.sources.failing > 0 ? (
            <div className="health-warning"><AlertTriangle size={15} /> {stats.sources.failing} 个源连续抓取失败</div>
          ) : (
            <div className="caption" style={{ marginTop: 10 }}>暂无连续失败源</div>
          )}
        </Card>

        <Card className="quick-card">
          <div className="row row--between">
            <div className="title-3">快捷入口</div>
            <span className="caption">常用操作</span>
          </div>
          <div className="quick-grid">
            <Link className="quick-tile" to="/admin/probe">
              <span className="quick-tile__icon"><RadioTower size={18} /></span>
              <span className="grow">
                <span className="quick-tile__title">检测中心</span>
                <span className="caption">测速 / 单条调试</span>
              </span>
              <ArrowUpRight size={14} />
            </Link>
            <Link className="quick-tile" to="/admin/subscriptions">
              <span className="quick-tile__icon"><Users size={18} /></span>
              <span className="grow">
                <span className="quick-tile__title">订阅与导出</span>
                <span className="caption">M3U / TXT / JSON</span>
              </span>
              <ArrowUpRight size={14} />
            </Link>
            <Link className="quick-tile" to="/admin/settings">
              <span className="quick-tile__icon"><RefreshCw size={18} /></span>
              <span className="grow">
                <span className="quick-tile__title">采集与 EPG 设置</span>
                <span className="caption">预算 / 保留</span>
              </span>
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </Card>
      </div>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">最近运行</div>
            <div className="caption">最近 {stats.runs.length} 次运行记录</div>
          </div>
          <Link to="/admin/runs" className="caption">全部记录 →</Link>
        </div>
        <div className="run-list">
          {stats.runs.map((run) => {
            const tone = run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange';
            const statusText = run.status === 'success' ? '成功' : run.status === 'partial' ? '部分' : run.status === 'running' ? '运行中' : '失败';
            return (
              <div className={`run-row run-row--${tone}`} key={run.id}>
                <div className="run-row__status"><Badge tone={tone}>{statusText}</Badge></div>
                <div className="grow">
                  <div className="run-row__title">{run.task_label ?? (run.task_type ? TASK_TYPE_LABEL[run.task_type] ?? run.task_type : '运行记录')}</div>
                  {run.task_message ? <div className="caption run-row__message">{run.task_message}</div> : null}
                  {run.task_failure_reason ? <div className="caption task-failure">失败原因：{run.task_failure_reason}</div> : null}
                </div>
                <div className="run-row__metrics">
                  <span><strong>{formatNumber(run.channels)}</strong> 频道</span>
                  <span><strong>{formatNumber(run.alive)}</strong> 可用</span>
                  <span><strong>{formatNumber(run.probed)}</strong> 已测</span>
                </div>
                <div className="run-row__time">
                  <span>{timeAgo(run.started_at)}</span>
                  <span className="caption">{formatDuration(run.duration_ms)}</span>
                </div>
              </div>
            );
          })}
          {!stats.runs.length ? <div className="task-empty">还没有运行记录</div> : null}
        </div>
      </Card>
    </div>
  );
}
