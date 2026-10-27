import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, Gauge, PlayCircle, RefreshCw, Search, Zap } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import type { RunItem } from '../../lib/types';
import { formatDuration, formatLatency, formatResolution, formatSpeed, statusLabel, statusTone, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Segmented, Sheet, Skeleton, Stat, useToast } from '../../components/ui';

interface ProbeLine {
  key: string;
  channelId: string;
  channelName: string;
  group: string;
  sourceId: string;
  status: string;
  resolution: string | null;
  speedKbps: number;
  latencyMs: number;
  protocol: string;
  failCount: number;
  score: number;
  lastProbeAt: string | null;
  url: string;
}

interface LinesResponse {
  ready: boolean;
  summary: {
    generatedAt: string;
    total: number;
    alive: number;
    suspect: number;
    dead: number;
    unknown: number;
    avgSpeedKbps: number;
    resolutions: Record<string, number>;
    protocols: Record<string, number>;
  } | null;
  total: number;
  items: ProbeLine[];
}

export function Probe() {
  const { show } = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'alive' | 'suspect' | 'dead'>('all');
  const [resolution, setResolution] = useState('');
  const [openTester, setOpenTester] = useState(false);
  const [url, setUrl] = useState('');
  const [ua, setUa] = useState('');
  const [referer, setReferer] = useState('');
  const [result, setResult] = useState<{ ok: boolean; status?: number; protocol: string; ttfbMs?: number; speedKbps?: number; resolution?: string; bandwidthKbps?: number; durationSec?: number; loop?: boolean; error?: string } | null>(null);

  const lines = useQuery({
    queryKey: ['admin', 'lines', search, status, resolution],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '300' });
      if (search.trim()) params.set('q', search.trim());
      if (status !== 'all') params.set('status', status);
      if (resolution) params.set('resolution', resolution);
      return api.get<LinesResponse>(`/api/admin/lines?${params.toString()}`);
    },
  });

  const runs = useQuery({
    queryKey: ['admin', 'runs', 8],
    queryFn: () => api.get<{ items: RunItem[] }>('/api/admin/runs?limit=8'),
  });

  const dispatch = useMutation({
    mutationFn: (command: 'collect' | 'export' | 'epg') => api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { command }),
    onSuccess: (res) => show(res.message),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const probe = useMutation({
    mutationFn: () => api.post<{ result: typeof result }>('/api/admin/probe', { url: url.trim(), userAgent: ua.trim() || undefined, referer: referer.trim() || undefined }),
    onSuccess: (res) => setResult(res.result),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const summary = lines.data?.summary;
  const resolutions = useMemo(
    () => Object.entries(summary?.resolutions ?? {}).sort((a, b) => b[1] - a[1]),
    [summary],
  );

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">检测中心</h1>
          <p className="subhead" style={{ marginTop: 4 }}>每条线路的连通性、分辨率、稳态速率与检测时间。</p>
        </div>
        <div className="row row--wrap">
          <Button onClick={() => setOpenTester(true)}><Zap size={15} /> 单条探测</Button>
          <Button variant="primary" loading={dispatch.isPending} onClick={() => dispatch.mutate('collect')}>
            <PlayCircle size={15} /> 全量检测
          </Button>
          <Button loading={dispatch.isPending} onClick={() => dispatch.mutate('export')}>
            <RefreshCw size={15} /> 重建导出
          </Button>
        </div>
      </div>

      <div className="grid">
        <Stat value={summary?.total ?? '—'} label="已检测线路" />
        <Stat value={summary?.alive ?? '—'} label={`可用 · ${summary ? Math.round((summary.alive / Math.max(1, summary.total)) * 100) : 0}%`} />
        <Stat value={summary ? formatSpeed(summary.avgSpeedKbps) : '—'} label="平均速率" />
        <Stat value={summary?.unknown ?? '—'} label="未测 / 待观察" />
      </div>

      {resolutions.length ? (
        <div className="row row--wrap">
          {resolutions.slice(0, 6).map(([label, count]) => (
            <button
              key={label}
              className={clsx('chip', resolution === label && 'chip--active')}
              onClick={() => setResolution(resolution === label ? '' : label)}
            >
              {label} <span style={{ opacity: 0.7 }}>{count}</span>
            </button>
          ))}
          {resolution ? <Button size="sm" variant="ghost" onClick={() => setResolution('')}>清除</Button> : null}
        </div>
      ) : null}

      <div className="row row--wrap" style={{ gap: 8 }}>
        <div className="search grow" style={{ minWidth: 220 }}>
          <Search size={16} className="search__icon" />
          <input className="input" placeholder="搜索频道 / 源 ID / 地址" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部' },
            { value: 'alive', label: '可用' },
            { value: 'suspect', label: '待观察' },
            { value: 'dead', label: '失效' },
          ]}
        />
      </div>

      {lines.isLoading ? <Skeleton height={280} radius={16} /> : null}

      {lines.data?.ready ? (
        <Card flush>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>频道</th>
                  <th>分辨率</th>
                  <th>速率</th>
                  <th>首字节</th>
                  <th>状态</th>
                  <th>检测时间</th>
                  <th>线路</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.data.items.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.channelName}</div>
                      <div className="caption">{row.group} · {row.sourceId}</div>
                    </td>
                    <td><Badge tone={row.resolution ? 'blue' : 'default'}>{formatResolution(row.resolution)}</Badge></td>
                    <td>{formatSpeed(row.speedKbps)}</td>
                    <td className="caption">{formatLatency(row.latencyMs)}</td>
                    <td><Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge></td>
                    <td className="caption">{timeAgo(row.lastProbeAt)}</td>
                    <td className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.url.replace(/^https?:\/\//, '').split('/')[0]}
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(row.url).then(() => show('已复制线路地址'))}>
                        <Copy size={13} />
                      </Button>
                    </td>
                  </tr>
                ))}
                {!lines.data.items.length ? (
                  <tr><td colSpan={8}><div className="caption" style={{ padding: 16 }}>没有符合筛选条件的线路。</div></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card><div className="caption">还没有检测数据，请先运行一次采集。</div></Card>
      )}

      <Card flush>
        <div className="card__header">
          <div className="title-3">最近运行</div>
          <span className="caption"><Gauge size={13} /> Actions 写入</span>
        </div>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="table">
            <thead><tr><th>状态</th><th>触发</th><th>开始</th><th>测速</th><th>可用</th><th>耗时</th></tr></thead>
            <tbody>
              {(runs.data?.items ?? []).map((run) => (
                <tr key={run.id}>
                  <td><Badge tone={run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>{run.status}</Badge></td>
                  <td className="caption">{run.trigger}</td>
                  <td className="caption">{timeAgo(run.started_at)}</td>
                  <td>{run.probed}</td>
                  <td>{run.alive}</td>
                  <td className="caption">{formatDuration(run.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Sheet
        open={openTester}
        onClose={() => setOpenTester(false)}
        title="单条线路探测"
        subtitle="丢弃 512KB 预热后计算稳态速率"
        footer={<Button block variant="primary" loading={probe.isPending} onClick={() => probe.mutate()}>开始探测</Button>}
      >
        <div className="stack">
          <Field label="播放地址"><input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://example.com/live.m3u8" /></Field>
          <Field label="User-Agent（可选）"><input className="input" value={ua} onChange={(event) => setUa(event.target.value)} /></Field>
          <Field label="Referer（可选）"><input className="input" value={referer} onChange={(event) => setReferer(event.target.value)} /></Field>
          {result ? (
            <div className="stack stack--tight">
              <div className="row row--wrap">
                <Badge tone={result.ok ? 'green' : 'red'}>{result.ok ? '可播放' : '失败'}</Badge>
                <Badge>{result.protocol.toUpperCase()}</Badge>
                {result.resolution ? <Badge tone="blue">{result.resolution}</Badge> : null}
                {result.loop ? <Badge tone="orange">循环流</Badge> : null}
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <div><div className="caption">稳态速率</div><div className="title-3">{formatSpeed(result.speedKbps)}</div></div>
                <div><div className="caption">首字节</div><div className="title-3">{result.ttfbMs ?? '—'} ms</div></div>
              </div>
              {result.error ? <div className="caption" style={{ color: 'var(--red)' }}>{result.error}</div> : null}
            </div>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
