import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Eraser, Info, LayoutGrid, Link2, List, Pencil, Search, Tag, Trash2, Tv, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import type { AdminChannel } from '../../lib/types';
import { formatResolution, formatSpeed, statusLabel, statusTone, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Pagination, Sheet, Skeleton, Switch, useToast } from '../../components/ui';

const DEFAULT_PAGE_SIZE = 12;

/** Parse `channelId => EPG name` lines (also accepts comma or tab). */
function parseBulkMappings(text: string): Array<{ channelId: string; alias: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?)\s*(?:=>|,|\t)\s*(.+)$/);
      return match ? { channelId: match[1].trim(), alias: match[2].trim() } : null;
    })
    .filter((item): item is { channelId: string; alias: string } => Boolean(item))
    .slice(0, 500);
}

interface AliasConflict {
  normalized: string;
  aliases: string[];
  channels: Array<{ id: string; name: string }>;
}

interface ChannelLineDetail {
  key?: string;
  url: string;
  name?: string;
  sourceId?: string;
  sourceName?: string;
  sourceSite?: string;
  resolution?: string;
  speedKbps?: number;
  latencyMs?: number;
  status?: string;
  transport?: string;
  lastProbeAt?: string;
}

interface ChannelDetailResponse {
  channel: { id: string; name: string; group_title?: string; enabled?: number };
  aliases: string[];
  lines: ChannelLineDetail[];
}

