import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Play, Radio, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { ChannelDetailResponse } from '../lib/types';
import { formatClock, formatLatency, formatResolution, formatSpeed, statusLabel, statusTone } from '../lib/format';
import { Badge, Button, Card, EmptyState, Segmented, Sheet, Skeleton, useToast } from '../components/ui';
import { ChannelLogo } from '../components/ChannelLogo';
import { Player } from '../components/Player';

function probeAge(value?: string | null): string {
  if (!value) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

interface RelayCheck {
  key: string;
  ok: boolean;
  status: number;
  reason?: string;
  direct: 'https' | 'http' | 'unsupported';
  codecs?: string;
}

export function ChannelDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { show } = useToast();
  const [tab, setTab] = useState<'lines' | 'epg'>('lines');
  const [playing, setPlaying] = useState<ChannelDetailResponse['lines'][number] | null>(null);
  const [shotOk, setShotOk] = useState(true);
  const [linePage, setLinePage] = useState(1);
  const [linePageSize, setLinePageSize] = useState<'10' | '20' | 'all'>('10');

  useEffect(() => {
    setLinePage(1);
  }, [id]);

  const query = useQuery({
    queryKey: ['channel', id],
    queryFn: () => api.get<ChannelDetailResponse>(`/api/public/channels/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });

  const relayCheck = useQuery({
    queryKey: ['relay-check', id],
    queryFn: () => api.get<{ items: RelayCheck[] }>(`/api/public/channels/${encodeURIComponent(id)}/relay-check`),
    enabled: Boolean(id),
    staleTime: 120_000,
  });
  const relayChecks = new Map((relayCheck.data?.items ?? []).map((item) => [item.key, item]));

  const feedback = useMutation({
    mutationFn: (payload: { entryKey?: string; sourceId?: string }) =>
      api.post('/api/public/feedback', { channelId: id, kind: 'dead', ...payload }),
    onSuccess: () => show('已收到反馈，会参与线路信誉计算'),
    onError: (error: Error) => show(error.message, 'error'),
  });

  if (query.isLoading) {
    return (
      <div className="stack" style={{ marginTop: 8 }}>
        <Skeleton height={90} radius={20} />
        <Skeleton height={200} radius={16} />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        icon={<TriangleAlert size={24} />}
        title="频道不存在或数据未生成"
        action={<Button onClick={() => navigate('/channels')}>返回频道列表</Button>}
      />
    );
  }

  const { channel, lines, epg } = query.data;
  const alive = lines.filter((line) => line.status === 'alive');
  const checkRank = (key: string): number => {
    const check = relayChecks.get(key);
    return check ? (check.ok ? 0 : 1) : 2;
  };
  const codecsOf = (line: (typeof lines)[number]): string => (relayChecks.get(line.key)?.codecs ?? line.codecs ?? '').toLowerCase();
  const isHevc = (line: (typeof lines)[number]): boolean => /hvc1|hev1|hvc/.test(codecsOf(line));
  const statusRank = (line: (typeof lines)[number]): number => (line.status === 'alive' ? 0 : line.status === 'suspect' ? 1 : 2);
  const orderedLines = [...lines].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      checkRank(a.key) - checkRank(b.key) ||
      (isHevc(a) ? 1 : 0) - (isHevc(b) ? 1 : 0) ||
      (b.score ?? 0) - (a.score ?? 0),
  );
  const frontLimit = query.data.features?.frontLineLimit ?? 0;
  const paginatedLines = frontLimit > 0 ? orderedLines.slice(0, frontLimit) : orderedLines;
  const pageSize = linePageSize === 'all' ? paginatedLines.length || 1 : Number(linePageSize);
  const pageCount = Math.max(1, Math.ceil(paginatedLines.length / pageSize));
  const currentPage = Math.min(linePage, pageCount);
  const visibleLines = linePageSize === 'all'
    ? paginatedLines
    : paginatedLines.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const checkedLines = lines.filter((line) => relayChecks.has(line.key));
  const relayBlocked = checkedLines.length > 0 && checkedLines.every((line) => !relayChecks.get(line.key)?.ok);
  const directPlayback = query.data.features?.directPlayback ?? false;
  const bestSpeed = Math.max(0, ...alive.map((line) => line.speedKbps ?? 0));

  return (
    <div className="stack" style={{ marginTop: 2 }}>
      <button className="btn btn--sm detail-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={15} /> 返回频道
      </button>

      <Card className="channel-hero">
        <div className="channel-hero__top">
          <ChannelLogo src={channel.logo} name={channel.name} size="lg" tvgId={channel.tvgId} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="channel-hero__eyebrow">{channel.group}{channel.tvgId ? ` · ${channel.tvgId}` : ''}</div>
            <h1 className="channel-hero__title">{channel.name}</h1>
            <div className="row row--wrap" style={{ marginTop: 8, gap: 6 }}>
              <Badge tone={alive.length ? 'green' : 'red'}>{alive.length} / {lines.length} 可用</Badge>
              {/^cctv\d+/i.test(channel.id) ? (
                <a
                  className="btn btn--sm"
                  href={`https://tv.cctv.com/live/${channel.id.replace(/-4k$/, '4k')}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} /> 官方直播
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="channel-hero__stats">
          <div><strong>{alive.length}</strong><span>可用线路</span></div>
          <div><strong>{lines.length}</strong><span>线路总数</span></div>
          <div><strong>{bestSpeed ? formatSpeed(bestSpeed) : '—'}</strong><span>最佳速度</span></div>
          <div><strong>{checkedLines.length ? `${checkedLines.filter((line) => relayChecks.get(line.key)?.ok).length}/${checkedLines.length}` : '—'}</strong><span>中继可用</span></div>
        </div>

        {epg?.now ? (
          <div className="channel-now">
            <span className="dot dot--live" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="caption">正在播出</div>
              <div className="channel-now__title">{epg.now.title}</div>
              <div className="caption">{formatClock(epg.now.start)} – {formatClock(epg.now.stop)}</div>
            </div>
          </div>
        ) : null}

        {shotOk ? (
          <img
            className="shot channel-shot"
            src={`/shots/${encodeURIComponent(channel.id)}.jpg`}
            alt={`${channel.name} 截图`}
            loading="lazy"
            onError={() => setShotOk(false)}
          />
        ) : null}
      </Card>

      <div className="channel-tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'lines', label: `线路 ${lines.length}` },
            { value: 'epg', label: '节目单' },
          ]}
        />
      </div>

      {tab === 'lines' ? (
        lines.length ? (
          <div className="line-list">
            <Card className="line-toolbar">
              {relayBlocked ? (
                <div className="line-warning">
                  <TriangleAlert size={15} />
                  <span>当前 Cloudflare 中继无法访问该频道的任何线路（源站按 IP 限制）。请复制订阅地址，在 VLC/盒子中直连播放。</span>
                </div>
              ) : null}
              <div className="row row--between row--wrap">
                <div>
                  <div className="title-3">线路列表</div>
                  <div className="caption">共 {paginatedLines.length} 条 · 第 {currentPage}/{pageCount} 页 · 状态来自 GitHub Actions 探测节点</div>
                </div>
                <label className="row" style={{ gap: 6 }}>
                  <span className="caption">每页</span>
                  <select
                    className="input"
                    style={{ width: 90 }}
                    value={linePageSize}
                    onChange={(event) => {
                      setLinePageSize(event.target.value as '10' | '20' | 'all');
                      setLinePage(1);
                    }}
                  >
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="all">全部</option>
                  </select>
                </label>
              </div>
            </Card>

            {visibleLines.map((line, index) => {
              const check = relayChecks.get(line.key);
              const order = (currentPage - 1) * (linePageSize === 'all' ? paginatedLines.length : pageSize) + index + 1;
              return (
                <div key={line.key} className={`line-card line-card--${statusTone(line.status)}`}>
                  <div className="line-card__index">#{order}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row row--wrap" style={{ gap: 5 }}>
                      <Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge>
                      {check ? (
                        <Badge tone={check.ok ? 'green' : 'red'}>
                          {check.ok ? '中继可播' : `中继不可用${check.status ? ` ${check.status}` : ''}`}
                        </Badge>
                      ) : null}
                      {directPlayback && check?.direct === 'https' ? <Badge tone="green">直连可用</Badge> : null}
                      {directPlayback && check?.direct === 'http' ? <Badge tone="orange">HTTP 需中继</Badge> : null}
                      {isHevc(line) ? <Badge tone="orange">H.265</Badge> : codecsOf(line).includes('avc') ? <Badge tone="green">H.264</Badge> : null}
                      <Badge>{formatResolution(line.resolution)}</Badge>
                      {line.speedKbps ? <Badge tone="green">{formatSpeed(line.speedKbps)}</Badge> : null}
                      {line.latencyMs ? <span className="caption">{formatLatency(line.latencyMs)}</span> : null}
                      {line.loop ? <Badge tone="orange">循环流</Badge> : null}
                    </div>
                    <div className="line-card__meta">
                      <span>{line.sourceName ?? line.sourceId}</span>
                      {line.sourceSite ? <span>{line.sourceSite}</span> : null}
                      <span>{line.protocol.toUpperCase()}</span>
                      {line.lastProbeAt ? <span>检测于 {probeAge(line.lastProbeAt)}</span> : null}
                    </div>
                    <div className="line-card__actions">
                      <Button
                        size="sm"
                        variant={line.status === 'alive' ? 'primary' : 'default'}
                        onClick={() => setPlaying(line)}
                      >
                        <Play size={13} /> 试播
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={feedback.isPending}
                        onClick={() => feedback.mutate({ entryKey: line.key, sourceId: line.sourceId })}
                      >
                        报错
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}

            {linePageSize !== 'all' ? (
              <div className="line-pager">
                <Button size="sm" variant="glass" disabled={currentPage <= 1} onClick={() => setLinePage((value) => Math.max(1, value - 1))}>
                  上一页
                </Button>
                <label className="row" style={{ gap: 6 }}>
                  <span className="caption">第</span>
                  <select
                    className="input"
                    style={{ width: 76 }}
                    value={currentPage}
                    onChange={(event) => setLinePage(Number(event.target.value))}
                  >
                    {Array.from({ length: pageCount }, (_, index) => (
                      <option key={index + 1} value={index + 1}>{index + 1}</option>
                    ))}
                  </select>
                  <span className="caption">/ {pageCount} 页</span>
                </label>
                <Button size="sm" variant="glass" disabled={currentPage >= pageCount} onClick={() => setLinePage((value) => Math.min(pageCount, value + 1))}>
                  下一页
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState icon={<Radio size={22} />} title="暂无线路" description="该频道刚被识别，等待下一轮采集与测速。" />
        )
      ) : (
        <Card className="epg-panel">
          {epg?.now || epg?.next?.length ? (
            <div className="epg-list">
              {epg.now ? (
                <div className="epg-program epg-program--now">
                  <span className="dot dot--live" />
                  <div className="grow">
                    <div className="epg-program__title">{epg.now.title}</div>
                    <div className="caption">{formatClock(epg.now.start)} – {formatClock(epg.now.stop)} · 正在播出</div>
                  </div>
                </div>
              ) : null}
              {(epg.next ?? []).map((programme) => (
                <div key={`${programme.start}-${programme.title}`} className="epg-program">
                  <span className="dot" />
                  <div className="grow">
                    <div className="epg-program__title">{programme.title}</div>
                    <div className="caption">{formatClock(programme.start)} – {formatClock(programme.stop)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无节目单" description="在设置中配置 XMLTV EPG 地址后，运行一次采集即可生成。" />
          )}
        </Card>
      )}

      <Sheet
        open={Boolean(playing)}
        onClose={() => setPlaying(null)}
        title="在线试播"
        subtitle={channel.name}
        footer={
          <div className="preview-footer">
            <Button variant="ghost" onClick={() => setPlaying(null)}>关闭</Button>
            {playing ? (
              <Button
                variant="danger"
                onClick={() => {
                  feedback.mutate({ entryKey: playing.key, sourceId: playing.sourceId });
                  setPlaying(null);
                }}
              >
                报告失效
              </Button>
            ) : null}
          </div>
        }
      >
        {playing ? (
          <div className="preview-sheet">
            <div className="preview-meta">
              <div className="preview-meta__head">
                <Badge tone={statusTone(playing.status)}>{statusLabel(playing.status)}</Badge>
                <Badge>{formatResolution(playing.resolution)}</Badge>
                {playing.speedKbps ? <Badge tone="green">{formatSpeed(playing.speedKbps)}</Badge> : null}
                <Badge>{playing.protocol.toUpperCase()}</Badge>
              </div>
              <div className="preview-meta__source">
                {playing.sourceName ?? playing.sourceId}
                {playing.sourceSite ? ` · ${playing.sourceSite}` : ''}
                {relayChecks.get(playing.key)?.ok ? ' · 中继可播' : ''}
                {playing.lastProbeAt ? ` · 检测于 ${probeAge(playing.lastProbeAt)}` : ''}
              </div>
            </div>

            <Player
              url={playing.url}
              protocol={playing.protocol}
              lineKey={playing.key}
              codecs={relayChecks.get(playing.key)?.codecs ?? playing.codecs}
              relayAvailable={Boolean(relayChecks.get(playing.key)?.ok)}
              directAvailable={query.data?.features?.directPlayback ?? false}
              directKind={relayChecks.get(playing.key)?.direct}
              autoPlay
            />

            <div className="preview-tip">
              试播依赖浏览器和源站策略，失败不代表线路失效。真实线路地址不会在页面展示，订阅地址在 VLC / 盒子中仍可正常播放。
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
