import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, Filter, Layers3, RefreshCw, RotateCcw, Star, Trash2 } from 'lucide-react';
import { api, getToken } from '../../lib/api';
import { formatResolution, formatSpeed, statusLabel, statusTone } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Pagination, Sheet, Skeleton, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { ReputationBadge } from '../../components/ReputationBadge';
import { timeAgo } from '../../lib/format';

const DEFAULT_PAGE_SIZE = 10;
const POOLS = [
  { value: '', label: '全部池' },
  { value: 'pending', label: '待测池' },
  { value: 'candidate', label: '候选池' },
  { value: 'premium', label: '精品池' },
  { value: 'backup', label: '备用池' },
  { value: 'quarantine', label: '待复测' },
  { value: 'rejected', label: '已淘汰' },
];
const POOL_LABEL: Record<string, string> = Object.fromEntries(POOLS.map((item) => [item.value, item.label]));

interface PoolCounts {
  premium: number;
  backup: number;
  candidate: number;
  pending: number;
  quarantine: number;
  rejected: number;
}

interface PoolChannel {
  id: string;
  name: string;
  counts: PoolCounts;
}

interface PoolTreeGroup {
  group: string;
  total: number;
  channels: PoolChannel[];
}

interface PoolTreeCountry {
  country: string;
  total: number;
  groups: PoolTreeGroup[];
}

interface PoolLine {
  key: string;
  channelId: string;
  channelName: string;
  group: string;
  country: string;
  sourceId: string;
  sourceName: string;
  sourceReputation: number;
  sourceTier: 'high' | 'normal' | 'low';
  name: string;
  url: string;
  resolution?: string;
  height?: number;
  speedKbps?: number;
  protocol: string;
  transport: 'direct' | 'relay';
  pool: keyof PoolCounts;
  autoPool: keyof PoolCounts;
  favorite?: boolean;
  overridden: boolean;
  promoted?: boolean;
  reason?: string;
  status: string;
  score: number;
  passCount?: number;
  lastProbeAt?: string;
  retained?: boolean;
}

function poolTone(pool: string): 'green' | 'blue' | 'orange' | 'red' | undefined {
  if (pool === 'premium') return 'green';
  if (pool === 'backup') return 'blue';
  if (pool === 'candidate') return 'orange';
  if (pool === 'rejected') return 'red';
  if (pool === 'pending' || pool === 'quarantine') return 'orange';
  return undefined;
}

