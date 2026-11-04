import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, Copy, Gauge, PlayCircle, RefreshCw, Search, Zap } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import type { RunItem } from '../../lib/types';
import { formatDuration, formatLatency, formatResolution, formatSpeed, statusLabel, statusTone, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Pagination, Segmented, Sheet, Skeleton, Stat, useToast } from '../../components/ui';
import { ReputationBadge } from '../../components/ReputationBadge';

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
  error?: string;
  sourceName?: string;
  sourceSite?: string;
  sourceReputation?: number;
  sourceTier?: 'high' | 'normal' | 'low';
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

interface LivenessItem {
  key: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  inconclusive: boolean;
}

/** Worker allows ~50 subrequests per call, so batch the preview client-side. */
const LIVENESS_BATCH = 30;
const LIVENESS_CONCURRENCY = 4;

export function Probe() {
  const { show } = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'alive' | 'suspect' | 'dead'>('all');
  const [sourceId, setSourceId] = useState('');
  const [resolution, setResolution] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(10);
  const [openTester, setOpenTester] = useState(false);
  const [livenessOpen, setLivenessOpen] = useState(false);
  const [livenessResults, setLivenessResults] = useState<LivenessItem[]>([]);
  const [livenessProgress, setLivenessProgress] = useState<{ done: number; total: number } | null>(null);
  const [passedSelected, setPassedSelected] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState('');
  const [ua, setUa] = useState('');
  const [referer, setReferer] = useState('');
  const [result, setResult] = useState<{ ok: boolean; status?: number; protocol: string; ttfbMs?: number; speedKbps?: number; resolution?: string; bandwidthKbps?: number; durationSec?: number; loop?: boolean; error?: string } | null>(null);

  const lines = useQuery({
    queryKey: ['admin', 'lines', search, status, resolution, sourceId, page, pageSize],
    queryFn: () => {
      const limit = pageSize === 'all' ? 5000 : pageSize;
      const params = new URLSearchParams({ limit: String(limit), offset: String((page - 1) * limit) });
      if (search.trim()) params.set('q', search.trim());
      if (status !== 'all') params.set('status', status);
      if (sourceId) params.set('sourceId', sourceId);
      if (resolution) params.set('resolution', resolution);
      return api.get<LinesResponse>(`/api/admin/lines?${params.toString()}`);
    },
  });

  const sources = useQuery({
    queryKey: ['admin', 'sources', 'probe-filter'],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/admin/sources'),
  });

  const visibleItems = lines.data?.items ?? [];
  const totalItems = lines.data?.total ?? 0;
  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = visibleItems;
  const livenessTargets = pagedItems;

  useEffect(() => {
    setPage(1);
  }, [search, status, sourceId, resolution, pageSize]);

  const runs = useQuery({
    queryKey: ['admin', 'runs', 8],
    queryFn: () => api.get<{ items: RunItem[] }>('/api/admin/runs?limit=8'),
  });

  const dispatch = useMutation({
    mutationFn: (input: { command: 'collect' | 'export' | 'epg' | 'probe-lines'; force?: boolean; sourceId?: string; lineKeys?: string[] }) =>
      api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { ...input, source: 'detection' }),
    onSuccess: (res) => show(res.message),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const quickLiveness = useMutation({
    mutationFn: async (keys: string[]) => {
      const chunks: string[][] = [];
      for (let offset = 0; offset < keys.length; offset += LIVENESS_BATCH) {
        chunks.push(keys.slice(offset, offset + LIVENESS_BATCH));
      }
      const results: LivenessItem[] = [];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = cursor++;
          if (index >= chunks.length) return;
          const response = await api.post<{ results: LivenessItem[] }>('/api/admin/lines/liveness', { keys: chunks[index] });
          results.push(...response.results);
          setLivenessProgress({ done: results.length, total: keys.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIVENESS_CONCURRENCY, chunks.length) }, worker));
      return { results };
    },
    onSuccess: (res) => {
      setLivenessResults(res.results);
      setPassedSelected(new Set(res.results.filter((item) => item.ok && !item.inconclusive).map((item) => item.key)));
      setLivenessOpen(true);
    },
    onSettled: () => setLivenessProgress(null),
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
      <AdminPageHeader
        eyebrow="PROBE CENTER"
        title="检测中心"
        description="每条线路的连通性、分辨率、稳态速率与检测时间。"
        actions={
          <>
            <Button onClick={() => setOpenTester(true)}><Zap size={15} /> 单条探测</Button>
            <Button loading={quickLiveness.isPending} disabled={!livenessTargets.length} title={`每批 ${LIVENESS_BATCH} 条，自动分批，不限总数`} onClick={() => quickLiveness.mutate(livenessTargets.map((row) => row.key))}>
              <Activity size={15} />{' '}
              {quickLiveness.isPending && livenessProgress ? `测活中 ${livenessProgress.done}/${livenessProgress.total}` : `快速测活（${livenessTargets.length} 条）`}
            </Button>
            <Button variant="primary" loading={dispatch.isPending} onClick={() => dispatch.mutate({ command: 'collect' })}><PlayCircle size={15} /> 全量检测</Button>
            <Button loading={dispatch.isPending} onClick={() => { if (confirm('强制重测预算内所有线路（忽略到期时间），耗时较长，确定继续？')) dispatch.mutate({ command: 'collect', force: true }); }}>强制全量</Button>
            <Button loading={dispatch.isPending} onClick={() => dispatch.mutate({ command: 'export' })}><RefreshCw size={15} /> 重建导出</Button>
          </>
        }
      />

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

      <details open className="filter-details">
        <summary className="filter-summary">筛选条件</summary>
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
        <select className="input" style={{ maxWidth: 220 }} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">全部采集站</option>
          {(sources.data?.items ?? []).map((source) => (
            <option key={source.id} value={source.id}>{source.name}</option>
          ))}
        </select>
        {sourceId ? (
          <Button
            loading={dispatch.isPending}
            onClick={() => dispatch.mutate({ command: 'collect', force: true, sourceId })}
          >
            检测此源
          </Button>
        ) : null}
      </div>
      </details>

      <div className="row row--between row--wrap">
        <span className="caption">共 {totalItems} 条检测结果</span>
        <label className="row" style={{ gap: 6 }}>
          <span className="caption">每页</span>
          <select className="input" style={{ width: 88 }} value={pageSize} onChange={(event) => setPageSize(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value="all">全部</option>
          </select>
        </label>
      </div>

      {lines.isLoading ? <Skeleton height={280} radius={16} /> : null}

      {lines.data?.ready ? (
        <Card flush>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table table--cards">
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
                {pagedItems.map((row) => (
                  <tr key={row.key}>
                    <td data-label="频道">
                      <div style={{ fontWeight: 600 }}>{row.channelName}</div>
                      <div className="caption" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{row.group} · {row.sourceName ?? row.sourceId}{row.sourceSite ? ` · ${row.sourceSite}` : ''}</span>
                        {row.sourceReputation !== undefined ? (
                          <ReputationBadge score={row.sourceReputation} />
                        ) : null}
                      </div>
                    </td>
                    <td data-label="分辨率"><Badge tone={row.resolution ? 'blue' : 'default'}>{formatResolution(row.resolution)}</Badge></td>
                    <td data-label="速率">{formatSpeed(row.speedKbps)}</td>
                    <td data-label="首字节" className="caption">{formatLatency(row.latencyMs)}</td>
                    <td data-label="状态">
                      <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                      {row.status !== 'alive' && row.error ? <div className="caption" style={{ color: 'var(--red)', maxWidth: 170 }}>{row.error}</div> : null}
                    </td>
                    <td data-label="检测时间" className="caption">{timeAgo(row.lastProbeAt)}</td>
                    <td data-label="线路" className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.url.replace(/^https?:\/\//, '').split('/')[0]}
                    </td>
                    <td data-label="">
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
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
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
          <table className="table table--cards">
            <thead><tr><th>状态</th><th>触发</th><th>开始</th><th>测速</th><th>可用</th><th>耗时</th></tr></thead>
            <tbody>
              {(runs.data?.items ?? []).map((run) => (
                <tr key={run.id}>
                  <td data-label="状态"><Badge tone={run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>{run.status}</Badge></td>
                  <td data-label="触发" className="caption">{run.trigger}</td>
                  <td data-label="开始" className="caption">{timeAgo(run.started_at)}</td>
                  <td data-label="测速">{run.probed}</td>
                  <td data-label="可用">{run.alive}</td>
                  <td data-label="耗时" className="caption">{formatDuration(run.duration_ms)}</td>
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

      <Sheet
        open={livenessOpen}
        onClose={() => setLivenessOpen(false)}
        title="快速测活结果"
        subtitle={`${livenessResults.length} 条 · 通过 ${livenessResults.filter((item) => item.ok && !item.inconclusive).length} 条`}
        footer={
          <Button
            block
            variant="primary"
            disabled={!passedSelected.size}
            loading={dispatch.isPending}
            onClick={() => {
              dispatch.mutate({ command: 'probe-lines', lineKeys: [...passedSelected] });
              setLivenessOpen(false);
            }}
          >
            对选中 {passedSelected.size} 条做全量检测
          </Button>
        }
      >
        <div className="stack">
          <div className="caption">勾选要进入全量测速的线路；失败或无法测活的不默认勾选。</div>
          {livenessResults.map((item) => {
            const row = pagedItems.find((entry) => entry.key === item.key);
            if (item.inconclusive) {
              return (
                <div key={item.key} className="list__row" style={{ alignItems: 'center', gap: 8 }}>
                  <div className="grow">
                    <div>{row?.channelName ?? item.key}</div>
                    <div className="caption">{item.error ?? '无法在 HTTP 环境测活'}</div>
                  </div>
                  <Badge tone="orange">跳过</Badge>
                </div>
              );
            }
            if (item.ok) {
              return (
                <label key={item.key} className="list__row" style={{ alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={passedSelected.has(item.key)}
                    onChange={(event) => {
                      const next = new Set(passedSelected);
                      if (event.target.checked) next.add(item.key);
                      else next.delete(item.key);
                      setPassedSelected(next);
                    }}
                  />
                  <div className="grow">
                    <div>{row?.channelName ?? item.key}</div>
                    <div className="caption">{row?.sourceName ?? row?.sourceId} · {item.latencyMs} ms</div>
                  </div>
                  <Badge tone="green">通过</Badge>
                </label>
              );
            }
            return (
              <div key={item.key} className="list__row" style={{ alignItems: 'center', gap: 8 }}>
                <div className="grow">
                  <div>{row?.channelName ?? item.key}</div>
                  <div className="caption" style={{ color: 'var(--red)' }}>{item.error ?? '失败'}</div>
                </div>
                <Badge tone="red">失败</Badge>
              </div>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
