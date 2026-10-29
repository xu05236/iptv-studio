import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Filter, Layers3, RefreshCw, RotateCcw } from 'lucide-react';
import { api, getToken } from '../../lib/api';
import { formatResolution, formatSpeed, statusLabel, statusTone } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Pagination, Skeleton, useToast } from '../../components/ui';
import { timeAgo } from '../../lib/format';

const DEFAULT_PAGE_SIZE = 10;
const POOLS = [
  { value: '', label: '全部池' },
  { value: 'premium', label: '精品池' },
  { value: 'backup', label: '备用池' },
  { value: 'pending', label: '待测池' },
  { value: 'quarantine', label: '待复测' },
  { value: 'rejected', label: '已淘汰' },
];
const POOL_LABEL: Record<string, string> = Object.fromEntries(POOLS.map((item) => [item.value, item.label]));

interface PoolCounts {
  premium: number;
  backup: number;
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
  name: string;
  url: string;
  resolution?: string;
  height?: number;
  speedKbps?: number;
  protocol: string;
  transport: 'direct' | 'relay';
  pool: keyof PoolCounts;
  autoPool: keyof PoolCounts;
  overridden: boolean;
  promoted?: boolean;
  reason?: string;
  status: string;
  score: number;
  passCount?: number;
  lastProbeAt?: string;
}

function poolTone(pool: string): 'green' | 'blue' | 'orange' | 'red' | undefined {
  if (pool === 'premium') return 'green';
  if (pool === 'backup') return 'blue';
  if (pool === 'rejected') return 'red';
  if (pool === 'pending' || pool === 'quarantine') return 'orange';
  return undefined;
}

