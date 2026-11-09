import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, RefreshCw, SlidersHorizontal, Trash2, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminChannel, SubscriptionItem } from '../../lib/types';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, Card, CopyField, EmptyState, Field, Sheet, Switch, useToast } from '../../components/ui';

const FORMATS = ['m3u', 'txt', 'json', 'diyp'];

function displayLineLimit(subscriptionLimit: number): string {
  return subscriptionLimit > 0 ? String(subscriptionLimit) : '不限';
}

const RESOLUTIONS = ['any', '720p', '1080p', '1440p', '2160p'];

interface FormState {
  name: string;
  groups: string;
  excludeGroups: string;
  poolMode: string;
  poolIds: string[];
  filterMode: string;
  proxyMode: string;
  minResolution: string;
  minSpeedKbps: string;
  maxLines: string;
  format: string;
  showRegionSuffix: boolean;
  includeEpg: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '我的订阅',
  groups: '',
  excludeGroups: '',
  poolMode: 'premium',
  poolIds: [],
  filterMode: 'inherit',
  proxyMode: 'direct',
  minResolution: 'any',
  minSpeedKbps: '0',
  maxLines: '0',
  format: 'm3u',
  showRegionSuffix: true,
  includeEpg: true,
  enabled: true,
};

interface DeviceToken {
  token: string;
  label: string;
  enabled: number;
  last_seen_at: string | null;
  created_at: string;
}

