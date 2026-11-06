import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, RefreshCw, Trash2, Zap } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { errorKindLabel } from '../../lib/fetchErrors';
import type { SourceItem } from '../../lib/types';
import { Badge, Button, Card, EmptyState, Skeleton, Stat, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';

interface HealthPoint {
  day: string;
  fetched: boolean;
  parsed: number;
  alive: number;
  dead: number;
  avgSpeedKbps: number;
  avgLatencyMs: number;
  reputation: number;
}

interface SourceDetailResponse {
  source: SourceItem;
  stats: { total: number; alive: number; pending: number; quarantine: number; rejected: number; tested: number; dueQuarantine: number; duePending: number };
  lastProbeAt: string | null;
  oldestAliveProbeAt: string | null;
  health: { days: number; points: HealthPoint[] };
  report: { added: number; reused: number; retained: number; disappeared: number; skippedRejected: number } | null;
  reportGeneratedAt: string | null;
}

const formatNumber = (value: number): string => value.toLocaleString('zh-CN');

function hostOf(source: SourceItem): string {
  if (!source.url) return source.origin === 'upload' ? '本地上传' : '手动粘贴';
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.url;
  }
}

function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return null;
  const width = 220;
  const height = 46;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => `${Math.round(index * step)},${Math.round(height - 4 - (value / max) * (height - 8))}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近 7 天解析条数">
      <polyline points={coords} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function SourceDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'source', id],
    queryFn: () => api.get<SourceDetailResponse>(`/api/admin/sources/${encodeURIComponent(id)}/detail`),
    enabled: Boolean(id),
  });

  const probe = useMutation({
    mutationFn: () => api.post<{ tested?: number; alive?: number }>(`/api/admin/sources/${encodeURIComponent(id)}/probe`),
    onSuccess: (result) => {
      show(`已触发探测 · ${result.tested ?? 0} 条，可用 ${result.alive ?? 0} 条`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'source', id] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({
    mutationFn: () => api.post(`/api/admin/sources/${encodeURIComponent(id)}/toggle`),
    onSuccess: () => {
      show('已切换启用状态');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'source', id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/admin/sources/${encodeURIComponent(id)}`),
    onSuccess: () => {
      show('已删除');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
      navigate('/admin/sources');
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  if (isLoading) return <Skeleton height={320} radius={16} />;
  if (error || !data) {
    return <EmptyState title="源不存在或已删除" description="返回采集站列表查看其它源。" action={<Link to="/admin/sources"><Button>返回采集站</Button></Link>} />;
  }

  const { source, stats, health, report } = data;
  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="SOURCE"
        title={source.name}
        description={`${hostOf(source)} · ${source.kind} · 权重 ${source.weight} · 抓取 ${source.fetchMode === 'worker' ? 'Worker 代拉' : '直连'}`}
        actions={
          <>
            <Link to="/admin/sources"><Button size="sm"><ArrowLeft size={14} /> 返回</Button></Link>
            {source.url ? <a href={source.url} target="_blank" rel="noreferrer"><Button size="sm"><ExternalLink size={14} /> 打开源</Button></a> : null}
            <Button size="sm" loading={probe.isPending} onClick={() => probe.mutate()}><Zap size={14} /> 立即探测</Button>
            <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate()}>
              {source.enabled ? '停用' : '启用'}
            </Button>
            <Button
              size="sm"
              loading={remove.isPending}
              onClick={() => {
                if (confirm(`删除「${source.name}」？该源的线路会一起移除。`)) remove.mutate();
              }}
            >
              <Trash2 size={14} /> 删除
            </Button>
          </>
        }
      />

      <div className="row row--wrap" style={{ gap: 8 }}>
        <Badge tone={source.enabled ? 'green' : 'default'}>{source.enabled ? '启用中' : '已停用'}</Badge>
        {source.status === 'paused' ? <Badge tone="orange">已暂停</Badge> : null}
        {source.last_error ? <Badge tone="red">上次抓取失败</Badge> : null}
        {data.reportGeneratedAt ? <Badge tone="blue">对比于 {timeAgo(data.reportGeneratedAt)}</Badge> : null}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        <Card><Stat value={formatNumber(stats.total)} label="线路总数" /></Card>
        <Card><Stat value={formatNumber(stats.alive)} label="可用" /></Card>
        <Card><Stat value={formatNumber(stats.pending)} label="待测" /></Card>
        <Card><Stat value={formatNumber(stats.quarantine)} label="待复测" /></Card>
        <Card><Stat value={formatNumber(stats.rejected)} label="已淘汰" /></Card>
        <Card><Stat value={formatNumber(stats.tested)} label="已测过" /></Card>
      </div>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">探测状态</div>
            <div className="caption">这里显示的是线路池里的实时状态，不是订阅导出结果</div>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <div><div className="caption">最近一次探测</div><div className="title-3">{data.lastProbeAt ? timeAgo(data.lastProbeAt) : '还没探测过'}</div></div>
          <div><div className="caption">最老可用线路</div><div className="title-3">{data.oldestAliveProbeAt ? timeAgo(data.oldestAliveProbeAt) : '无可用线路'}</div></div>
          <div><div className="caption">到期待复测</div><div className="title-3">{formatNumber(stats.dueQuarantine)} 条</div></div>
          <div><div className="caption">从未探测</div><div className="title-3">{formatNumber(stats.duePending)} 条</div></div>
          <div><div className="caption">最近成功</div><div className="title-3">{source.last_ok_at ? timeAgo(source.last_ok_at) : '还没有成功过'}</div></div>
          <div><div className="caption">连续失败</div><div className="title-3">{source.consecutive_failures ?? 0} 次</div></div>
        </div>
        {source.last_error ? (
          <div className="caption" style={{ marginTop: 8, color: 'var(--red)' }}>
            最近错误：{source.last_error}
            {source.lastErrorKind ? ` · ${errorKindLabel(source.lastErrorKind)}` : ''}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">上次抓取对比</div>
            <div className="caption">新增/复用/跳过已淘汰/消失，来自最近一次重抓</div>
          </div>
          <RefreshCw size={15} />
        </div>
        {report ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
            <div><div className="caption">新增</div><div className="title-3">+{formatNumber(report.added)}</div></div>
            <div><div className="caption">复用</div><div className="title-3">{formatNumber(report.reused)}</div></div>
            <div><div className="caption">保留</div><div className="title-3">{formatNumber(report.retained)}</div></div>
            <div><div className="caption">跳过已淘汰</div><div className="title-3">{formatNumber(report.skippedRejected)}</div></div>
            <div><div className="caption">消失</div><div className="title-3">{formatNumber(report.disappeared)}</div></div>
          </div>
        ) : <div className="task-empty">还没有抓取对比记录，源重抓后会出现在这里。</div>}
      </Card>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">最近 {health.days} 天</div>
            <div className="caption">抓取次数、解析条目、探测可用率</div>
          </div>
          <Sparkline values={health.points.map((point) => point.parsed)} />
        </div>
        {health.points.length ? (
          <div className="run-list">
            {health.points.map((point) => (
              <div className="run-row" key={point.day}>
                <div className="run-row__status"><Badge tone={point.fetched ? 'green' : 'default'}>{point.fetched ? '已抓取' : '未抓取'}</Badge></div>
                <div className="grow"><div className="run-row__title">{point.day}</div></div>
                <div className="run-row__metrics">
                  <span><strong>{formatNumber(point.parsed)}</strong> 解析</span>
                  <span><strong>{formatNumber(point.alive)}</strong> 可用</span>
                  <span><strong>{formatNumber(point.dead)}</strong> 淘汰</span>
                  <span><strong>{point.avgSpeedKbps ? `${formatNumber(Math.round(point.avgSpeedKbps))}K` : '—'}</strong> 均速</span>
                </div>
              </div>
            ))}
          </div>
        ) : <div className="task-empty">最近 {health.days} 天还没有统计。</div>}
      </Card>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">最近解析</div>
            <div className="caption">本轮抓取实际解析出的条目、大小与诊断</div>
          </div>
          {source.parseDrop ? <Badge tone="red">条数骤降</Badge> : source.parseReport ? <Badge tone="green">{source.parseReport.detectedKind}</Badge> : null}
        </div>
        {source.parseReport ? (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
              <div><div className="caption">条目</div><div className="title-3">{formatNumber(source.parseReport.entries)}</div></div>
              <div><div className="caption">大小</div><div className="title-3">{Math.max(1, Math.round(source.parseReport.bytes / 1024))} KB</div></div>
              <div><div className="caption">编码</div><div className="title-3">{(source.parseReport.encoding ?? 'utf-8').toUpperCase()}</div></div>
              <div><div className="caption">抓取地址</div><div className="title-3">{source.parseReport.mirrorIndex > 0 ? `备用 #${source.parseReport.mirrorIndex}` : '主地址'}</div></div>
              <div><div className="caption">时间</div><div className="title-3">{timeAgo(source.parseReport.fetchedAt)}</div></div>
            </div>
            {source.parseReport.dropPercent ? (
              <div className="caption" style={{ marginTop: 8, color: 'var(--red)' }}>比上轮少 {source.parseReport.dropPercent}%</div>
            ) : null}
            {source.parseReport.warnings?.length ? (
              <div style={{ marginTop: 8 }}>
                {source.parseReport.warnings.slice(0, 3).map((warning) => <div className="caption" key={warning}>· {warning}</div>)}
              </div>
            ) : null}
          </>
        ) : <div className="task-empty">本轮还没抓取，下一轮采集后出现在这里。</div>}
      </Card>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">请求设置</div>
            <div className="caption">抓取这个源时使用的请求头与抓取方式</div>
          </div>
        </div>
        <div className="stack stack--tight">
          <div className="caption">抓取方式：{source.fetchMode === 'worker' ? 'Worker 代拉' : '直连'}</div>
          <div className="caption">更新档位：{source.refresh_hours != null && source.refresh_hours > 0 ? (source.refresh_hours % 24 === 0 ? `每 ${source.refresh_hours / 24} 天` : `自定义 ${source.refresh_hours} 小时`) : source.refresh_hours === 0 ? '不自动重抓' : '跟随分档（12 / 24 / 72 小时）'}</div>
          <pre className="code">{JSON.stringify(source.requestHeaders ?? {}, null, 2)}</pre>
        </div>
      </Card>
    </div>
  );
}
