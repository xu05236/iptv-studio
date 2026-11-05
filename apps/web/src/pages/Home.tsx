import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Clock3, RadioTower, RefreshCw, Tv, Wifi } from 'lucide-react';
import { api } from '../lib/api';
import type { Overview } from '../lib/types';
import { formatBytes, formatNumber, timeAgo } from '../lib/format';
import { Badge, Card, EmptyState, Skeleton } from '../components/ui';

export function Home() {
  const { data, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<Overview>('/api/public/overview'),
  });

  if (isLoading) {
    return (
      <div className="stack" style={{ marginTop: 8 }}>
        <Skeleton height={38} width={180} />
        <Skeleton height={190} radius={22} />
        <Skeleton height={90} radius={16} />
      </div>
    );
  }

  const ready = data?.ready;
  const aliveRatio = data && data.totals.lines > 0 ? Math.round((data.totals.alive / data.totals.lines) * 100) : 0;

  return (
    <div className="stack" style={{ marginTop: 6 }}>
      <div>
        <h1 className="large-title">云视</h1>
        <p className="subhead" style={{ marginTop: 4 }}>聚合、检测、编排你的每一条直播线路</p>
      </div>

      {ready ? (
        <section className="hero">
          <div className="hero__label">已发布可用线路</div>
          <div className="hero__value">{formatNumber(data?.totals.alive)}</div>
          <div className="hero__stats">
            <div className="hero__stat">
              <strong>{formatNumber(data?.totals.channels)}</strong>
              <small>已发布频道</small>
            </div>
            <div className="hero__stat">
              <strong>{formatNumber(data?.totals.lines)}</strong>
              <small>已发布线路</small>
            </div>
            <div className="hero__stat">
              <strong>{aliveRatio}%</strong>
              <small>可用率</small>
            </div>
          </div>
          <div className="row" style={{ marginTop: 18, gap: 8 }}>
            <Link className="btn btn--glass btn--sm" to="/channels">
              <Tv size={14} /> 浏览频道
            </Link>
            <Link className="btn btn--glass btn--sm" to="/admin">
              <RefreshCw size={14} /> 管理后台
            </Link>
          </div>
          <div className="caption" style={{ marginTop: 14, color: 'rgba(255,255,255,.72)' }}>
            数据更新于 {timeAgo(data?.generatedAt)} · 运行 {data?.runId?.slice(0, 12) ?? '—'}
          </div>
        </section>
      ) : (
        <Card>
          <EmptyState
            icon={<RadioTower size={24} />}
            title="还没有频道数据"
            description={data?.message ?? '先在管理后台添加直播源并触发一次采集，订阅地址会自动生效。'}
            action={
              <Link className="btn btn--primary" to="/admin">
                打开管理后台
              </Link>
            }
          />
        </Card>
      )}

      <div className="grid">
        <Card>
          <div className="row row--between">
            <span className="caption">频道分类</span>
            <Activity size={15} color="var(--label-3)" />
          </div>
          <div className="title-2" style={{ marginTop: 6 }}>{data?.groups?.length ?? 0}</div>
          <div className="caption">个分组</div>
        </Card>
        <Card>
          <div className="row row--between">
            <span className="caption">最近更新</span>
            <Clock3 size={15} color="var(--label-3)" />
          </div>
          <div className="title-2" style={{ marginTop: 6 }}>{timeAgo(data?.generatedAt)}</div>
          <div className="caption">自动任务每日运行</div>
        </Card>
        <Card>
          <div className="row row--between">
            <span className="caption">线路健康</span>
            <Wifi size={15} color="var(--label-3)" />
          </div>
          <div className="title-2" style={{ marginTop: 6 }}>{aliveRatio}%</div>
          <div className="meter" style={{ marginTop: 8 }}>
            <div className="meter__fill" style={{ width: `${aliveRatio}%` }} />
          </div>
        </Card>
      </div>

      {data?.groups?.length ? (
        <>
          <div className="section-title">
            <h2>按分类浏览</h2>
            <Link to="/channels">全部频道</Link>
          </div>
          <div className="grid grid--wide">
            {data.groups.slice(0, 6).map((group) => (
              <Link key={group.group} to={`/channels?group=${encodeURIComponent(group.group)}`} className="list__row" style={{ borderRadius: 16, border: '0.5px solid var(--sep)', background: 'var(--bg-elev)' }}>
                <div className="logo logo--fallback" style={{ fontSize: 14 }}>{group.group.slice(0, 1)}</div>
                <div className="grow">
                  <div className="list__title">{group.group}</div>
                  <div className="list__sub">{group.channels} 个频道 · {group.alive} 条可用线路</div>
                </div>
                <ArrowRight size={16} color="var(--label-3)" />
              </Link>
            ))}
          </div>
        </>
      ) : null}

      {data?.lastRun ? (() => {
        const run = data.lastRun;
        const isEpg = run.task_type === 'epg';
        const isProbe = run.task_type === 'probe-batch' || run.task_type === 'probe-lines' || run.task_type === 'liveness';
        const channelLabel = isEpg ? 'EPG 频道' : isProbe ? '池内频道' : run.task_type === 'publish' ? '发布频道' : '抓取频道';
        const lineLabel = isEpg ? '线路' : isProbe ? '池内线路' : '线路';
        const aliveLabel = isProbe ? '池内可用' : '可用';
        const probedLabel = isProbe ? '本批已测' : '已测';
        const hasProbe = !isEpg && run.probed > 0;
        return (
          <>
            <div className="section-title">
              <h2>最近一次运行</h2>
              <Link to="/admin/runs">全部记录</Link>
            </div>
            <Card>
              <div className="row row--between row--wrap">
                <div className="row row--wrap" style={{ gap: 8 }}>
                  <Badge tone={run.status === 'success' ? 'green' : run.status === 'partial' ? 'orange' : 'red'}>
                    {run.status === 'success' ? '成功' : run.status === 'partial' ? '部分成功' : run.status}
                  </Badge>
                  <span className="last-run-label">{run.task_label ?? '运行记录'}</span>
                  <span className="caption">{timeAgo(run.started_at)}</span>
                </div>
                <span className="caption">耗时 {Math.round((run.duration_ms ?? 0) / 1000)}s</span>
              </div>
              <div className="divider" />
              <div className="last-run-stats">
                <div><div className="title-3">{formatNumber(run.channels)}</div><div className="caption">{channelLabel}</div></div>
                {isEpg ? (
                  <div><div className="title-3">{formatBytes(run.bytes)}</div><div className="caption">文件大小</div></div>
                ) : null}
                {!isEpg && run.lines > 0 ? (
                  <div><div className="title-3">{formatNumber(run.lines)}</div><div className="caption">{lineLabel}</div></div>
                ) : null}
                {hasProbe ? (
                  <>
                    <div><div className="title-3">{formatNumber(run.alive)}</div><div className="caption">{aliveLabel}</div></div>
                    <div><div className="title-3">{formatNumber(run.probed)}</div><div className="caption">{probedLabel}</div></div>
                  </>
                ) : null}
              </div>
              {!isEpg && !hasProbe ? <div className="last-run-note">本次运行只执行抓取 / 发布，没有进行测速。</div> : null}
              {run.task_message ? <div className="last-run-message">{run.task_message}</div> : null}
            </Card>
          </>
        );
      })() : null}

      <Link to="/admin" className="btn btn--primary btn--block">
        进入管理后台 <ArrowRight size={15} />
      </Link>
    </div>
  );
}