export function SubscriptionsAdmin() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [channelSearch, setChannelSearch] = useState('');
  const [preview, setPreview] = useState<{ name: string; body: string; format: string; channels?: number; lines?: number } | null>(null);
  const [exportLimit, setExportLimit] = useState('0');
  const [frontLimit, setFrontLimit] = useState('0');
  const [maxPerSource, setMaxPerSource] = useState('0');
  const [devices, setDevices] = useState<DeviceToken[]>([]);
  const [deviceSummary, setDeviceSummary] = useState<{ total: number; enabled: number; active24h: number; active7d: number } | null>(null);
  const [deviceLabel, setDeviceLabel] = useState('');

  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: { maxLinesPerChannel: number; frontLineLimit: number; maxLinesPerSource: number } }>('/api/admin/settings'),
  });

  const usageQuery = useQuery({
    queryKey: ['admin', 'subscription-usage', editing?.id],
    queryFn: () =>
      api.get<{ items: Array<{ token: string; label: string | null; day: string; requests: number; bytes: number }> }>(
        `/api/admin/subscriptions/${editing!.id}/usage?days=7`,
      ),
    enabled: Boolean(editing?.id),
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setExportLimit(String(settingsQuery.data.settings.maxLinesPerChannel ?? 0));
    setFrontLimit(String(settingsQuery.data.settings.frontLineLimit ?? 0));
    setMaxPerSource(String(settingsQuery.data.settings.maxLinesPerSource ?? 0));
  }, [settingsQuery.data]);

  const reloadDevices = async (id: string) => {
    try {
      const result = await api.get<{ items: DeviceToken[]; summary?: { total: number; enabled: number; active24h: number; active7d: number } }>(`/api/admin/subscriptions/${id}/tokens`);
      setDevices(result.items);
      setDeviceSummary(result.summary ?? null);
    } catch {
      setDevices([]);
      setDeviceSummary(null);
    }
  };

  useEffect(() => {
    if (!editing?.id) {
      setDevices([]);
      return;
    }
    void reloadDevices(editing.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const saveLimits = useMutation({
    mutationFn: () => api.put('/api/admin/settings', {
      maxLinesPerChannel: Math.max(0, Number(exportLimit) || 0),
      frontLineLimit: Math.max(0, Number(frontLimit) || 0),
      maxLinesPerSource: Math.max(0, Number(maxPerSource) || 0),
    }),
    onSuccess: () => {
      show('线路显示与导出上限已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'subscriptions'],
    queryFn: () => api.get<{ items: SubscriptionItem[] }>('/api/admin/subscriptions'),
  });

  const customPools = useQuery({
    queryKey: ['admin', 'custom-pools'],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string; count: number }> }>('/api/admin/pool/pools'),
    enabled: open,
  });

  const channelList = useQuery({
    queryKey: ['admin', 'channels', 'picker'],
    queryFn: () => api.get<{ items: AdminChannel[] }>('/api/admin/channels'),
    enabled: open,
  });

  const filteredChannels = (channelList.data?.items ?? [])
    .filter((channel) => {
      const keyword = channelSearch.trim().toLowerCase();
      if (!keyword) return true;
      return channel.name.toLowerCase().includes(keyword) || channel.id.includes(keyword) || channel.group.toLowerCase().includes(keyword);
    })
    .slice(0, 40);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        groups: split(form.groups),
        excludeGroups: split(form.excludeGroups),
        channelIds,
        poolMode: form.poolMode,
        poolIds: form.poolIds,
        filterMode: form.filterMode,
        proxyMode: form.proxyMode,
        minResolution: form.minResolution,
        minSpeedKbps: Number(form.minSpeedKbps || 0),
        maxLinesPerChannel: Math.max(0, Number(form.maxLines) || 0),
        format: form.format,
        showRegionSuffix: form.showRegionSuffix,
        includeEpg: form.includeEpg,
        enabled: form.enabled,
      };
      if (form.poolMode === 'pools' && !form.poolIds.length) throw new Error('选池导出至少要选择一个池');
      if (editing) return api.patch(`/api/admin/subscriptions/${editing.id}`, payload);
      return api.post('/api/admin/subscriptions', payload);
    },
    onSuccess: () => {
      show(editing ? '已更新' : '已创建');
      setOpen(false);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/subscriptions/${id}/rotate`),
    onSuccess: () => {
      show('令牌已轮换，旧链接立即失效');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/subscriptions/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] }),
  });

  const addDevice = useMutation({
    mutationFn: () => api.post<{ token: DeviceToken }>(`/api/admin/subscriptions/${editing!.id}/tokens`, { label: deviceLabel }),
    onSuccess: () => {
      setDeviceLabel('');
      show('已添加设备令牌');
      if (editing?.id) void reloadDevices(editing.id);
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggleDevice = useMutation({
    mutationFn: (device: DeviceToken) => api.patch(`/api/admin/subscriptions/${editing!.id}/tokens/${device.token}`, { enabled: device.enabled !== 1 }),
    onSuccess: () => { if (editing?.id) void reloadDevices(editing.id); },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const removeDevice = useMutation({
    mutationFn: (device: DeviceToken) => api.del(`/api/admin/subscriptions/${editing!.id}/tokens/${device.token}`),
    onSuccess: () => { if (editing?.id) void reloadDevices(editing.id); },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const restoreAllLines = useMutation({
    mutationFn: (id: string) => api.patch(`/api/admin/subscriptions/${id}`, { maxLinesPerChannel: 0 }),
    onSuccess: () => {
      show('已恢复每频道全部线路，请重新导入播放器');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  async function loadPreview(item: SubscriptionItem): Promise<void> {
    try {
      const result = await api.get<{ preview: string; format: string; channels?: number; lines?: number }>(`/api/admin/subscriptions/${item.id}/preview?format=${item.format}`);
      setPreview({ name: item.name, body: result.preview, format: result.format, channels: result.channels, lines: result.lines });
      show(`实际导出：${result.channels ?? '—'} 个频道 · ${result.lines ?? '—'} 条线路`);
    } catch (error) {
      show(error instanceof Error ? error.message : '预览失败', 'error');
    }
  }

  function openEdit(item?: SubscriptionItem): void {
    setEditing(item ?? null);
    setChannelIds(item?.channelIds ?? []);
    setChannelSearch('');
    setForm(
      item
        ? {
            name: item.name,
            groups: item.groups.join(', '),
            excludeGroups: item.excludeGroups.join(', '),
            poolMode: item.pool_mode ?? 'premium',
            poolIds: item.poolIds ?? (item.pool_ids ? JSON.parse(item.pool_ids) as string[] : []),
            filterMode: item.filter_mode ?? 'inherit',
            proxyMode: item.proxy_mode ?? 'direct',
            minResolution: item.min_resolution,
            minSpeedKbps: String(item.min_speed_kbps),
            maxLines: String(item.max_lines_per_channel),
            format: item.format,
            showRegionSuffix: item.showRegionSuffix,
            includeEpg: item.includeEpg,
            enabled: item.enabled,
          }
        : EMPTY_FORM,
    );
    setOpen(true);
  }

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="SUBSCRIPTIONS"
        title="订阅与导出"
        description="同一份聚合结果，按过滤器生成 M3U / TXT / JSON / DIYP 出口。"
        actions={<Button variant="primary" onClick={() => openEdit()}><Plus size={16} /> 新建订阅</Button>}
      />

      <Card className="subscription-limits">
        <div className="subscription-limits__head">
          <span className="subscription-limits__icon"><SlidersHorizontal size={17} /></span>
          <div>
            <div className="title-3">线路显示与导出上限</div>
            <div className="caption">控制每个频道写入播放器的线路数量</div>
          </div>
        </div>
        <div className="row row--wrap" style={{ marginTop: 10 }}>
          <div className="grow">
            <Field label="播放器导出行数" hint="每个频道最多写入订阅几条线路；0 = 不限制">
              <input className="input" inputMode="numeric" value={exportLimit} onChange={(event) => setExportLimit(event.target.value)} />
            </Field>
          </div>
          <div className="grow">
            <Field label="前台默认显示行数" hint="频道详情页默认展示几条；0 = 全部显示">
              <input className="input" inputMode="numeric" value={frontLimit} onChange={(event) => setFrontLimit(event.target.value)} />
            </Field>
          </div>
          <div className="grow">
            <Field label="同源最多线路" hint="同一采集站在一个频道最多几条；0 = 不限制">
              <input className="input" inputMode="numeric" value={maxPerSource} onChange={(event) => setMaxPerSource(event.target.value)} />
            </Field>
          </div>
          <div style={{ alignSelf: 'center' }}>
            <Button variant="primary" loading={saveLimits.isPending} onClick={() => saveLimits.mutate()}>保存上限</Button>
          </div>
        </div>
        <div className="caption" style={{ marginTop: 8 }}>
          当前 {settingsQuery.data ? `播放器 ${displayLineLimit(settingsQuery.data.settings.maxLinesPerChannel)} / 前台 ${displayLineLimit(settingsQuery.data.settings.frontLineLimit)} / 单源 ${displayLineLimit(settingsQuery.data.settings.maxLinesPerSource)}` : '加载中'}。0 表示不限制；修改后需要重新发布订阅生效。
        </div>
      </Card>

      {isLoading ? <Card><div className="caption">加载中…</div></Card> : null}

      {!isLoading && !data?.items.length ? (
        <EmptyState
          icon={<Link2 size={24} />}
          title="还没有订阅出口"
          description="创建一个订阅后即可获得带 token 的播放列表地址，可直接添加到播放器，或作为节目单源。"
          action={<Button variant="primary" onClick={() => openEdit()}>创建订阅</Button>}
        />
      ) : null}

      <div className="subscription-grid">
        {(data?.items ?? []).map((item) => (
          <Card className="subscription-card" key={item.id}>
            <div className="subscription-card__head">
              <span className="subscription-card__icon"><Link2 size={17} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="subscription-card__name">{item.name}</span>
                  <Badge tone="blue">{item.format.toUpperCase()}</Badge>
                </div>
                <div className="row row--wrap" style={{ gap: 5, marginTop: 6 }}>
                  {item.pool_mode === 'custom' ? <Badge>自定义线路</Badge> : item.pool_mode === 'pools' ? <Badge tone="blue">选池导出</Badge> : item.pool_mode === 'all' ? <Badge tone="blue">全部可用</Badge> : item.pool_mode === 'premium_backup' ? <Badge tone="orange">精品 + 备用</Badge> : <Badge tone="green">精品池</Badge>}
                  {item.min_resolution !== 'any' ? <Badge>≥ {item.min_resolution}</Badge> : null}
                  {item.min_speed_kbps ? <Badge>≥ {item.min_speed_kbps} kbps</Badge> : null}
                </div>
              </div>
              <div className="subscription-card__switch">
                <span className="caption">{item.enabled ? '启用' : '停用'}</span>
                <Switch checked={item.enabled} onChange={() => void api.patch(`/api/admin/subscriptions/${item.id}`, { enabled: !item.enabled }).then(() => queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] }))} />
              </div>
            </div>

            <div className="subscription-filters">
              <span>分组：{item.groups.length ? item.groups.join(' / ') : '全部'}</span>
              {item.excludeGroups.length ? <span>排除：{item.excludeGroups.join(' / ')}</span> : null}
              {item.channelIds.length ? <span>指定频道：{item.channelIds.length} 个</span> : null}
              {item.protocols.length ? <span>协议：{item.protocols.join(' / ')}</span> : null}
            </div>

            <div className="subscription-stats">
              <div><strong>{item.matchedChannels ?? 0}</strong><span>匹配频道</span></div>
              <div><strong>{displayLineLimit(item.max_lines_per_channel)}</strong><span>每频道线路</span></div>
              <div><strong>{item.includeEpg ? '含' : '不含'}</strong><span>EPG</span></div>
              <div>
                <strong>{item.usage7d ? `${item.usage7d.requests}` : '—'}</strong>
                <span>7天中继请求{item.usage7d ? ` · ${(item.usage7d.bytes / 1024 / 1024).toFixed(1)}MB` : ''}</span>
              </div>
            </div>
            {item.max_lines_per_channel === 0 ? (
              <div className="subscription-warning">当前每频道输出全部线路。相同频道名下播放器会作为多线路频道处理，可在播放器内切换线路。</div>
            ) : (
              <div className="subscription-warning">
                <span>当前每频道最多只导出 {item.max_lines_per_channel} 条线路，实际导出会少于可用线路。</span>
                <Button size="sm" variant="ghost" loading={restoreAllLines.isPending} onClick={() => restoreAllLines.mutate(item.id)}>恢复全部线路</Button>
              </div>
            )}
            <div className="subscription-meta">
              更新于 {item.updated_at ? formatDateTime(item.updated_at) : '—'} · 令牌尾号 {item.token.slice(-6)}
            </div>

            <div className="subscription-links">
              <div className="caption">主播放列表</div>
              <CopyField value={item.links.m3u} />
              <div className="subscription-format-row">
                <span className="caption">复制格式</span>
                <div className="row row--wrap" style={{ gap: 5 }}>
                  {FORMATS.map((format) => (
                    <Button key={format} size="sm" onClick={() => navigator.clipboard.writeText(item.links[format]).then(() => show(`已复制 ${format.toUpperCase()}`))}>
                      {format.toUpperCase()}
                    </Button>
                  ))}
                  <Button size="sm" onClick={() => navigator.clipboard.writeText(item.links.epg).then(() => show('已复制 EPG 地址'))}>EPG</Button>
                  <Button size="sm" onClick={() => navigator.clipboard.writeText(item.links.tvbox).then(() => show('已复制 TVBox 配置'))}>TVBox</Button>
                </div>
              </div>
            </div>

            <div className="subscription-actions">
              <Button size="sm" onClick={() => void loadPreview(item)}><Wand2 size={13} /> 预览</Button>
              <Button size="sm" onClick={() => openEdit(item)}>编辑</Button>
              <Button size="sm" onClick={() => rotate.mutate(item.id)}><RefreshCw size={13} /> 轮换令牌</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (confirm('删除该订阅？')) remove.mutate(item.id); }}>
                <Trash2 size={13} /> 删除
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑订阅' : '新建订阅'}
        subtitle="过滤器在服务端实时生效，无需等待下一轮采集"
        footer={<Button block variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{editing ? '保存' : '创建'}</Button>}
      >
        <div className="stack">
          <div className="sheet-section">基础信息</div>
          <Field label="名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="包含分组" hint="留空表示全部；多个分组用逗号分隔，例如：央视, 卫视">
            <input className="input" value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="央视, 卫视" />
          </Field>
          <Field label="排除分组">
            <input className="input" value={form.excludeGroups} onChange={(event) => setForm({ ...form, excludeGroups: event.target.value })} placeholder="付费, 地方" />
          </Field>
          <div className="sheet-section">导出范围</div>
          <Field label="线路池模式" hint="精品池只导出精品线路；精品 + 备用在精品不足时用备用线路补位">
            <select className="select" value={form.poolMode} onChange={(event) => setForm({ ...form, poolMode: event.target.value })}>
              <option value="premium">精品池（仅质量确认）</option>
              <option value="premium_backup">精品 + 备用兜底</option>
              <option value="all">全部可用（含未确认分辨率）</option>
              <option value="pools">自定义池组合（选池合并导出）</option>
              {form.poolMode === 'custom' ? <option value="custom">自定义线路（来自线路池）</option> : null}
            </select>
          </Field>
          {form.poolMode === 'pools' ? (
            <>
              <Field label="选择池" hint="可任意组合内置池和自己创建的池；一个线路只导出一次">
                <div className="row row--wrap" style={{ gap: 6 }}>
                  {[
                    { id: 'premium', name: '精品池' },
                    { id: 'backup', name: '备用池' },
                    { id: 'candidate', name: '候选池' },
                    ...(customPools.data?.items ?? []).map((pool) => ({ id: pool.id, name: `${pool.name} (${pool.count})` })),
                  ].map((pool) => {
                    const active = form.poolIds.includes(pool.id);
                    return (
                      <button
                        key={pool.id}
                        type="button"
                        className={active ? 'chip chip--active' : 'chip'}
                        onClick={() => setForm({ ...form, poolIds: active ? form.poolIds.filter((id) => id !== pool.id) : [...form.poolIds, pool.id] })}
                      >
                        {pool.name}
                      </button>
                    );
                  })}
                  <Button size="sm" variant="glass" onClick={() => setForm({ ...form, poolIds: ['premium', 'backup', 'candidate', ...(customPools.data?.items ?? []).map((pool) => pool.id)] })}>全选</Button>
                  <Button size="sm" variant="glass" onClick={() => setForm({ ...form, poolIds: [] })}>清空</Button>
                </div>
              </Field>
              <Field label="过滤方式" hint="不过滤 = 池内每一线路原样导出；保留原过滤 = 使用下方频道/分组/画质条件">
                <select className="select" value={form.filterMode} onChange={(event) => setForm({ ...form, filterMode: event.target.value })}>
                  <option value="inherit">保留原过滤</option>
                  <option value="none">不过滤（池内全量导出）</option>
                  <option value="custom">自定义过滤（编辑下方条件）</option>
                </select>
              </Field>
            </>
          ) : null}
          <Field label="代理模式" hint="直连不经过服务器；仅清单只代理播放列表；全部中继会消耗 Worker 流量与请求额度">
            <select className="select" value={form.proxyMode} onChange={(event) => setForm({ ...form, proxyMode: event.target.value })}>
              <option value="direct">直连（默认）</option>
              <option value="playlist">仅清单代理</option>
              <option value="full">全部中继</option>
            </select>
          </Field>
          {editing?.id ? (
            <>
              <div className="sheet-section">设备令牌</div>
              <div className="caption">
                每个设备一个令牌；禁用某个设备不影响其它设备。
                {deviceSummary ? ` 共 ${deviceSummary.total} 个 · 启用 ${deviceSummary.enabled} · 24h 活跃 ${deviceSummary.active24h} · 7d 活跃 ${deviceSummary.active7d}` : ''}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {devices.map((device) => (
                  <div key={device.token} className="row row--between" style={{ alignItems: 'center', gap: 8 }}>
                    <div className="stack" style={{ gap: 2 }}>
                      <span>{device.label || '未命名设备'}</span>
                      <span className="caption mono">{device.token.slice(0, 6)}…{device.token.slice(-4)} · {device.enabled === 1 ? '启用' : '已禁用'} · {device.last_seen_at ? `最近 ${formatDateTime(device.last_seen_at)}` : '未使用'}</span>
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <Button size="sm" onClick={() => toggleDevice.mutate(device)}>{device.enabled === 1 ? '禁用' : '启用'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('删除该设备令牌？')) removeDevice.mutate(device); }}>删除</Button>
                    </div>
                  </div>
                ))}
                {!devices.length ? <span className="caption">还没有设备令牌。</span> : null}
              </div>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input className="input" value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} placeholder="设备名，例如 客厅电视" style={{ flex: 1 }} />
                <Button loading={addDevice.isPending} onClick={() => addDevice.mutate()}>添加设备</Button>
              </div>
              <div className="sheet-section">中继用量（近 7 天）</div>
              {usageQuery.data?.items.length ? (
                <table className="table">
                  <thead>
                    <tr><th>设备</th><th>日期</th><th>请求</th><th>流量</th></tr>
                  </thead>
                  <tbody>
                    {usageQuery.data.items.map((item) => (
                      <tr key={`${item.token}-${item.day}`}>
                        <td>{item.label || item.token.slice(0, 6)}</td>
                        <td className="mono">{item.day}</td>
                        <td>{item.requests}</td>
                        <td>{(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="caption">近 7 天没有中继请求；direct 模式不经过中继，不会产生用量。</div>
              )}
            </>
          ) : null}
          <Field label="指定频道（可选）" hint="不选 = 按分组导出；选了 = 只导出这些频道，和分组过滤同时生效">
            <input className="input" value={channelSearch} onChange={(event) => setChannelSearch(event.target.value)} placeholder="搜索频道名，勾选加入订阅" />
          </Field>
          {channelIds.length ? (
            <div className="row row--wrap">
              {channelIds.map((id) => {
                const found = channelList.data?.items.find((channel) => channel.id === id);
                return (
                  <button key={id} className="chip chip--active" onClick={() => setChannelIds(channelIds.filter((item) => item !== id))}>
                    {found?.name ?? id} <X size={12} />
                  </button>
                );
              })}
            </div>
          ) : null}
          {channelSearch.trim() ? (
            <div className="list" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {filteredChannels.map((channel) => {
                const selected = channelIds.includes(channel.id);
                return (
                  <button
                    key={channel.id}
                    className="list__row"
                    onClick={() => setChannelIds(selected ? channelIds.filter((item) => item !== channel.id) : [...channelIds, channel.id])}
                  >
                    <span className="grow">{channel.name}</span>
                    <Badge>{channel.group}</Badge>
                    <span className="caption">{selected ? '已选' : '添加'}</span>
                  </button>
                );
              })}
              {!filteredChannels.length ? <div className="caption" style={{ padding: 12 }}>没有匹配的频道</div> : null}
            </div>
          ) : null}
          <div className="sheet-section">画质与数量</div>
          <div className="form-grid">
            <Field label="最低分辨率">
              <select className="select" value={form.minResolution} onChange={(event) => setForm({ ...form, minResolution: event.target.value })}>
                {RESOLUTIONS.map((value) => <option key={value} value={value}>{value === 'any' ? '不限' : value}</option>)}
              </select>
            </Field>
            <Field label="最低速率 (kbps)">
              <input className="input" inputMode="numeric" value={form.minSpeedKbps} onChange={(event) => setForm({ ...form, minSpeedKbps: event.target.value })} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="每频道线路数" hint="0 = 导出全部线路；名称保持同名，播放器会作为多线路频道处理">
              <input className="input" inputMode="numeric" value={form.maxLines} onChange={(event) => setForm({ ...form, maxLines: event.target.value })} />
            </Field>
            <Field label="导出格式">
              <select className="select" value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}>
                {FORMATS.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
              </select>
            </Field>
          </div>
          <div className="sheet-section">输出选项</div>
          <div className="list">
            <div className="list__row"><span className="grow">M3U 头部写入 EPG 地址</span><Switch checked={form.includeEpg} onChange={(value) => setForm({ ...form, includeEpg: value })} /></div>
            <div className="list__row"><span className="grow">启用订阅</span><Switch checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} /></div>
          </div>
        </div>
      </Sheet>

      <Sheet open={Boolean(preview)} onClose={() => setPreview(null)} title={`预览 · ${preview?.name ?? ''}`} subtitle={`${preview?.format?.toUpperCase()} · ${preview?.channels ?? '—'} 频道 · ${preview?.lines ?? '—'} 线路 · 前 4 万字符`}>
        <pre className="code">{preview?.body}</pre>
      </Sheet>
    </div>
  );
}

function split(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}
