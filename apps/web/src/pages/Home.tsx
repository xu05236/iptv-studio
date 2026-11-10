import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Clapperboard, CreditCard, Globe, Layers, Layers3, MapPin, Music, Newspaper, RadioTower, RefreshCw, Share2, Trophy, Tv } from 'lucide-react';
import { api } from '../lib/api';
import type { Overview } from '../lib/types';
import { formatBytes, formatDuration, formatNumber, timeAgo } from '../lib/format';
import { Badge, Card, EmptyState, Skeleton } from '../components/ui';

function CategoryIcon({ group }: { group: string }) {
  const map: Array<{ match: string; icon: typeof Tv; tone: string }> = [
    { match: '央视', icon: Tv, tone: 'blue' },
    { match: '卫视', icon: RadioTower, tone: 'teal' },
    { match: '地方', icon: MapPin, tone: 'orange' },
    { match: '港澳台', icon: MapPin, tone: 'purple' },
    { match: '国际', icon: Globe, tone: 'blue' },
    { match: '4K', icon: Tv, tone: 'purple' },
    { match: '影视', icon: Clapperboard, tone: 'pink' },
    { match: '体育', icon: Trophy, tone: 'orange' },
    { match: '少儿', icon: Layers, tone: 'green' },
    { match: '纪录', icon: BookOpen, tone: 'teal' },
    { match: '新闻', icon: Newspaper, tone: 'blue' },
    { match: '音乐', icon: Music, tone: 'pink' },
    { match: '付费', icon: CreditCard, tone: 'orange' },
  ];
  const entry = map.find((item) => group.includes(item.match)) ?? { icon: Layers, tone: 'default' };
  const Icon = entry.icon;
  return <span className={`category-icon category-icon--${entry.tone}`}><Icon size={18} /></span>;
}

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
  const poolAlive = data?.pool?.alive ?? 0;
  const poolTotal = data?.pool?.total ?? 0;
  const poolRatio = poolTotal > 0 ? Math.round((poolAlive / poolTotal) * 100) : 0;

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

      {ready ? (
        <div className="dashboard-stats">
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--blue"><Tv size={16} /></span>
            <div><div className="dash-stat__value">{formatNumber(data?.totals.channels ?? 0)}</div><div className="dash-stat__label">已发布频道</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--green"><RadioTower size={16} /></span>
            <div><div className="dash-stat__value">{formatNumber(data?.totals.alive ?? 0)}</div><div className="dash-stat__label">已发布可用 · {aliveRatio}% / 共 {formatNumber(data?.totals.lines ?? 0)}</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--teal"><Layers3 size={16} /></span>
            <div><div className="dash-stat__value">{formatNumber(poolAlive)}</div><div className="dash-stat__label">线路池可用 · {poolRatio}% / 共 {formatNumber(poolTotal)}</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--orange"><RadioTower size={16} /></span>
            <div><div className="dash-stat__value">{formatNumber(data?.sources?.enabled ?? 0)}</div><div className="dash-stat__label">启用源 / 共 {formatNumber(data?.sources?.total ?? 0)}</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--purple"><Share2 size={16} /></span>
            <div><div className="dash-stat__value">{formatNumber(data?.subscriptions ?? 0)}</div><div className="dash-stat__label">订阅出口</div></div>
          </div>
        </div>
      ) : null}

      {data?.groups?.length ? (
        <Card>
          <div className="card__header" style={{ padding: '2px 2px 12px' }}>
            <div>
              <div className="title-3">按分类浏览</div>
              <div className="caption">{data.groups.length} 个分类</div>
            </div>
            <Link to="/channels" className="caption">全部频道 →</Link>
          </div>
          <div className="grid grid--wide">
            {data.groups.slice(0, 6).map((group) => (
              <Link key={group.group} to={`/channels?group=${encodeURIComponent(group.group)}`} className="category-card">
                <CategoryIcon group={group.group} />
                <div className="grow">
                  <div className="list__title">{group.group}</div>
                  <div className="list__sub">{group.channels} 个频道 · {group.alive} 条可用线路</div>
                </div>
                <ArrowRight size={16} color="var(--label-3)" />
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {data?.runs?.length ? (
        <Card>
          <div className="card__header" style={{ padding: '2px 2px 12px' }}>
            <div>
              <div className="title-3">最近运行</div>
              <div className="caption">最近 {data.runs.length} 次运行记录</div>
            </div>
            <Link to="/admin/runs" className="caption">全部记录 →</Link>
          </div>
          <div className="run-list">
              {data.runs.map((run) => {
                const tone = run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange';
                const statusText = run.status === 'success' ? '成功' : run.status === 'partial' ? '部分' : run.status === 'running' ? '运行中' : '失败';
                return (
                  <div className={`run-row run-row--${tone}`} key={run.id}>
                    <div className="run-row__status"><Badge tone={tone}>{statusText}</Badge></div>
                    <div className="grow">
                      <div className="run-row__title">{run.task_label ?? '运行记录'}</div>
                      {(run.task_message ?? run.message) ? <div className="caption run-row__message">{run.task_message ?? run.message}</div> : null}
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
          </div>
        </Card>
      ) : null}

      <Link to="/admin" className="btn btn--primary btn--block">
        进入管理后台 <ArrowRight size={15} />
      </Link>
    </div>
  );
}
