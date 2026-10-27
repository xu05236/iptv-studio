import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCopy, Play, Radio, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { ChannelDetailResponse } from '../lib/types';
import { formatClock, formatLatency, formatResolution, formatSpeed, statusLabel, statusTone } from '../lib/format';
import { Badge, Button, Card, CopyField, EmptyState, Segmented, Sheet, Skeleton, useToast } from '../components/ui';
import { ChannelLogo } from '../components/ChannelLogo';
import { Player } from '../components/Player';

export function ChannelDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { show } = useToast();
  const [tab, setTab] = useState<'lines' | 'epg'>('lines');
  const [playing, setPlaying] = useState<string | null>(null);
  const [shotOk, setShotOk] = useState(true);

  const query = useQuery({
    queryKey: ['channel', id],
    queryFn: () => api.get<ChannelDetailResponse>(`/api/public/channels/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });

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
            {lines.map((line, index) => (
              <div key={line.key} className="list__row" style={{ alignItems: 'flex-start' }}>
                <div className="logo logo--fallback" style={{ fontSize: 12 }}>#{index + 1}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge>
                    <Badge>{formatResolution(line.resolution)}</Badge>
                    {line.speedKbps ? <Badge tone="green">{formatSpeed(line.speedKbps)}</Badge> : null}
                    {line.latencyMs ? <span className="caption">{formatLatency(line.latencyMs)}</span> : null}
                    {line.loop ? <Badge tone="orange">循环流</Badge> : null}
                  </div>
                  <div className="list__sub truncate" style={{ marginTop: 4 }}>
                    {line.region || line.operator ? `${line.region ?? ''}${line.operator ?? ''} · ` : ''}
                    {line.protocol.toUpperCase()} · 来源 {line.sourceId}
                  </div>
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    <Button
                      size="sm"
                      variant={line.status === 'alive' ? 'primary' : 'default'}
                      onClick={() => setPlaying(line.url)}
                    >
                      <Play size={13} /> 试播
                    </Button>
                    <Button size="sm" onClick={() => navigator.clipboard.writeText(line.url)}>
                      <ClipboardCopy size={13} /> 复制
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
        subtitle="在线试播仅供调试"
        footer={
          playing ? (
            <>
              <Button className="grow" onClick={() => navigator.clipboard.writeText(playing)}>
                复制地址
              </Button>
              <Button
                className="grow"
                variant="danger"
                onClick={() => {
                  feedback.mutate({ entryKey: playing });
                  setPlaying(null);
                }}
              >
                报告失效
              </Button>
            </>
          ) : null
        }
      >
        {playing ? (
          <div className="stack">
            <Player url={playing} autoPlay />
            <CopyField value={playing} />
            <p className="caption">浏览器试播依赖源站 CORS；失败时可复制地址到 VLC / PotPlayer 验证。</p>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