export function Pool() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPool, setBulkPool] = useState('backup');
  const [country, setCountry] = useState('');
  const [group, setGroup] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channelQuery, setChannelQuery] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [pool, setPool] = useState('');
  const [transport, setTransport] = useState('');
  const [resolution, setResolution] = useState('');
  const [minSpeed, setMinSpeed] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sortField, setSortField] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [tombstonesOpen, setTombstonesOpen] = useState(false);

  const tree = useQuery({
    queryKey: ['admin', 'pool', 'tree'],
    queryFn: () => api.get<{ countries: PoolTreeCountry[]; snapshot?: { generatedAt?: string | null; channels?: number } }>('/api/admin/pool/tree'),
  });

  const subscriptions = useQuery({
    queryKey: ['admin', 'subscriptions'],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/admin/subscriptions'),
  });

  const sources = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string; enabled: boolean }> }>('/api/admin/sources'),
  });

  const tombstones = useQuery({
    queryKey: ['admin', 'pool', 'tombstones'],
    queryFn: () => api.get<{ items: Array<{ url: string; channel_id?: string | null; reason?: string | null; created_at: string }> }>('/api/admin/pool/tombstones'),
    enabled: tombstonesOpen,
  });

  const poolTotals = useMemo(() => {
    const totals: PoolCounts = { premium: 0, backup: 0, candidate: 0, pending: 0, quarantine: 0, rejected: 0 };
    const keys = Object.keys(totals) as Array<keyof PoolCounts>;
    for (const countryItem of tree.data?.countries ?? []) {
      for (const groupItem of countryItem.groups) {
        for (const channel of groupItem.channels) {
          for (const key of keys) totals[key] += channel.counts[key] ?? 0;
        }
      }
    }
    return totals;
  }, [tree.data]);

  // The old channel picker only listed channels of the selected group, so it
  // could not be used as a real filter. Search across every pool channel.
  const allChannels = useMemo(
    () =>
      (tree.data?.countries ?? [])
        .flatMap((countryItem) =>
          countryItem.groups.flatMap((groupItem) =>
            groupItem.channels.map((channel) => ({ id: channel.id, name: channel.name, group: groupItem.group })),
          ),
        )
        .sort((a, b) => a.group.localeCompare(b.group, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN')),
    [tree.data],
  );

  const countryItem = tree.data?.countries.find((item) => item.country === country);
  const groups = countryItem?.groups ?? [];

  const minSpeedKbps = minSpeed ? String(Math.max(0, Math.round(Number(minSpeed) * 1000))) : '';

  const params = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (country) value.set('country', country);
    if (group) value.set('group', group);
    if (channelId) value.set('channelId', channelId);
    if (subscriptionId) value.set('subscriptionId', subscriptionId);
    if (sourceId) value.set('sourceId', sourceId);
    if (pool) value.set('pool', pool);
    if (transport) value.set('transport', transport);
    if (resolution) value.set('resolution', resolution);
    if (minSpeedKbps) value.set('minSpeed', minSpeedKbps);
    if (search.trim()) value.set('q', search.trim());
    if (sortField) {
      value.set('sort', sortField);
      value.set('order', sortOrder);
    }
    return value.toString();
  }, [country, group, channelId, subscriptionId, sourceId, pool, transport, resolution, minSpeedKbps, search, page, pageSize, sortField, sortOrder]);

  const lines = useQuery({
    queryKey: ['admin', 'pool', 'lines', params],
    queryFn: () => api.get<{ items: PoolLine[]; total: number; page: number; limit: number }>(`/api/admin/pool/lines?${params}`),
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(1, Math.ceil((lines.data?.total ?? 0) / pageSize));

  const toggleSort = (field: string) => {
    if (sortField === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortOrder('desc');
    }
    setPage(1);
  };
  const sortHead = (field: string, label: string) => {
    const active = sortField === field;
    return (
      <th>
        <button type="button" className={active ? 'pool-sort pool-sort--active' : 'pool-sort'} onClick={() => toggleSort(field)}>
          <span>{label}</span>
          <span className="pool-sort__arrow">{active ? (sortOrder === 'asc' ? '↑' : '↓') : '↕'}</span>
        </button>
      </th>
    );
  };

  const override = useMutation({
    mutationFn: ({ keys, pool }: { keys: string[]; pool: string }) =>
      api.post<{ updated: number }>('/api/admin/pool/override', { keys, pool }),
    onSuccess: (result) => {
      show(`已更新 ${result.updated} 条线路`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const favorite = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) =>
      api.post<{ count: number }>('/api/admin/pool/favorite', { keys: [key], favorite: value }),
    onSuccess: () => {
      show('线路收藏状态已更新');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const reset = useMutation({    mutationFn: (keys: string[]) => api.post<{ removed: number }>('/api/admin/pool/reset', { keys }),
    onSuccess: (result) => {
      show(`已恢复 ${result.removed} 条线路为自动池`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const deleteLines = useMutation({
    mutationFn: (keys: string[]) => api.post<{ removed: number }>('/api/admin/pool/delete', { keys }),
    onSuccess: (result) => {
      show(`已删除 ${result.removed} 条线路`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const tombstoneLines = useMutation({
    mutationFn: ({ keys, reason }: { keys: string[]; reason?: string }) =>
      api.post<{ tombstoned: number; removed: number }>('/api/admin/pool/tombstone', { keys, reason }),
    onSuccess: (result) => {
      show(`已标记墓碑 ${result.tombstoned} 条，删除 ${result.removed} 条`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const untombstone = useMutation({
    mutationFn: (urls: string[]) => api.post<{ removed: number }>('/api/admin/pool/untombstone', { urls }),
    onSuccess: (result) => {
      show(`已解除 ${result.removed} 条墓碑`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const rebuildSnapshot = useMutation({
    mutationFn: () => api.post<{ message?: string }>('/api/admin/runs/dispatch', { command: 'export' }),
    onSuccess: (result) => {
      show(result?.message ?? '已派发重建快照任务');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const exportPool = useMutation({
    mutationFn: async () => {
      const token = getToken();
      const response = await fetch('/api/admin/pool/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          country,
          group,
          channelId,
          sourceId,
          pool,
          transport,
          resolution,
          minSpeed: minSpeedKbps,
          q: search.trim(),
          keys: selected.size ? [...selected] : undefined,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `导出失败 HTTP ${response.status}`);
      }
      const text = await response.text();
      const blob = new Blob([text], { type: 'audio/x-mpegurl;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `line-pool-${new Date().toISOString().slice(0, 10)}.m3u`;
      link.click();
      URL.revokeObjectURL(url);
      return selected.size || text.split('\n').filter((line) => line.startsWith('#EXTINF')).length;
    },
    onSuccess: (count) => show(`已导出 ${count} 条线路`),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const reviveSelected = useMutation({
    mutationFn: (keys: string[]) => api.post<{ revived: number; dispatched?: boolean }>('/api/admin/pool/revive', { keys }),
    onSuccess: (result) => {
      show(`已复活 ${result.revived} 条线路${result.dispatched ? '，已派发探测' : ''}`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'pool'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const saveSubscription = useMutation({
    mutationFn: () => {
      const name = window.prompt('订阅名称', `线路池订阅 ${new Date().toISOString().slice(0, 10)}`);
      if (!name?.trim()) throw new Error('已取消');
      return api.post<{ id: string; token: string; lines: number }>('/api/admin/pool/subscription', {
        name: name.trim(),
        country,
        group,
        channelId,
        sourceId,
        pool,
        transport,
        resolution,
        minSpeed: minSpeedKbps,
        q: search.trim(),
        keys: selected.size ? [...selected] : undefined,
      });
    },
    onSuccess: (result) => {
      show(`已保存订阅，共 ${result.lines} 条线路`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
    onError: (error: Error) => {
      if (error.message !== '已取消') show(error.message, 'error');
    },
  });

  function resetPage(): void {
    setPage(1);
  }

  function selectCountry(value: string): void {
    setCountry(value);
    setGroup('');
    setChannelId('');
    setChannelQuery('');
    resetPage();
  }

  function selectGroup(value: string): void {
    setGroup(value);
    setChannelId('');
    setChannelQuery('');
    resetPage();
  }

  function clearFilters(): void {
    setCountry('');
    setGroup('');
    setChannelId('');
    setChannelQuery('');
    setSubscriptionId('');
    setSourceId('');
    setPool('');
    setResolution('');
    setTransport('');
    setMinSpeed('');
    setSearch('');
    resetPage();
  }

  if (tree.isLoading) {
    return <div className="stack"><Skeleton height={34} width={220} /><Skeleton height={240} radius={16} /></div>;
  }

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="LINE POOL"
        title="线路池"
        description="按国家 / 分组 / 频道或订阅查看线路；可移动、删除、墓碑；candidate 为测活通过但质量待确认。"
        actions={
          <>
            <Button loading={tree.isFetching || lines.isFetching} onClick={() => { void tree.refetch(); void lines.refetch(); }}><RefreshCw size={15} /> 刷新</Button>
            <Button loading={rebuildSnapshot.isPending} onClick={() => rebuildSnapshot.mutate()}><RefreshCw size={15} /> 重建快照</Button>
            <Button loading={exportPool.isPending} onClick={() => exportPool.mutate()}><Download size={15} /> 导出筛选</Button>
            <Button loading={saveSubscription.isPending} onClick={() => saveSubscription.mutate()}><Layers3 size={15} /> 保存为订阅</Button>
            <Button onClick={() => setTombstonesOpen(true)}><Ban size={15} /> 墓碑</Button>
          </>
        }
      />

      <div className="caption">
        {tree.data?.snapshot?.generatedAt
          ? `池快照：${timeAgo(tree.data.snapshot.generatedAt)} · ${tree.data.snapshot.channels ?? 0} 个频道 · 订阅导出按此快照的池分类`
          : '池快照尚未生成：发布一次或点「重建快照」后生成'}
      </div>

      <Card className="pool-browse">
        <div className="pool-browse__head">
          <div>
            <div className="title-3">浏览线路</div>
            <div className="caption">按国家 / 地区或分组快速切换</div>
          </div>
          <Button size="sm" variant="ghost" onClick={clearFilters}>重置筛选</Button>
        </div>
        <div className="pool-browse__row">
          <span className="pool-browse__label">国家 / 地区</span>
          <div className="pool-browse__chips">
            <button className={!country ? 'chip chip--active' : 'chip'} onClick={() => selectCountry('')}>全部 <span>{(tree.data?.countries ?? []).reduce((sum, item) => sum + item.total, 0)}</span></button>
            {(tree.data?.countries ?? []).map((item) => (
              <button key={item.country} className={country === item.country ? 'chip chip--active' : 'chip'} onClick={() => selectCountry(item.country)}>
                {item.country} <span>{item.total}</span>
              </button>
            ))}
          </div>
        </div>
        {groups.length ? (
          <div className="pool-browse__row">
            <span className="pool-browse__label">分组</span>
            <div className="pool-browse__chips">
              <button className={!group ? 'chip chip--active' : 'chip'} onClick={() => selectGroup('')}>全部</button>
              {groups.map((item) => (
                <button key={item.group} className={group === item.group ? 'chip chip--active' : 'chip'} onClick={() => selectGroup(item.group)}>
                  {item.group} <span>{item.total}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="pool-filters">
        <div className="pool-filters__head">
          <div>
            <div className="title-3">筛选条件</div>
            <div className="caption">频道、订阅、来源、池、分辨率、传输和速度</div>
          </div>
          <Button size="sm" variant="ghost" onClick={clearFilters}>清空条件</Button>
        </div>
        <details open className="filter-details">
          <summary className="filter-summary">筛选条件</summary>
        <div className="pool-filter-grid">
          <label className="stack stack--tight grow">
            <span className="caption">频道</span>
            <input
              className="input"
              list="pool-channel-options"
              value={channelQuery}
              placeholder="输入频道名或 ID"
              onChange={(event) => {
                const value = event.target.value;
                setChannelQuery(value);
                const match = allChannels.find((channel) => channel.name === value || channel.id === value);
                setChannelId(match ? match.id : '');
                resetPage();
              }}
            />
            <datalist id="pool-channel-options">
              {allChannels.map((channel) => <option key={channel.id} value={channel.name}>{channel.group}</option>)}
            </datalist>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">按订阅</span>
            <select className="input" value={subscriptionId} onChange={(event) => { setSubscriptionId(event.target.value); resetPage(); }}>
              <option value="">全部订阅</option>
              {(subscriptions.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">来源站</span>
            <select className="input" value={sourceId} onChange={(event) => { setSourceId(event.target.value); resetPage(); }}>
              <option value="">全部来源</option>
              {(sources.data?.items ?? []).filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">池</span>
            <select className="input" value={pool} onChange={(event) => { setPool(event.target.value); resetPage(); }}>
              {POOLS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.value ? `${item.label} (${poolTotals[item.value as keyof PoolCounts] ?? 0})` : item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">分辨率 ≥</span>
            <select className="input" value={resolution} onChange={(event) => { setResolution(event.target.value); resetPage(); }}>
              <option value="">不限</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">2160p</option>
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">传输</span>
            <select className="input" value={transport} onChange={(event) => { setTransport(event.target.value); resetPage(); }}>
              <option value="">全部</option>
              <option value="direct">直连</option>
              <option value="relay">需中继</option>
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">最低速度 Mbps</span>
            <input className="input" inputMode="decimal" value={minSpeed} onChange={(event) => { setMinSpeed(event.target.value); resetPage(); }} placeholder="不限（如 2）" />
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">搜索</span>
            <input className="input" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder="频道 / 源 / URL" />
          </label>
        </div>
        </details>
      </Card>

      <div className="caption" style={{ padding: '0 2px' }}>
        待测 = 从未探测；候选 = 测活通过但质量待确认；精品 = 默认导出；备用 = 精品不足时补位；待复测 = 上次探测失败；已淘汰 = 连续失败。
      </div>

      <div className="row row--between pool-result-bar">
        <div className="caption"><Filter size={13} /> 共 {lines.data?.total ?? 0} 条线路</div>
        <label className="row" style={{ gap: 6 }}>
          <span className="caption">每页</span>
          <select className="input" style={{ width: 88 }} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
          </select>
          <span className="caption">第 {page} / {totalPages} 页</span>
        </label>
      </div>

      {selected.size ? (
        <Card className="pool-bulk">
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Badge tone="blue">已选 {selected.size} 条</Badge>
            <select className="input" style={{ maxWidth: 150 }} value={bulkPool} onChange={(event) => setBulkPool(event.target.value)}>
              {POOLS.filter((item) => item.value).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <Button
              loading={override.isPending}
              onClick={() => override.mutate({ keys: [...selected], pool: bulkPool })}
            >
              批量移动
            </Button>
            <Button loading={reset.isPending} variant="glass" onClick={() => reset.mutate([...selected])}>
              恢复自动
            </Button>
            <Button loading={reviveSelected.isPending} variant="glass" onClick={() => reviveSelected.mutate([...selected])}>
              复活
            </Button>
            <Button
              variant="danger"
              loading={deleteLines.isPending}
              onClick={() => {
                if (confirm(`删除 ${selected.size} 条线路？源刷新后可能回来；想永久阻止请用「墓碑」。`)) deleteLines.mutate([...selected]);
              }}
            >
              <Trash2 size={13} /> 删除
            </Button>
            <Button
              variant="danger"
              loading={tombstoneLines.isPending}
              onClick={() => {
                if (!confirm(`标记墓碑 ${selected.size} 条？删除后不会再从任何源导入。`)) return;
                const reason = window.prompt('墓碑原因（可选）') ?? undefined;
                tombstoneLines.mutate({ keys: [...selected], reason });
              }}
            >
              <Ban size={13} /> 墓碑
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
          </div>
        </Card>
      ) : null}

      {lines.isLoading ? (
        <div className="stack stack--tight">
          {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} height={58} radius={14} />)}
        </div>
      ) : lines.data?.items.length ? (
        <Card>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table table--cards pool-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={Boolean(lines.data?.items.length) && selected.size >= lines.data!.items.length}
                      onChange={(event) => {
                        if (event.target.checked) setSelected(new Set(lines.data?.items.map((line) => line.key) ?? []));
                        else setSelected(new Set());
                      }}
                    />
                  </th>
                  {sortHead('channel', '频道')}
                  {sortHead('source', '来源')}
                  {sortHead('resolution', '分辨率')}
                  {sortHead('speed', '速度')}
                  {sortHead('transport', '传输')}
                  {sortHead('pool', '池')}
                  {sortHead('status', '状态')}
                  {sortHead('probe', '检测')}
                </tr>
              </thead>
              <tbody>
                {lines.data.items.map((line) => (
                  <tr key={line.key} className={`pool-row pool-row--${statusTone(line.status)}`}>
                    <td data-label="选择">
                      <input
                        type="checkbox"
                        checked={selected.has(line.key)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(line.key);
                          else next.delete(line.key);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td data-label="频道">
                      <div className="truncate" style={{ maxWidth: 180 }}>{line.channelName}</div>
                      <div className="caption">{line.country} · {line.group}</div>
                    </td>
                    <td data-label="来源">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-start' }}>
                        <span className="truncate" style={{ maxWidth: 120 }}>{line.sourceName}</span>
                        <ReputationBadge score={line.sourceReputation} />
                      </div>
                      <div className="caption truncate" style={{ maxWidth: 170 }}>{line.name}</div>
                      {line.retained ? <Badge tone="orange">源已移除，保留中</Badge> : null}
                    </td>
                    <td data-label="分辨率">{formatResolution(line.resolution)}</td>
                    <td data-label="速度">{line.speedKbps ? formatSpeed(line.speedKbps) : '—'}</td>
                    <td data-label="传输"><Badge tone={line.transport === 'direct' ? 'green' : 'orange'}>{line.transport === 'direct' ? '直连' : '需中继'}</Badge></td>
                    <td data-label="池">
                      <select
                        className="input"
                        style={{ minWidth: 105, padding: '4px 6px' }}
                        value={line.pool}
                        disabled={override.isPending}
                        onChange={(event) => {
                          const next = event.target.value;
                          if (next === 'rejected' && !confirm('标记淘汰会从订阅中移除，确定？')) return;
                          override.mutate({ keys: [line.key], pool: next });
                        }}
                      >
                        {POOLS.filter((item) => item.value).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                      {line.promoted ? <div className="caption" style={{ color: 'var(--green)', marginTop: 4 }}>自动晋升</div> : null}
                      {line.overridden ? (
                        <button
                          type="button"
                          className="caption"
                          title={`自动池：${POOL_LABEL[line.autoPool] ?? line.autoPool}，点击恢复`}
                          onClick={() => reset.mutate([line.key])}
                          style={{ display: 'block', marginTop: 4, color: 'var(--blue)' }}
                        >
                          <RotateCcw size={11} /> 恢复自动
                        </button>
                      ) : null}
                    </td>
                    <td data-label="状态">
                      <div className="row" style={{ justifyContent: 'flex-start', gap: 6 }}>
                        <Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={line.favorite ? '取消收藏' : '收藏这条线路'}
                          loading={favorite.isPending}
                          onClick={() => favorite.mutate({ key: line.key, value: !line.favorite })}
                        >
                          <Star size={14} fill={line.favorite ? 'currentColor' : 'none'} color={line.favorite ? 'var(--orange)' : undefined} />
                        </Button>
                      </div>
                    </td>
                    <td data-label="检测" className="caption">{line.lastProbeAt ? `${timeAgo(line.lastProbeAt)} · ${line.passCount ?? 0} 次通过` : '未测'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </Card>
      ) : (
        <EmptyState icon={<Layers3 size={24} />} title="没有符合条件的线路" description="换个分组、池类型或降低筛选条件试试。" />
      )}

      <Sheet open={tombstonesOpen} onClose={() => setTombstonesOpen(false)} title="已墓碑线路" subtitle={`${tombstones.data?.items.length ?? 0} 条永久不再导入`}>
        <div className="stack">
          <div className="sheet-section">墓碑记录</div>
          {tombstones.data?.items.length ? (
            tombstones.data.items.map((item) => (
              <div key={item.url} className="tombstone-item">
                <span className="tombstone-item__icon"><Ban size={15} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">{item.url}</div>
                  <div className="caption">{item.channel_id ?? '未知频道'} · {item.reason || '无原因'} · {item.created_at}</div>
                </div>
                <Button size="sm" variant="glass" loading={untombstone.isPending} onClick={() => untombstone.mutate([item.url])}>
                  解除
                </Button>
              </div>
            ))
          ) : (
            <div className="task-empty">还没有墓碑记录</div>
          )}
        </div>
      </Sheet>
    </div>
  );
}
