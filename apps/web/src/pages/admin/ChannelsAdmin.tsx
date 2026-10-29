import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eraser, Link2, Pencil, Search, Tag, Trash2, Tv, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminChannel } from '../../lib/types';
import { formatResolution, formatSpeed } from '../../lib/format';
import { Badge, Button, Card, Field, Pagination, Sheet, Switch, useToast } from '../../components/ui';

const DEFAULT_PAGE_SIZE = 10;

interface AliasConflict {
  normalized: string;
  aliases: string[];
  channels: Array<{ id: string; name: string }>;
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
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [epgOpen, setEpgOpen] = useState(false);
  const [epgSearch, setEpgSearch] = useState('');
  const [epgLimit, setEpgLimit] = useState(100);
  const [epgInputs, setEpgInputs] = useState<Record<string, string>>({});

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

  const conflicts = useQuery({
    queryKey: ['admin', 'channels', 'alias-conflicts'],
    queryFn: () => api.get<{ items: AliasConflict[]; total: number }>('/api/admin/channels/alias-conflicts'),
    enabled: conflictsOpen,
  });

  const epgCoverage = useQuery({
    queryKey: ['admin', 'epg-coverage', epgSearch, epgLimit],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(epgLimit) });
      if (epgSearch.trim()) params.set('q', epgSearch.trim());
      return api.get<{
        total: number;
        covered: number;
        percent: number;
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

  const items = channels.data?.items ?? [];
  const total = channels.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeCountry = tree.data?.countries.find((item) => item.country === country);
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
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">频道</h1>
          <p className="subhead" style={{ marginTop: 4 }}>频道身份由别名库驱动；改名、合并、禁用都会影响下一轮聚合。</p>
        </div>
        <div className="row">
          <Button
            loading={cleanupEmpty.isPending}
            onClick={() => {
              if (confirm('删除不在当前发布目录、且没有任何别名的频道？这不会影响已发布频道。')) cleanupEmpty.mutate();
            }}
          >
            <Trash2 size={15} /> 清理空频道
          </Button>
          <Button loading={cleanupNames.isPending} onClick={() => cleanupNames.mutate()}>
            <Eraser size={15} /> 清理名称
          </Button>
          <Button onClick={() => setConflictsOpen(true)}>
            <AlertTriangle size={15} /> 别名冲突
          </Button>
          <Button onClick={() => setEpgOpen(true)}>
            <Link2 size={15} /> EPG 映射
          </Button>
          <Button loading={reclassify.isPending} onClick={() => reclassify.mutate()}>
            <Wand2 size={15} /> 修复分类
          </Button>
        </div>
      </div>

      <div className="search">
        <Search size={16} className="search__icon" />
        <input className="input" placeholder="搜索频道名称或 ID" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      <div className="row row--wrap" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className={country ? 'chip' : 'chip chip--active'} onClick={() => { setCountry(''); setGroup(''); }}>
          全部 {tree.data?.total ?? ''}
        </button>
        {(tree.data?.countries ?? []).map((item) => (
          <button
            key={item.country}
            className={country === item.country ? 'chip chip--active' : 'chip'}
            onClick={() => { setCountry(item.country); setGroup(''); }}
          >
            {item.country} {item.total}
          </button>
        ))}
      </div>

      {activeCountry ? (
        <div className="row row--wrap" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className={group ? 'chip' : 'chip chip--active'} onClick={() => setGroup('')}>全部分组</button>
          {activeCountry.groups.map((item) => (
            <button
              key={item.group}
              className={group === item.group ? 'chip chip--active' : 'chip'}
              onClick={() => setGroup(item.group)}
            >
              {item.group} {item.count}
            </button>
          ))}
        </div>
      ) : null}

      <div className="row row--between row--wrap">
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
        <Card>
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="caption">已选 {selected.size} 个频道</span>
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

      <div className="list">
        {items.map((channel) => (
          <div key={channel.id} className="list__row">
            <input
              type="checkbox"
              checked={selected.has(channel.id)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(channel.id);
                else next.delete(channel.id);
                setSelected(next);
              }}
              style={{ marginTop: 4 }}
            />
            <div className="logo logo--fallback" style={{ fontSize: 13 }}>{channel.name.slice(0, 1)}</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="list__title truncate">{channel.name}</span>
                {channel.bestResolution ? <Badge tone="blue">{formatResolution(channel.bestResolution)}</Badge> : null}
              </div>
              <div className="list__sub">
                {channel.group} · {channel.alive}/{channel.lines} 可用 · {channel.sources} 个源
                {channel.bestSpeedKbps ? ` · ${formatSpeed(channel.bestSpeedKbps)}` : ''}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
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
        ))}
        {!channels.isLoading && !channels.isError && !items.length ? (
          <div className="caption" style={{ padding: 16 }}><Tv size={14} /> 没有匹配的频道。</div>
        ) : null}
      </div>

      <div className="row row--between row--wrap">
        <span className="caption">共 {total} 个频道</span>
        <label className="row" style={{ gap: 6 }}>
          <span className="caption">每页</span>
          <select className="input" style={{ width: 88 }} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
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
          <Field label="显示名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="分组"><input className="input" value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} /></Field>
          <div className="caption">分组决定国家归属：央视/卫视/港澳台/地方/国内其他归入中国；新闻/影视/付费/4K 等内容分组也归中国；其他分组名会单独成为一个国家或自定义分类。保存后下一轮发布进入对应分组。</div>
          <Field label="TVG ID（EPG 匹配用）"><input className="input" value={form.tvgId} onChange={(event) => setForm({ ...form, tvgId: event.target.value })} /></Field>
          <Field label="台标 URL"><input className="input" value={form.logo} onChange={(event) => setForm({ ...form, logo: event.target.value })} /></Field>
          <div className="caption">别名用于把不同写法归并到同一频道，可在列表页的 Tag 图标中维护。</div>
        </div>
      </Sheet>

      <Sheet open={Boolean(aliasChannel)} onClose={() => setAliasChannel(null)} title="频道别名" subtitle={aliasChannel?.name}>
        <div className="stack">
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
      <Sheet open={epgOpen} onClose={() => setEpgOpen(false)} title="EPG 缺失映射" subtitle={epgCoverage.data ? `${epgCoverage.data.covered} / ${epgCoverage.data.total} 个频道有节目单` : undefined}>
        <div className="stack">
          <div className="caption">
            输入 EPG 里的显示名或数字 ID（例如 北京卫视 / 539726），绑定后下一轮采集生效。
            {epgCoverage.data ? ` 当前缺失 ${epgCoverage.data.missingTotal} 个，已显示 ${epgCoverage.data.missing.length} 个。` : ''}
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
