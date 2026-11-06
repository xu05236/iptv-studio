import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { EmptyState, useToast } from '../../components/ui';
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

export function Epg() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [keyword, setKeyword] = useState('');

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
        eyebrow="节目单"
        title="EPG 覆盖与映射"
        description="未映射的 EPG 频道名可以直接绑定到已有频道；绑定后立即计入覆盖率。"
        meta={stats ? `节目单生成于 ${stats.guideGeneratedAt ? timeAgo(stats.guideGeneratedAt) : '未知'}${stats.guideStale ? ' · 已过期' : ''}` : undefined}
        actions={
          <button className="btn btn--sm" onClick={() => clean.mutate()} disabled={clean.isPending}>
            <Trash2 size={14} /> 清理噪声频道
          </button>
        }
      />

      <div className="stack">
        <div className="card" style={{ padding: 16 }}>
          {stats ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <strong style={{ fontSize: 26 }}>{stats.percent}%</strong>
                <span className="caption">
                  有未来节目 {stats.covered} / {stats.total} 个频道
                  {stats.stale ? ` · ${stats.stale} 个频道的节目已全部过期` : ''}
                </span>
              </div>
              <div style={{ height: 8, background: 'var(--border, #e5e7eb)', borderRadius: 999, overflow: 'hidden', marginTop: 10 }}>
                <div style={{ width: `${stats.percent}%`, height: '100%', background: 'var(--accent, #2563eb)' }} />
              </div>
              {stats.guideStale ? (
                <div className="caption" style={{ marginTop: 8, color: 'var(--warning, #b45309)' }}>
                  节目单已过期（{stats.guideAgeHours ?? '?'} 小时前生成），刷新 EPG 前覆盖率不可信。
                </div>
              ) : null}
            </>
          ) : (
            <span className="caption">加载中…</span>
          )}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <strong>节目源贡献</strong>
            <span className="caption">
              {sources.data?.generatedAt ? `上次抓取 ${timeAgo(sources.data.generatedAt)}` : '还没有抓取记录'}
            </span>
          </div>
          {!sources.data?.items.length ? (
            <span className="caption">运行一次 EPG 抓取后会显示每个源的频道/节目数。</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.data.items.map((item) => (
                <div
                  key={item.url}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border, #eee)', paddingBottom: 6 }}
                >
                  <strong style={{ minWidth: 140 }}>{item.provider}</strong>
                  <span className="caption" style={{ color: item.ok ? undefined : 'var(--danger, #b91c1c)' }}>
                    {item.ok ? '正常' : (item.error ?? '失败')}
                  </span>
                  <span className="caption">{item.ok && item.programmes === 0 ? '0 节目' : ''}</span>
                  <div className="grow" />
                  <span className="caption">
                    {item.channels} 频道 · {item.programmes} 节目 · {item.bytes ? `${Math.round(item.bytes / 1024)} KB` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <strong>未映射的 EPG 频道名</strong>
            <span className="caption">{unmatched.data?.items.length ?? 0} 条</span>
            <div className="grow" />
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.slice(0, 300).map((item) => (
                <div
                  key={`${item.provider}-${item.epgName}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border, #eee)', paddingBottom: 8 }}
                >
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
