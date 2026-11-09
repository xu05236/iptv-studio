import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, PieChart, RadioTower, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, EmptyState, Field, Switch, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { timeAgo } from '../../lib/format';

interface Coverage {
  total: number;
  covered: number;
  percent: number;
  stale: number;
  guideGeneratedAt?: string | null;
  guideAgeHours?: number | null;
  guideStale?: boolean;
}

interface UnmatchedItem {
  epgName: string;
  provider: string;
  channelId: string;
  confidence: number;
}

interface ChannelLite {
  id: string;
  name: string;
  group?: string;
}

interface EpgSource {
  provider: string;
  url: string;
  ok: boolean;
  bytes: number;
  channels: number;
  programmes: number;
  error?: string;
}

interface EpgSettings {
  epgUrls?: string[];
  epgSourcePriority?: string;
  epgRefreshEnabled?: boolean;
  epgRefreshTimes?: string;
}

export function Epg() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [keyword, setKeyword] = useState('');
  const [epgText, setEpgText] = useState('');
  const [priority, setPriority] = useState('');
  const [epgEnabled, setEpgEnabled] = useState(true);
  const [epgTimes, setEpgTimes] = useState('00:10');

  const coverage = useQuery({
    queryKey: ['epg-coverage'],
    queryFn: () => api.get<Coverage>('/api/admin/epg/coverage?limit=1'),
  });
  const unmatched = useQuery({
    queryKey: ['epg-unmatched'],
    queryFn: () => api.get<{ generatedAt: string | null; items: UnmatchedItem[]; channels: ChannelLite[] }>('/api/admin/epg/unmatched'),
  });
  const sources = useQuery({
    queryKey: ['epg-sources'],
    queryFn: () => api.get<{ generatedAt: string | null; items: EpgSource[] }>('/api/admin/epg/sources'),
  });
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: EpgSettings }>('/api/admin/settings'),
  });

  useEffect(() => {
    const value = settings.data?.settings;
    if (!value) return;
    setEpgText((value.epgUrls ?? []).join('\n'));
    setPriority(value.epgSourcePriority ?? '');
    setEpgEnabled(value.epgRefreshEnabled ?? true);
    setEpgTimes(value.epgRefreshTimes ?? '00:10');
  }, [settings.data]);

  const saveEpgSettings = useMutation({
    mutationFn: () =>
      api.put('/api/admin/settings', {
        epgUrls: epgText.split(/\n+/).map((line) => line.trim()).filter(Boolean),
        epgSourcePriority: priority,
        epgRefreshEnabled: epgEnabled,
        epgRefreshTimes: epgTimes,
      }),
    onSuccess: () => {
      show('EPG 设置已保存，下一轮抓取生效');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (error: Error) => show(`保存失败：${error.message}`, 'error'),
  });

  const bind = useMutation({
    mutationFn: (input: { epgName: string; channelId: string }) =>
      api.post('/api/admin/epg/bind-bulk', { items: [{ channelId: input.channelId, alias: input.epgName }] }),
    onSuccess: (_data, input) => {
      show(`已绑定「${input.epgName}」`);
      void queryClient.invalidateQueries({ queryKey: ['epg-unmatched'] });
      void queryClient.invalidateQueries({ queryKey: ['epg-coverage'] });
    },
    onError: (error: Error) => show(`绑定失败：${error.message}`, 'error'),
  });

  const clean = useMutation({
    mutationFn: () => api.post<{ removed: number }>('/api/admin/epg/clean-noise'),
    onSuccess: (result) => {
      show(`已清理 ${result.removed} 个噪声频道`);
      void queryClient.invalidateQueries({ queryKey: ['epg-unmatched'] });
    },
    onError: (error: Error) => show(`清理失败：${error.message}`, 'error'),
  });

  const channels = useMemo(
    () => [...(unmatched.data?.channels ?? [])].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    [unmatched.data?.channels],
  );
  const items = useMemo(() => {
    const base = unmatched.data?.items ?? [];
    const query = keyword.trim().toLowerCase();
    if (!query) return base;
    return base.filter((item) => `${item.epgName} ${item.provider}`.toLowerCase().includes(query));
  }, [unmatched.data?.items, keyword]);

  const stats = coverage.data;

  return (
    <>
      <AdminPageHeader
        eyebrow="EPG"
        title="EPG 覆盖与映射"
        description="未映射的 EPG 频道名可以直接绑定到已有频道；绑定后立即计入覆盖率。"
        meta={stats ? `节目单生成于 ${stats.guideGeneratedAt ? timeAgo(stats.guideGeneratedAt) : '未知'}${stats.guideStale ? ' · 已过期' : ''}` : undefined}
        actions={
          <Button size="sm" onClick={() => clean.mutate()} loading={clean.isPending}>
            <Trash2 size={14} /> 清理噪声频道
          </Button>
        }
      />

      <div className="stack">
        <div className="dashboard-stats">
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--blue"><PieChart size={16} /></span>
            <div><div className="dash-stat__value">{stats ? `${stats.percent}%` : '—'}</div><div className="dash-stat__label">覆盖率（有未来节目）</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--green"><CalendarClock size={16} /></span>
            <div><div className="dash-stat__value">{stats ? `${stats.covered}/${stats.total}` : '—'}</div><div className="dash-stat__label">有节目频道</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--orange"><AlertTriangle size={16} /></span>
            <div><div className="dash-stat__value">{stats?.stale ?? '—'}</div><div className="dash-stat__label">节目全部过期</div></div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat__icon dash-stat__icon--teal"><RadioTower size={16} /></span>
            <div><div className="dash-stat__value">{unmatched.data?.items.length ?? '—'}</div><div className="dash-stat__label">未映射 EPG 名</div></div>
          </div>
        </div>

        <div className="card">
          <div className="row row--between row--wrap">
            <div>
              <div className="title-3">节目单状态</div>
              <div className="caption">
                {stats?.guideGeneratedAt ? `生成于 ${timeAgo(stats.guideGeneratedAt)}` : '还没有生成过'}
                {stats?.guideStale ? ` · ${stats.guideAgeHours ?? '?'} 小时前，已过期` : ''}
              </div>
            </div>
            {stats?.guideStale ? <Badge tone="orange">已过期</Badge> : <Badge tone="green">正常</Badge>}
          </div>
          <div style={{ height: 8, background: 'var(--border, #e5e7eb)', borderRadius: 999, overflow: 'hidden', marginTop: 10 }}>
            <div style={{ width: `${stats?.percent ?? 0}%`, height: '100%', background: 'var(--accent, #2563eb)' }} />
          </div>
        </div>

        <div className="card">
          <div className="row row--between row--wrap" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div className="title-3">节目单设置</div>
              <div className="caption">节目源、源优先级和定时抓取；保存后下一轮 EPG 抓取生效</div>
            </div>
            <Button variant="primary" size="sm" loading={saveEpgSettings.isPending} onClick={() => saveEpgSettings.mutate()}>
              <Save size={14} /> 保存设置
            </Button>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <Field label="XMLTV 源" hint="每行一个地址；留空则不生成节目单">
              <textarea className="input" rows={4} value={epgText} onChange={(event) => setEpgText(event.target.value)} placeholder="https://example.com/epg.xml" />
            </Field>
            <Field label="源优先级" hint="按 hostname 排序，逗号分隔；同频道同一时刻以靠前的源为准">
              <input className="input" value={priority} onChange={(event) => setPriority(event.target.value)} placeholder="fanmingming.com,epg.pw,51zmt.top" />
            </Field>
            <div className="list">
              <div className="list__row">
                <span className="grow">启用 EPG 独立定时抓取</span>
                <Switch checked={epgEnabled} onChange={setEpgEnabled} />
              </div>
            </div>
            <Field label="抓取时刻（北京时间）" hint="支持多个时刻，用逗号分隔，例如 00:10, 12:10">
              <input className="input" value={epgTimes} onChange={(event) => setEpgTimes(event.target.value)} />
            </Field>
          </div>
        </div>

        <div className="card">
          <div className="row row--between row--wrap" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div className="title-3">节目源贡献</div>
              <div className="caption">{sources.data?.generatedAt ? `上次抓取 ${timeAgo(sources.data.generatedAt)}` : '还没有抓取记录'}</div>
            </div>
          </div>
          {!sources.data?.items.length ? (
            <span className="caption">运行一次 EPG 抓取后会显示每个源的频道/节目数。</span>
          ) : (
            <div className="list">
              {sources.data.items.map((item) => (
                <div className="list__row" key={item.url}>
                  <strong style={{ minWidth: 140 }}>{item.provider}</strong>
                  <span className="caption" style={{ color: item.ok ? undefined : 'var(--danger, #b91c1c)' }}>
                    {item.ok ? '正常' : (item.error ?? '失败')}
                  </span>
                  <div className="grow" />
                  <span className="caption">
                    {item.channels} 频道 · {item.programmes} 节目 · {item.bytes ? `${Math.round(item.bytes / 1024)} KB` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row row--between row--wrap" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div className="title-3">未映射的 EPG 频道名</div>
              <div className="caption">{unmatched.data?.items.length ?? 0} 条；绑定后立即计入覆盖率</div>
            </div>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder="搜索名称/来源"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>

          {unmatched.isLoading ? (
            <span className="caption">加载中…</span>
          ) : !items.length ? (
            <EmptyState title="没有未映射的 EPG 名" description="当前节目单里的频道名都能对上，或还没有生成过 EPG。" />
          ) : (
            <div className="list">
              {items.slice(0, 300).map((item) => (
                <div className="list__row" key={`${item.provider}-${item.epgName}`}>
                  <strong style={{ minWidth: 160 }}>{item.epgName}</strong>
                  <span className="caption" style={{ minWidth: 140 }}>{item.provider}</span>
                  <span className="caption">置信度 {Math.round(item.confidence * 100)}%</span>
                  <div className="grow" />
                  <select
                    className="select"
                    style={{ maxWidth: 240 }}
                    value={picked[item.epgName] ?? ''}
                    onChange={(event) => setPicked({ ...picked, [item.epgName]: event.target.value })}
                  >
                    <option value="">选择要绑定的频道…</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>{channel.name}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn--sm"
                    disabled={!picked[item.epgName] || bind.isPending}
                    onClick={() => bind.mutate({ epgName: item.epgName, channelId: picked[item.epgName]! })}
                  >
                    绑定
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
