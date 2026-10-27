import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Gauge, PlayCircle, RefreshCw, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import type { ProbeResponse, RunItem } from '../../lib/types';
import { formatDuration, formatSpeed, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Skeleton, useToast } from '../../components/ui';

export function Probe() {
  const { show } = useToast();
  const [url, setUrl] = useState('');
  const [ua, setUa] = useState('');
  const [referer, setReferer] = useState('');
  const [result, setResult] = useState<ProbeResponse['result'] | null>(null);

  const runs = useQuery({
    queryKey: ['admin', 'runs', 12],
    queryFn: () => api.get<{ items: RunItem[] }>('/api/admin/runs?limit=12'),
  });

  const dispatch = useMutation({
    mutationFn: (command: 'collect' | 'export') => api.post<{ ok: boolean; message: string }>('/api/admin/runs/dispatch', { command }),
    onSuccess: (res) => show(res.message),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const probe = useMutation({
    mutationFn: () => api.post<ProbeResponse>('/api/admin/probe', { url: url.trim(), userAgent: ua.trim() || undefined, referer: referer.trim() || undefined }),
    onSuccess: (res) => setResult(res.result),
    onError: (error: Error) => show(error.message, 'error'),
  });

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">检测中心</h1>
          <p className="subhead" style={{ marginTop: 4 }}>全量测速由 GitHub Actions 执行；这里用于单条调试与任务触发。</p>
        </div>
        <div className="row">
          <Button loading={dispatch.isPending} variant="primary" onClick={() => dispatch.mutate('collect')}>
            <PlayCircle size={15} /> 全量采集 + 测速
          </Button>
          <Button loading={dispatch.isPending} onClick={() => dispatch.mutate('export')}>
            <RefreshCw size={15} /> 仅重新导出
          </Button>
        </div>
      </div>

      <Card>
        <div className="title-3">单条线路探测</div>
        <p className="caption" style={{ marginTop: 4 }}>丢弃前 512KB 预热后计算稳态速率；HLS 会解析 master 并实际拉取首个分片。</p>
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="播放地址"><input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://example.com/live.m3u8" /></Field>
          <div className="row">
            <div className="grow"><Field label="User-Agent（可选）"><input className="input" value={ua} onChange={(event) => setUa(event.target.value)} /></Field></div>
            <div className="grow"><Field label="Referer（可选）"><input className="input" value={referer} onChange={(event) => setReferer(event.target.value)} /></Field></div>
          </div>
          <Button variant="primary" loading={probe.isPending} onClick={() => probe.mutate()}>
            <Zap size={15} /> 开始探测
          </Button>
        </div>

        {result ? (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="row row--wrap">
              <Badge tone={result.ok ? 'green' : 'red'}>{result.ok ? '可播放' : '失败'}</Badge>
              <Badge>{result.protocol.toUpperCase()}</Badge>
              {result.resolution ? <Badge tone="blue">{result.resolution}</Badge> : null}
              {result.bandwidthKbps ? <Badge>{result.bandwidthKbps} kbps 码率</Badge> : null}
              {result.loop ? <Badge tone="orange">循环流</Badge> : null}
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              <div><div className="caption">稳态速率</div><div className="title-3">{formatSpeed(result.speedKbps)}</div></div>
              <div><div className="caption">首字节</div><div className="title-3">{result.ttfbMs ?? '—'} ms</div></div>
              <div><div className="caption">状态码</div><div className="title-3">{result.status ?? '—'}</div></div>
              <div><div className="caption">分片时长</div><div className="title-3">{result.durationSec ? `${result.durationSec}s` : '—'}</div></div>
            </div>
            {result.error ? <div className="caption" style={{ color: 'var(--red)' }}>{result.error}</div> : null}
          </div>
        ) : null}
      </Card>

      <Card flush>
        <div className="card__header">
          <div className="title-3">最近运行</div>
          <span className="caption"><Gauge size={13} /> 由 Actions 写入</span>
        </div>
        {runs.isLoading ? <div style={{ padding: 16 }}><Skeleton height={60} /></div> : null}
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

      <p className="caption" style={{ padding: '0 4px' }}>
        提示：浏览器无法模拟电信/联通出口，地区适用性由源标注与人工标签维护；全量测速在 Actions 运行，出口为海外。
      </p>
    </div>
  );
}