export function Pool() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPool, setBulkPool] = useState('backup');  const [country, setCountry] = useState('');
  const [group, setGroup] = useState('');
  const [channelId, setChannelId] = useState('');
  const [pool, setPool] = useState('');
  const [transport, setTransport] = useState('');
  const [resolution, setResolution] = useState('');
  const [minSpeed, setMinSpeed] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const tree = useQuery({
    queryKey: ['admin', 'pool', 'tree'],
    queryFn: () => api.get<{ countries: PoolTreeCountry[] }>('/api/admin/pool/tree'),
  });

  const countryItem = tree.data?.countries.find((item) => item.country === country);
  const groups = countryItem?.groups ?? [];
  const groupItem = groups.find((item) => item.group === group);
  const channels = groupItem?.channels ?? [];

  const params = useMemo(() => {
    const value = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (country) value.set('country', country);
    if (group) value.set('group', group);
    if (channelId) value.set('channelId', channelId);
    if (pool) value.set('pool', pool);
    if (transport) value.set('transport', transport);
    if (resolution) value.set('resolution', resolution);
    if (minSpeed) value.set('minSpeed', minSpeed);
    if (search.trim()) value.set('q', search.trim());
    return value.toString();
  }, [country, group, channelId, pool, transport, resolution, minSpeed, search, page, pageSize]);

  const lines = useQuery({
    queryKey: ['admin', 'pool', 'lines', params],
    queryFn: () => api.get<{ items: PoolLine[]; total: number; page: number; limit: number }>(`/api/admin/pool/lines?${params}`),
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(1, Math.ceil((lines.data?.total ?? 0) / pageSize));

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

  const reset = useMutation({
    mutationFn: (keys: string[]) => api.post<{ removed: number }>('/api/admin/pool/reset', { keys }),
    onSuccess: (result) => {
      show(`已恢复 ${result.removed} 条线路为自动池`);
      setSelected(new Set());
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
          pool,
          transport,
          resolution,
          minSpeed,
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

  const saveSubscription = useMutation({
    mutationFn: () => {
      const name = window.prompt('订阅名称', `线路池订阅 ${new Date().toISOString().slice(0, 10)}`);
      if (!name?.trim()) throw new Error('已取消');
      return api.post<{ id: string; token: string; lines: number }>('/api/admin/pool/subscription', {
        name: name.trim(),
        country,
        group,
        channelId,
        pool,
        transport,
        resolution,
        minSpeed,
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
    resetPage();
  }

  function selectGroup(value: string): void {
    setGroup(value);
    setChannelId('');
    resetPage();
  }

  if (tree.isLoading) {
    return <div className="stack"><Skeleton height={34} width={220} /><Skeleton height={240} radius={16} /></div>;
  }

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">线路池</h1>
          <p className="subhead" style={{ marginTop: 4 }}>
            按现有国家 / 分组 / 频道查看线路；只读预览，移动和删除操作下一阶段开放。
          </p>
        </div>
        <Button loading={tree.isFetching || lines.isFetching} onClick={() => { void tree.refetch(); void lines.refetch(); }}>
          <RefreshCw size={15} /> 刷新
        </Button>
        <Button loading={exportPool.isPending} onClick={() => exportPool.mutate()}>
          <Download size={15} /> 导出当前筛选
        </Button>
        <Button loading={saveSubscription.isPending} onClick={() => saveSubscription.mutate()}>
          <Layers3 size={15} /> 保存为订阅
        </Button>
      </div>

      <div className="row row--wrap" style={{ gap: 6 }}>
        {(tree.data?.countries ?? []).map((item) => (
          <button key={item.country} className={country === item.country ? 'chip chip--active' : 'chip'} onClick={() => selectCountry(item.country)}>
            {item.country} {item.total}
          </button>
        ))}
      </div>

      {groups.length ? (
        <div className="row row--wrap" style={{ gap: 6 }}>
          {groups.map((item) => (
            <button key={item.group} className={group === item.group ? 'chip chip--active' : 'chip'} onClick={() => selectGroup(item.group)}>
              {item.group} {item.total}
            </button>
          ))}
        </div>
      ) : null}

      <Card>
        <div className="row row--wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="stack stack--tight grow">
            <span className="caption">频道</span>
            <select className="input" value={channelId} onChange={(event) => { setChannelId(event.target.value); resetPage(); }}>
              <option value="">全部频道</option>
              {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name} ({Object.values(channel.counts).reduce((a, b) => a + b, 0)})</option>)}
            </select>
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">池</span>
            <select className="input" value={pool} onChange={(event) => { setPool(event.target.value); resetPage(); }}>
              {POOLS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
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
            <span className="caption">最低速度 Kbps</span>
            <input className="input" inputMode="numeric" value={minSpeed} onChange={(event) => { setMinSpeed(event.target.value); resetPage(); }} placeholder="不限" />
          </label>
          <label className="stack stack--tight grow">
            <span className="caption">搜索</span>
            <input className="input" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder="频道 / 源 / URL" />
          </label>
        </div>
      </Card>

      <div className="row row--between">
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
        <Card>
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="caption">已选 {selected.size} 条</span>
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
            <table className="table" style={{ minWidth: 900 }}>
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
                  <th>频道</th>
                  <th>来源</th>
                  <th>分辨率</th>
                  <th>速度</th>
                  <th>传输</th>
                  <th>池</th>
                  <th>状态</th>
                  <th>检测</th>
                </tr>
              </thead>
              <tbody>
                {lines.data.items.map((line) => (
                  <tr key={line.key}>
                    <td>
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
                    <td>
                      <div className="truncate" style={{ maxWidth: 180 }}>{line.channelName}</div>
                      <div className="caption">{line.country} · {line.group}</div>
                    </td>
                    <td>
                      <div className="truncate" style={{ maxWidth: 170 }}>{line.sourceName}</div>
                      <div className="caption truncate" style={{ maxWidth: 170 }}>{line.name}</div>
                    </td>
                    <td>{formatResolution(line.resolution)}</td>
                    <td>{line.speedKbps ? formatSpeed(line.speedKbps) : '—'}</td>
                    <td><Badge tone={line.transport === 'direct' ? 'green' : 'orange'}>{line.transport === 'direct' ? '直连' : '需中继'}</Badge></td>
                    <td>
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
                    <td><Badge tone={statusTone(line.status)}>{statusLabel(line.status)}</Badge></td>
                    <td className="caption">{line.lastProbeAt ? `${timeAgo(line.lastProbeAt)} · ${line.passCount ?? 0} 次通过` : '未测'}</td>
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
    </div>
  );
}