export function ChannelsAdmin() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState('');
  const [group, setGroup] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [editing, setEditing] = useState<AdminChannel | null>(null);
  const [form, setForm] = useState({ name: '', group: '', tvgId: '', logo: '' });
  const [aliasChannel, setAliasChannel] = useState<AdminChannel | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [epgOpen, setEpgOpen] = useState(false);
  const [epgSearch, setEpgSearch] = useState('');
  const [epgGroup, setEpgGroup] = useState('');
  const [epgLimit, setEpgLimit] = useState(100);
  const [epgInputs, setEpgInputs] = useState<Record<string, string>>({});
  const [epgBulk, setEpgBulk] = useState('');

  const tree = useQuery({
    queryKey: ['admin', 'channels', 'tree'],
    queryFn: () => api.get<{ total: number; countries: Array<{ country: string; total: number; groups: Array<{ group: string; count: number }> }> }>('/api/admin/channels/meta/tree'),
  });

  const channels = useQuery({
    queryKey: ['admin', 'channels', 'page', search, country, group, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
      if (search.trim()) params.set('q', search.trim());
      if (group) params.set('group', group);
      else if (country) {
        const groups = tree.data?.countries.find((item) => item.country === country)?.groups.map((item) => item.group) ?? [];
        if (groups.length) params.set('groups', groups.join(','));
      }
      return api.get<{ items: AdminChannel[]; total: number; offset: number; limit: number }>(`/api/admin/channels/page?${params.toString()}`);
    },
    enabled: !country || Boolean(tree.data),
  });

  const detail = useQuery({
    queryKey: ['admin', 'channels', 'detail', detailId],
    queryFn: () => api.get<ChannelDetailResponse>(`/api/admin/channels/${detailId}`),
    enabled: Boolean(detailId),
  });

  const conflicts = useQuery({
    queryKey: ['admin', 'channels', 'alias-conflicts'],
    queryFn: () => api.get<{ items: AliasConflict[]; total: number }>('/api/admin/channels/alias-conflicts'),
    enabled: conflictsOpen,
  });

  const epgCoverage = useQuery({
    queryKey: ['admin', 'epg-coverage', epgSearch, epgGroup, epgLimit],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(epgLimit) });
      if (epgSearch.trim()) params.set('q', epgSearch.trim());
      if (epgGroup) params.set('group', epgGroup);
      return api.get<{
        total: number;
        covered: number;
        percent: number;
        coveredAny?: number;
        stale?: number;
        guideAgeHours?: number | null;
        guideStale?: boolean;
        missing: Array<{ id: string; name: string; group: string }>;
        missingTotal: number;
      }>(`/api/admin/epg/coverage?${params.toString()}`);
    },
    enabled: epgOpen,
  });

  const bindEpg = useMutation({
    mutationFn: ({ channelId, alias }: { channelId: string; alias: string }) =>
      api.post(`/api/admin/channels/${encodeURIComponent(channelId)}/aliases`, { alias }),
    onSuccess: (_result, variables) => {
      show(`已为 ${variables.channelId} 绑定 EPG 名称：${variables.alias}`);
      setEpgInputs((current) => ({ ...current, [variables.channelId]: '' }));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'epg-coverage'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const bindEpgBulk = useMutation({
    mutationFn: (items: Array<{ channelId: string; alias: string }>) =>
      api.post<{ bound: number; failed: Array<{ channelId: string; alias: string; reason: string }> }>('/api/admin/epg/bind-bulk', { items }),
    onSuccess: (result) => {
      show(`批量绑定 ${result.bound} 条${result.failed.length ? `，失败 ${result.failed.length} 条` : ''}`);
      setEpgBulk('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'epg-coverage'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const items = channels.data?.items ?? [];
  const total = channels.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeCountry = tree.data?.countries.find((item) => item.country === country);
  const epgGroups = [...new Set((tree.data?.countries ?? []).flatMap((item) => item.groups.map((groupItem) => groupItem.group)))];
  const allSelected = items.length > 0 && items.every((channel) => selected.has(channel.id));

  useEffect(() => {
    setPage(1);
  }, [search, country, group]);

  const bulkGroup = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/api/admin/channels/bulk-group', { ids: [...selected], group: bulkTarget.trim() }),
    onSuccess: (result) => {
      show(`已移动 ${result.updated} 个频道`);
      setSelected(new Set());
      setBulkTarget('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const update = useMutation({
    mutationFn: () => api.patch(`/api/admin/channels/${editing?.id}`, {
      name: form.name,
      group_title: form.group,
      tvg_id: form.tvgId || null,
      logo: form.logo || null,
    }),
    onSuccess: () => {
      show('已保存');
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/channels/${id}/toggle`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] }),
  });

  const reclassify = useMutation({
    mutationFn: () => api.post<{ fixed: number; scanned: number }>('/api/admin/channels/reclassify'),
    onSuccess: (result) => {
      show(`已修复 ${result.fixed} 个频道分组（扫描 ${result.scanned} 个）`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const cleanupNames = useMutation({
    mutationFn: () => api.post<{ renamed: number; scanned: number }>('/api/admin/channels/cleanup-names'),
    onSuccess: (result) => {
      show(`已清理 ${result.renamed} 个频道名（扫描 ${result.scanned} 个）`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const cleanupEmpty = useMutation({
    mutationFn: () => api.post<{ deleted: number; kept: number }>('/api/admin/channels/cleanup-empty'),
    onSuccess: (result) => {
      show(`已删除 ${result.deleted} 个空频道，保留 ${result.kept} 个`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  async function openAliases(channel: AdminChannel): Promise<void> {
    setAliasChannel(channel);
    try {
      const detail = await api.get<{ aliases: string[] }>(`/api/admin/channels/${channel.id}`);
      setAliases(detail.aliases ?? []);
    } catch (error) {
      show(error instanceof Error ? error.message : '读取别名失败', 'error');
    }
  }

  async function addAlias(): Promise<void> {
    if (!aliasChannel || !aliasInput.trim()) return;
    const result = await api.post<{ aliases: string[] }>(`/api/admin/channels/${aliasChannel.id}/aliases`, { alias: aliasInput.trim() });
    setAliases(result.aliases);
    setAliasInput('');
  }

  async function removeAlias(alias: string): Promise<void> {
    if (!aliasChannel) return;
    const result = await api.post<{ aliases: string[] }>(`/api/admin/channels/${aliasChannel.id}/aliases/remove`, { alias });
    setAliases(result.aliases);
  }

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="CHANNELS"
        title="频道"
        description="频道身份由别名库驱动；改名、合并、禁用都会影响下一轮聚合。"
        actions={
          <>
            <Button loading={cleanupEmpty.isPending} onClick={() => { if (confirm('删除不在当前发布目录、且没有任何别名的频道？这不会影响已发布频道。')) cleanupEmpty.mutate(); }}><Trash2 size={15} /> 清理空频道</Button>
            <Button loading={cleanupNames.isPending} onClick={() => cleanupNames.mutate()}><Eraser size={15} /> 清理名称</Button>
            <Button onClick={() => setConflictsOpen(true)}><AlertTriangle size={15} /> 别名冲突</Button>
            <Button onClick={() => setEpgOpen(true)}><Link2 size={15} /> EPG 映射</Button>
            <Button loading={reclassify.isPending} onClick={() => reclassify.mutate()}><Wand2 size={15} /> 修复分类</Button>
          </>
        }
      />

      <Card className="channel-browse">
        <div className="channel-browse__head">
          <div>
            <div className="title-3">频道浏览</div>
            <div className="caption">按名称、国家 / 地区和分组筛选</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setCountry(''); setGroup(''); setPage(1); }}>重置筛选</Button>
        </div>
        <div className="channel-view-row">
          <div className="source-view-toggle">
            <Button size="sm" variant={view === 'grid' ? 'primary' : 'ghost'} onClick={() => setView('grid')}><LayoutGrid size={14} /> 网格</Button>
            <Button size="sm" variant={view === 'list' ? 'primary' : 'ghost'} onClick={() => setView('list')}><List size={14} /> 列表</Button>
          </div>
          <span className="caption">每页 {pageSize} 个</span>
        </div>
        <div className="search">
          <Search size={16} className="search__icon" />
          <input className="input" placeholder="搜索频道名称或 ID" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="channel-browse__row">
          <span className="channel-browse__label">国家 / 地区</span>
          <div className="channel-browse__chips">
            <button className={country ? 'chip' : 'chip chip--active'} onClick={() => { setCountry(''); setGroup(''); }}>
              全部 {tree.data?.total ?? ''}
            </button>
            {(tree.data?.countries ?? []).map((item) => (
              <button key={item.country} className={country === item.country ? 'chip chip--active' : 'chip'} onClick={() => { setCountry(item.country); setGroup(''); }}>
                {item.country} <span>{item.total}</span>
              </button>
            ))}
          </div>
        </div>
        {activeCountry ? (
          <div className="channel-browse__row">
            <span className="channel-browse__label">分组</span>
            <div className="channel-browse__chips">
              <button className={group ? 'chip' : 'chip chip--active'} onClick={() => setGroup('')}>全部分组</button>
              {activeCountry.groups.map((item) => (
                <button key={item.group} className={group === item.group ? 'chip chip--active' : 'chip'} onClick={() => setGroup(item.group)}>
                  {item.group} <span>{item.count}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <div className="row row--between row--wrap channel-result-bar">
        <div className="caption">共 {total} 个频道{country ? ` · ${country}` : ''}{group ? ` / ${group}` : ''}</div>
        <label className="caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => {
              const next = new Set(selected);
              for (const channel of items) {
                if (event.target.checked) next.add(channel.id);
                else next.delete(channel.id);
              }
              setSelected(next);
            }}
          />
          全选本页
        </label>
      </div>

      {selected.size ? (
        <Card className="channel-bulk">
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Badge tone="blue">已选 {selected.size} 个频道</Badge>
            <input className="input grow" value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} placeholder="目标分组，例如：我的收藏" />
            <Button loading={bulkGroup.isPending} onClick={() => bulkGroup.mutate()}>移动分组</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
          </div>
        </Card>
      ) : null}

      {channels.isError ? (
        <Card>
          <div className="caption" style={{ color: 'var(--red, #e5484d)', marginBottom: 8 }}>
            {channels.error instanceof Error ? channels.error.message : '加载失败，请重试'}
          </div>
          <Button onClick={() => void channels.refetch()}>重新加载</Button>
        </Card>
      ) : channels.isLoading ? (
        <Card><div className="caption">加载中…</div></Card>
      ) : null}

      <div className={`channel-grid${view === 'list' ? ' channel-grid--list' : ''}`}>
        {items.map((channel) => {
          const isSelected = selected.has(channel.id);
          const tone = !channel.enabled ? 'orange' : channel.lines > 0 && channel.alive === 0 ? 'red' : channel.alive > 0 ? 'green' : 'default';
          return (
            <div key={channel.id} className={`channel-card channel-card--${tone}${isSelected ? ' is-selected' : ''}`}>
              <div className="channel-card__head">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(channel.id);
                    else next.delete(channel.id);
                    setSelected(next);
                  }}
                />
                <div className="logo logo--fallback" style={{ fontSize: 13 }}>{channel.name.slice(0, 1)}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <span className="channel-card__name">{channel.name}</span>
                    {channel.bestResolution ? <Badge tone="blue">{formatResolution(channel.bestResolution)}</Badge> : null}
                  </div>
                  <div className="caption" style={{ marginTop: 2 }}>{channel.group}</div>
                </div>
              </div>
              <div className="channel-card__metrics">
                <span><strong>{channel.alive}</strong>/{channel.lines} 可用</span>
                <span><strong>{channel.sources}</strong> 个源</span>
                {channel.bestSpeedKbps ? <span>{formatSpeed(channel.bestSpeedKbps)}</span> : null}
              </div>
              <div className="channel-card__actions">
                <Button size="sm" variant="ghost" onClick={() => setDetailId(channel.id)} title="查看线路和订阅源">
                  <Info size={14} /> 详情
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void openAliases(channel)} title="别名">
                  <Tag size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(channel);
                    setForm({ name: channel.name, group: channel.group, tvgId: channel.tvgId ?? '', logo: channel.logo ?? '' });
                  }}
                  title="编辑"
                >
                  <Pencil size={14} />
                </Button>
                <Switch checked={channel.enabled} onChange={() => toggle.mutate(channel.id)} />
              </div>
            </div>
          );
        })}
        {!channels.isLoading && !channels.isError && !items.length ? (
          <div className="channel-card channel-card--default" style={{ justifyContent: 'center', color: 'var(--label-3)' }}><Tv size={15} /> 没有匹配的频道</div>
        ) : null}
      </div>

      <div className="row row--between row--wrap">
        <span className="caption">共 {total} 个频道</span>
        <label className="row" style={{ gap: 6 }}>
          <span className="caption">每页</span>
          <select className="input" style={{ width: 88 }} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={36}>36</option>
            <option value={48}>48</option>
          </select>
        </label>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Sheet
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="编辑频道"
        subtitle={editing?.id}
        footer={<Button block variant="primary" loading={update.isPending} onClick={() => update.mutate()}>保存</Button>}
      >
        <div className="stack">
          <div className="sheet-section">基础信息</div>
          <Field label="显示名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="分组"><input className="input" value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></Field>
          <div className="caption">分组决定国家归属：央视/卫视/港澳台/地方/国内其他归入中国；新闻/影视/付费/4K 等内容分组也归中国；其他分组名会单独成为一个国家或自定义分类。保存后下一轮发布进入对应分组。</div>
          <div className="sheet-section">EPG 与台标</div>
          <Field label="TVG ID（EPG 匹配用）"><input className="input" value={form.tvgId} onChange={(event) => setForm({ ...form, tvgId: event.target.value })} /></Field>
          <Field label="台标 URL"><input className="input" value={form.logo} onChange={(event) => setForm({ ...form, logo: event.target.value })} /></Field>
          <div className="caption">别名用于把不同写法归并到同一频道，可在列表页的 Tag 图标中维护。</div>
        </div>
      </Sheet>

      <Sheet open={Boolean(detailId)} onClose={() => setDetailId(null)} title="频道详情" subtitle={detail.data?.channel.name ?? detailId ?? ''}>
        {detail.isLoading ? <Skeleton height={240} radius={14} /> : detail.isError ? (
          <div className="caption" style={{ color: 'var(--red)' }}>{detail.error instanceof Error ? detail.error.message : '详情加载失败'}</div>
        ) : detail.data ? (() => {
          const lines = detail.data.lines;
          const alive = lines.filter((line) => line.status === 'alive').length;
          const sources = new Set(lines.map((line) => line.sourceName ?? line.sourceId ?? '未知')).size;
          return (
            <div className="stack">
              <div className="channel-detail-stats">
                <div><strong>{lines.length}</strong><span>线路</span></div>
                <div><strong>{alive}</strong><span>可用</span></div>
                <div><strong>{sources}</strong><span>来源</span></div>
                <div><strong>{detail.data.aliases.length}</strong><span>别名</span></div>
              </div>
              <div className="row row--between">
                <div className="title-3">线路明细</div>
                <span className="caption">来自哪个订阅源 / 站点</span>
              </div>
              <div className="channel-lines">
                {lines.map((line, index) => (
                  <div className="channel-line" key={line.key ?? `${line.url}-${index}`}>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row row--wrap" style={{ gap: 5 }}>
                        <Badge tone={statusTone(line.status ?? '')}>{statusLabel(line.status ?? '')}</Badge>
                        <span className="channel-line__source">{line.sourceName ?? line.sourceId ?? '未知源'}</span>
                        <span className="caption">{line.sourceSite ?? '未知站点'}</span>
                      </div>
                      <div className="channel-line__meta">
                        {line.resolution ? formatResolution(line.resolution) : '未知分辨率'}
                        {line.speedKbps ? ` · ${formatSpeed(line.speedKbps)}` : ' · 未测速'}
                        {` · ${line.transport === 'relay' ? '需中继' : '直连'}`}
                        {line.lastProbeAt ? ` · ${timeAgo(line.lastProbeAt)}` : ' · 未检测'}
                      </div>
                      <div className="channel-line__url mono truncate">{line.url}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="复制地址"
                      onClick={() => navigator.clipboard.writeText(line.url).then(() => show('已复制线路地址'))}
                    >
                      <Copy size={14} />
                    </Button>
                  </div>
                ))}
                {!lines.length ? <div className="task-empty">这个频道当前没有线路</div> : null}
              </div>
            </div>
          );
        })() : null}
      </Sheet>

      <Sheet open={Boolean(aliasChannel)} onClose={() => setAliasChannel(null)} title="频道别名" subtitle={aliasChannel?.name}>
        <div className="stack">
          <div className="sheet-section">新增别名</div>
          <div className="row">
            <input className="input grow" placeholder="例如：CCTV1 / 中央一台" value={aliasInput} onChange={(event) => setAliasInput(event.target.value)} />
            <Button onClick={() => void addAlias()}>添加</Button>
          </div>
          <div className="list">
            {aliases.map((alias) => (
              <div key={alias} className="list__row">
                <span className="grow mono">{alias}</span>
                <Button size="sm" variant="danger" onClick={() => void removeAlias(alias)}>移除</Button>
              </div>
            ))}
            {!aliases.length ? <div className="caption" style={{ padding: 12 }}>暂无别名</div> : null}
          </div>
        </div>
      </Sheet>
      <Sheet open={conflictsOpen} onClose={() => setConflictsOpen(false)} title="别名冲突" subtitle="同一个归一化别名指向多个频道">
        <div className="stack">
          {conflicts.isLoading ? <div className="caption">正在扫描…</div> : null}
          {conflicts.data?.items.length ? (
            conflicts.data.items.map((item) => (
              <Card key={item.normalized}>
                <div className="mono" style={{ fontWeight: 600 }}>{item.normalized}</div>
                <div className="caption" style={{ marginTop: 4 }}>别名：{item.aliases.join(' / ')}</div>
                <div className="stack stack--tight" style={{ marginTop: 8 }}>
                  {item.channels.map((channel) => (
                    <div key={channel.id} className="row row--between">
                      <span>{channel.name}</span>
                      <span className="caption mono">{channel.id}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ))
          ) : !conflicts.isLoading ? (
            <div className="caption">没有发现归一化别名冲突。</div>
          ) : null}
        </div>
      </Sheet>
      <Sheet open={epgOpen} onClose={() => setEpgOpen(false)} title="EPG 缺失映射" subtitle={epgCoverage.data ? `${epgCoverage.data.covered} / ${epgCoverage.data.total} 个频道有未来节目${epgCoverage.data.guideStale ? '（节目单已过期）' : ''}` : undefined}>
        <div className="stack">
          <div className="caption">
            输入 EPG 里的显示名或数字 ID（例如 北京卫视 / 539726），绑定后下一轮采集生效。
            {epgCoverage.data ? ` 当前缺失 ${epgCoverage.data.missingTotal} 个，已显示 ${epgCoverage.data.missing.length} 个。` : ''}
            {epgCoverage.data?.stale ? ` 另有 ${epgCoverage.data.stale} 个频道节目已全部过期。` : ''}
          </div>
          <div className="row row--wrap" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button
              className={epgGroup ? 'chip' : 'chip chip--active'}
              onClick={() => {
                setEpgGroup('');
                setEpgLimit(100);
              }}
            >
              全部分组
            </button>
            {epgGroups.map((item) => (
              <button
                key={item}
                className={epgGroup === item ? 'chip chip--active' : 'chip'}
                onClick={() => {
                  setEpgGroup(item);
                  setEpgLimit(100);
                }}
              >
                {item}
              </button>
            ))}
          </div>
          <input
            className="input"
            placeholder="搜索缺失频道…"
            value={epgSearch}
            onChange={(event) => {
              setEpgSearch(event.target.value);
              setEpgLimit(100);
            }}
          />
          <div className="stack" style={{ gap: 6 }}>
            <div className="caption">批量粘贴：每行「频道 ID 或名称 =&gt; EPG 名称/ID」，最多 500 条</div>
            <textarea
              className="input"
              rows={4}
              value={epgBulk}
              onChange={(event) => setEpgBulk(event.target.value)}
              placeholder={'cctv1 => CCTV1\nx-abc123 => 北京卫视'}
              style={{ fontFamily: 'monospace', resize: 'vertical' }}
            />
            <div className="row" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="glass"
                disabled={!epgCoverage.data?.missing.length}
                onClick={() => setEpgBulk((epgCoverage.data?.missing ?? []).map((channel) => `${channel.id} => `).join('\n'))}
              >
                填入当前列表
              </Button>
              <Button
                size="sm"
                loading={bindEpgBulk.isPending}
                disabled={!parseBulkMappings(epgBulk).length}
                onClick={() => bindEpgBulk.mutate(parseBulkMappings(epgBulk))}
              >
                批量绑定
              </Button>
            </div>
          </div>
          {epgCoverage.isLoading ? <div className="caption">正在读取覆盖率…</div> : null}
          {epgCoverage.data?.missing.map((channel) => (
              <div key={channel.id} className="list__row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="list__title truncate">{channel.name}</div>
                  <div className="caption mono">{channel.id} · {channel.group || '未分组'}</div>
                </div>
                <input
                  className="input"
                  style={{ maxWidth: 190 }}
                  placeholder="EPG 名称 / ID"
                  value={epgInputs[channel.id] ?? ''}
                  onChange={(event) => setEpgInputs((current) => ({ ...current, [channel.id]: event.target.value }))}
                />
                <Button
                  size="sm"
                  loading={bindEpg.isPending}
                  disabled={!(epgInputs[channel.id] ?? '').trim()}
                  onClick={() => bindEpg.mutate({ channelId: channel.id, alias: (epgInputs[channel.id] ?? '').trim() })}
                >
                  绑定
                </Button>
              </div>
            ))}
          {epgCoverage.data && epgCoverage.data.missing.length < epgCoverage.data.missingTotal ? (
            <Button variant="glass" onClick={() => setEpgLimit((value) => value + 100)}>
              加载更多（还有 {epgCoverage.data.missingTotal - epgCoverage.data.missing.length} 个）
            </Button>
          ) : null}
          {epgCoverage.data && !epgCoverage.data.missing.length ? <div className="caption">所有频道都有节目单。</div> : null}
        </div>
      </Sheet>
    </div>
  );
}
