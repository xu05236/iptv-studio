import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, Database, PlayCircle, RefreshCw, RadioTower, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminStats } from '../../lib/types';
import { formatDuration, timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Skeleton, Stat, useToast } from '../../components/ui';

export function Dashboard() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<AdminStats>('/api/admin/stats'),
  });

  const dispatch = useMutation({
    mutationFn: (command: 'collect' | 'export') => api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { command }),
    onSuccess: (result) => {
      show(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
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
          <Button loading={dispatch.isPending} onClick={() => dispatch.mutate('collect')}>
            <PlayCircle size={15} /> 立即采集
          </Button>
          <Button loading={dispatch.isPending} onClick={() => dispatch.mutate('export')}>
            <RefreshCw size={15} /> 重建导出
          </Button>
        </div>
      </div>

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
