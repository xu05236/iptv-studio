import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, Database, Download, PlayCircle, RefreshCw, RadioTower, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminStats, UsageSnapshot } from '../../lib/types';
import { formatDuration, timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Skeleton, Stat, useToast } from '../../components/ui';

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

export function Dashboard() {
  const queryClient = useQueryClient();
  const { show } = useToast();
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
    mutationFn: (command: 'collect' | 'export') => api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { command }),
    onSuccess: (result) => {
      show(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
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
  const aliveRatio = stats.index.totals.lines ? Math.round((stats.index.totals.alive / stats.index.totals.lines) * 100) : 0;
  const usage = usageQuery.data?.usage;
  const today = new Date().toISOString().slice(0, 10);
  // The snapshot is written up to 6 hours apart; right after UTC midnight it
  // still carries yesterday's totals. Only trust it when its day matches today.
  const kvToday = usage?.kv.day === today ? usage.kv : null;
  const d1Today = usage?.d1.day === today ? usage.d1 : null;
  const kvWrites = kvToday?.writes ?? 0;
  const kvReads = kvToday?.reads ?? 0;
  const d1Writes = d1Today?.rowsWritten ?? 0;
  const d1Reads = d1Today?.rowsRead ?? 0;
  const kvBlocked = kvWrites >= 920;
  const kvWarn = kvWrites >= 850;

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">概览</h1>
          <p className="subhead" style={{ marginTop: 4 }}>
            {ready ? `数据更新于 ${timeAgo(stats.index.generatedAt)}` : '还没有生成频道数据'}
          </p>
        </div>
        <div className="row">
          <Button loading={dispatch.isPending} disabled={kvBlocked} onClick={() => dispatch.mutate('collect')}>
            <PlayCircle size={15} /> 立即采集
          </Button>
          <Button loading={refreshUsage.isPending} onClick={() => refreshUsage.mutate()}>
            <RefreshCw size={15} /> 刷新用量
          </Button>
          <Button loading={dispatch.isPending} disabled={kvBlocked} onClick={() => dispatch.mutate('export')}>
            <RefreshCw size={15} /> 重建导出
          </Button>
          <Button loading={backup.isPending} onClick={() => backup.mutate()}>
            <Download size={15} /> 备份
          </Button>
        </div>
      </div>

      {kvWarn ? (
        <div className="caption" style={{ color: kvBlocked ? 'var(--red)' : 'var(--orange)', padding: '0 2px' }}>
          KV 今日已写入 {formatNumber(kvWrites)} / 1,000
          {kvBlocked ? '，已暂停触发采集与导出，请等 UTC 00:00 重置。' : '，接近上限，请避免频繁采集。'}
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

      <div className="grid">
        <Stat value={stats.index.totals.channels} label="频道总数" />
        <Stat value={stats.index.totals.alive} label={`可用线路 · ${aliveRatio}%`} />
        <Stat value={stats.sources.enabled} label={`启用源 / 共 ${stats.sources.total}`} />
        <Stat value={stats.subscriptions} label="订阅出口" />
      </div>

      {epgCoverage.data ? (
        <Card>
          <div className="row row--between">
            <div className="title-3">EPG 覆盖率</div>
            <span className="caption">{epgCoverage.data.covered} / {epgCoverage.data.total} 频道</span>
          </div>
          <UsageBar label={`有节目单 · ${epgCoverage.data.percent}%`} used={epgCoverage.data.covered} limit={epgCoverage.data.total} />
          <div className="caption" style={{ marginTop: 8 }}>
            缺少节目单 {epgCoverage.data.missingTotal} 个
            {epgCoverage.data.missing.length
              ? ` · ${epgCoverage.data.missing.slice(0, 6).map((item) => item.name).join(' / ')}${epgCoverage.data.missingTotal > 6 ? ' …' : ''}`
              : ''}
          </div>
        </Card>
      ) : null}

      <div className="grid">
        {(() => {
          const snapshot = usageQuery.data?.usage ?? null;
          const yesterday = snapshot?.history?.at(-2);
          return (
            <>
              <Card>
                <div className="row row--between">
                  <div className="title-3">GitHub Actions</div>
                  <span className="caption">{snapshot ? timeAgo(snapshot.collectedAt) : '等待用量快照'}</span>
                </div>
                {snapshot ? (
                  <>
                    <UsageBar label="本月已用（估算）" used={snapshot.github.minutes} limit={2000} format={(value) => `${value} 分钟`} />
                    <div className="caption" style={{ marginTop: 8 }}>
                      本月 {snapshot.github.runs} 次运行 · 剩余约 {Math.max(0, 2000 - snapshot.github.minutes)} 分钟
                    </div>
                  </>
                ) : (
                  <div className="caption" style={{ marginTop: 10 }}>用量工作流每 6 小时更新一次</div>
                )}
                <div className="caption" style={{ marginTop: 6 }}>私有仓库免费 2000 分钟/月，按运行时长估算，账单日重置</div>
              </Card>

              <Card>
                <div className="row row--between">
                  <div className="title-3">Cloudflare KV</div>
                  <span className="caption">{snapshot ? `快照 ${formatSnapshot(snapshot.collectedAt)}` : '等待快照'}</span>
                </div>
                {snapshot ? (
                  <>
                    <UsageBar label="今日写入" used={kvWrites} limit={1000} />
                    <UsageBar label="今日读取" used={kvReads} limit={100000} />
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

              <Card>
                <div className="row row--between">
                  <div className="title-3">Cloudflare D1</div>
                  <span className="caption">{snapshot ? `快照 ${formatSnapshot(snapshot.collectedAt)}` : '等待快照'}</span>
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
                <Card>
                  <div className="row row--between">
                    <div className="title-3">近 7 天趋势</div>
                    <span className="caption">UTC 日期</span>
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

      <div className="grid grid--wide">
        <Card>
          <div className="row row--between">
            <div className="title-3">源健康度</div>
            <Link to="/admin/sources" className="caption">管理 <ArrowUpRight size={12} /></Link>
          </div>
          <div className="grid" style={{ marginTop: 12, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div><div className="title-2" style={{ color: 'var(--green)' }}>{stats.sources.reputation.high}</div><div className="caption">优质</div></div>
            <div><div className="title-2" style={{ color: 'var(--orange)' }}>{stats.sources.reputation.normal}</div><div className="caption">正常</div></div>
            <div><div className="title-2" style={{ color: 'var(--red)' }}>{stats.sources.reputation.low}</div><div className="caption">降权</div></div>
          </div>
          {stats.sources.failing > 0 ? (
            <div className="row" style={{ marginTop: 12, color: 'var(--orange)', fontSize: 13 }}>
              <AlertTriangle size={15} /> {stats.sources.failing} 个源连续抓取失败
            </div>
          ) : null}
        </Card>

        <Card>
          <div className="row row--between">
            <div className="title-3">快捷入口</div>
          </div>
          <div className="stack stack--tight" style={{ marginTop: 10 }}>
            <Link className="list__row" style={{ padding: 8, borderRadius: 10 }} to="/admin/probe">
              <RadioTower size={17} /> <span className="grow">检测中心</span> <span className="caption">测速 / 单条调试</span>
            </Link>
            <Link className="list__row" style={{ padding: 8, borderRadius: 10 }} to="/admin/subscriptions">
              <Users size={17} /> <span className="grow">订阅与导出</span> <span className="caption">M3U / TXT / JSON</span>
            </Link>
            <Link className="list__row" style={{ padding: 8, borderRadius: 10 }} to="/admin/settings">
              <RefreshCw size={17} /> <span className="grow">采集与 EPG 设置</span> <span className="caption">预算 / 保留</span>
            </Link>
          </div>
        </Card>
      </div>

      <Card flush>
        <div className="card__header">
          <div className="title-3">最近运行</div>
          <Link to="/admin/runs" className="caption">全部记录</Link>
        </div>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr><th>状态</th><th>开始</th><th>频道</th><th>可用</th><th>已测</th><th>耗时</th></tr>
            </thead>
            <tbody>
              {stats.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Badge tone={run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>
                      {run.status === 'success' ? '成功' : run.status === 'partial' ? '部分' : run.status === 'running' ? '运行中' : '失败'}
                    </Badge>
                  </td>
                  <td className="caption">{timeAgo(run.started_at)}</td>
                  <td>{run.channels}</td>
                  <td>{run.alive}</td>
                  <td>{run.probed}</td>
                  <td className="caption">{formatDuration(run.duration_ms)}</td>
                </tr>
              ))}
              {!stats.runs.length ? (
                <tr><td colSpan={6}><div className="caption" style={{ padding: 12 }}>还没有运行记录</div></td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
