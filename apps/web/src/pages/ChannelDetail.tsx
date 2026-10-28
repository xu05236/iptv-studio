import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Play, Radio, TriangleAlert } from 'lucide-react';
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
}

export function ChannelDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { show } = useToast();
  const [tab, setTab] = useState<'lines' | 'epg'>('lines');
  const [playing, setPlaying] = useState<ChannelDetailResponse['lines'][number] | null>(null);
  const [shotOk, setShotOk] = useState(true);

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
  const orderedLines = [...lines].sort((a, b) => checkRank(a.key) - checkRank(b.key));
  const checkedLines = lines.filter((line) => relayChecks.has(line.key));
  const relayBlocked = checkedLines.length > 0 && checkedLines.every((line) => !relayChecks.get(line.key)?.ok);

  return (
    <div className="stack" style={{ marginTop: 2 }}>
      <button className="btn btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigate(-1)}>
        <ArrowLeft size={15} /> 返回
      </button>

      <Card>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <ChannelLogo src={channel.logo} name={channel.name} size="lg" />
          <div className="grow">
            <h1 className="title-2">{channel.name}</h1>
            <div className="row row--wrap" style={{ marginTop: 6, gap: 6 }}>
              <Badge>{channel.group}</Badge>
              {channel.tvgId ? <Badge tone="blue">{channel.tvgId}</Badge> : null}
              <Badge tone={alive.length ? 'green' : 'red'}>{alive.length} / {lines.length} 可用</Badge>
            </div>
          </div>
        </div>

        {epg?.now ? (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 12, background: 'var(--fill-2)' }}>
            <div className="caption">正在播出</div>
            <div className="title-3" style={{ marginTop: 2 }}>{epg.now.title}</div>
            <div className="caption">{formatClock(epg.now.start)} – {formatClock(epg.now.stop)}</div>
          </div>
        ) : null}

        {shotOk ? (
          <img
            className="shot"
            src={`/shots/${encodeURIComponent(channel.id)}.jpg`}
            alt={`${channel.name} 截图`}
            loading="lazy"
            onError={() => setShotOk(false)}
          />
        ) : null}
      </Card>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'lines', label: `线路 ${lines.length}` },
          { value: 'epg', label: '节目单' },
        ]}
      />

      {tab === 'lines' ? (
        lines.length ? (
          <div className="list">
            {relayBlocked ? (
              <p className="caption" style={{ padding: '0 4px 8px', color: 'var(--red, #e5484d)' }}>
                当前 Cloudflare 中继无法访问该频道的任何线路（源站按 IP 限制）。请复制订阅地址，在 VLC/盒子中直连播放。
              </p>
            ) : null}
            <p className="caption" style={{ padding: '0 4px 8px' }}>
              状态来自 GitHub Actions 探测节点；中继标签是 Cloudflare 实测。源站限制出口 IP 时会显示「中继不可用」。
            </p>
            {orderedLines.map((line, index) => (
              <div key={line.key} className="list__row" style={{ alignItems: 'flex-start' }}>
                <div className="logo logo--fallback" style={{ fontSize: 12 }}>#{index + 1}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge>
                    {relayChecks.has(line.key) ? (
                      <Badge tone={relayChecks.get(line.key)?.ok ? 'green' : 'red'}>
                        {relayChecks.get(line.key)?.ok ? '中继可播' : `中继不可用${relayChecks.get(line.key)?.status ? ` ${relayChecks.get(line.key)?.status}` : ''}`}
                      </Badge>
                    ) : null}
                    <Badge>{formatResolution(line.resolution)}</Badge>
                    {line.speedKbps ? <Badge tone="green">{formatSpeed(line.speedKbps)}</Badge> : null}
                    {line.latencyMs ? <span className="caption">{formatLatency(line.latencyMs)}</span> : null}
                    {line.loop ? <Badge tone="orange">循环流</Badge> : null}
                  </div>
                  <div className="list__sub truncate" style={{ marginTop: 4 }}>
                    {line.sourceName ?? line.sourceId}
                    {line.sourceSite ? ` · ${line.sourceSite}` : ''}
                    {' · '}{line.protocol.toUpperCase()}
                    {line.lastProbeAt ? ` · 检测于 ${probeAge(line.lastProbeAt)}` : ''}
                  </div>
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    <Button
                      size="sm"
                      variant={line.status === 'alive' ? 'primary' : 'default'}
                      onClick={() => setPlaying(line)}
                    >
                      <Play size={13} /> 试播
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={feedback.isPending}
                      onClick={() => feedback.mutate({ entryKey: line.key, sourceId: line.sourceId })}
                    >
                      报错
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Radio size={22} />} title="暂无线路" description="该频道刚被识别，等待下一轮采集与测速。" />
        )
      ) : (
        <Card>
          {epg?.now || epg?.next?.length ? (
            <div className="stack stack--tight">
              {epg.now ? (
                <div className="list__row" style={{ padding: 0, background: 'transparent' }}>
                  <span className="dot dot--live" />
                  <div className="grow">
                    <div className="list__title">{epg.now.title}</div>
                    <div className="list__sub">{formatClock(epg.now.start)} – {formatClock(epg.now.stop)} · 正在播出</div>
                  </div>
                </div>
              ) : null}
              {(epg.next ?? []).map((programme) => (
                <div key={`${programme.start}-${programme.title}`} className="list__row" style={{ padding: 0, background: 'transparent' }}>
                  <span className="dot" />
                  <div className="grow">
                    <div className="list__title">{programme.title}</div>
                    <div className="list__sub">{formatClock(programme.start)} – {formatClock(programme.stop)}</div>
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
        title={channel.name}
        subtitle="在线试播仅供调试，页面不展示真实线路地址"
        footer={
          playing ? (
            <Button
              className="grow"
              variant="danger"
              onClick={() => {
                feedback.mutate({ entryKey: playing.key, sourceId: playing.sourceId });
                setPlaying(null);
              }}
            >
              报告失效
            </Button>
          ) : null
        }
      >
        {playing ? (
          <div className="stack">
            <Player
              url={playing.url}
              protocol={playing.protocol}
              lineKey={playing.key}
              relayAvailable={query.data?.features?.relay ?? false}
              directAvailable={query.data?.features?.directPlayback ?? false}
              autoPlay
            />
            <div className="row row--wrap">
              <Badge tone={statusTone(playing.status)}>{statusLabel(playing.status)}</Badge>
              <Badge>{formatResolution(playing.resolution)}</Badge>
              <Badge tone="blue">{formatSpeed(playing.speedKbps)}</Badge>
              <span className="caption">{playing.protocol.toUpperCase()}</span>
            </div>
            <p className="caption">试播依赖浏览器与源站策略；失败不代表线路失效，订阅地址在播放器中仍可正常使用。</p>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
