import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, RefreshCw, Trash2, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminChannel, SubscriptionItem } from '../../lib/types';
import { Badge, Button, Card, CopyField, EmptyState, Field, Sheet, Switch, useToast } from '../../components/ui';

const FORMATS = ['m3u', 'txt', 'json', 'diyp'];
const RESOLUTIONS = ['any', '720p', '1080p', '1440p', '2160p'];

interface FormState {
  name: string;
  groups: string;
  excludeGroups: string;
  poolMode: string;
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
  minResolution: 'any',
  minSpeedKbps: '0',
  maxLines: '0',
  format: 'm3u',
  showRegionSuffix: true,
  includeEpg: true,
  enabled: true,
};

export function SubscriptionsAdmin() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [channelSearch, setChannelSearch] = useState('');
  const [preview, setPreview] = useState<{ name: string; body: string; format: string } | null>(null);
  const [exportLimit, setExportLimit] = useState('0');
  const [frontLimit, setFrontLimit] = useState('0');
  const [maxPerSource, setMaxPerSource] = useState('0');

  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: { maxLinesPerChannel: number; frontLineLimit: number; maxLinesPerSource: number } }>('/api/admin/settings'),
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setExportLimit(String(settingsQuery.data.settings.maxLinesPerChannel ?? 0));
    setFrontLimit(String(settingsQuery.data.settings.frontLineLimit ?? 0));
    setMaxPerSource(String(settingsQuery.data.settings.maxLinesPerSource ?? 0));
  }, [settingsQuery.data]);

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
        minResolution: form.minResolution,
        minSpeedKbps: Number(form.minSpeedKbps || 0),
        maxLinesPerChannel: Math.max(0, Number(form.maxLines) || 0),
        format: form.format,
        showRegionSuffix: form.showRegionSuffix,
        includeEpg: form.includeEpg,
        enabled: form.enabled,
      };
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

  async function loadPreview(item: SubscriptionItem): Promise<void> {
    try {
      const result = await api.get<{ preview: string; format: string }>(`/api/admin/subscriptions/${item.id}/preview?format=${item.format}`);
      setPreview({ name: item.name, body: result.preview, format: result.format });
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
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">订阅与导出</h1>
          <p className="subhead" style={{ marginTop: 4 }}>同一份聚合结果，按过滤器生成 M3U / TXT / JSON / DIYP 出口。</p>
        </div>
        <Button variant="primary" onClick={() => openEdit()}><Plus size={16} /> 新建订阅</Button>
      </div>

      <Card>
        <div className="title-3">线路显示与导出上限</div>
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
          <div style={{ alignSelf: 'flex-end' }}>
            <Button variant="primary" loading={saveLimits.isPending} onClick={() => saveLimits.mutate()}>保存上限</Button>
          </div>
        </div>
        <div className="caption" style={{ marginTop: 8 }}>
          当前 {settingsQuery.data ? `播放器 ${settingsQuery.data.settings.maxLinesPerChannel} 条 / 前台 ${settingsQuery.data.settings.frontLineLimit} 条 / 单源 ${settingsQuery.data.settings.maxLinesPerSource} 条` : '加载中'}。0 表示不限制；修改后需要重新发布订阅生效。
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

      <div className="stack">
        {(data?.items ?? []).map((item) => (
          <Card key={item.id}>
            <div className="row row--between" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="title-3">{item.name}</span>
                  <Badge tone="blue">{item.format.toUpperCase()}</Badge>
                  {item.pool_mode === 'custom' ? <Badge>自定义线路</Badge> : item.pool_mode === 'premium_backup' ? <Badge tone="orange">精品 + 备用</Badge> : <Badge tone="green">精品池</Badge>}
                  {item.min_resolution !== 'any' ? <Badge>≥ {item.min_resolution}</Badge> : null}
                  {item.min_speed_kbps ? <Badge>≥ {item.min_speed_kbps} kbps</Badge> : null}
                  {item.enabled ? <Badge tone="green">启用</Badge> : <Badge tone="red">停用</Badge>}
                </div>
                <div className="caption" style={{ marginTop: 4 }}>
                  匹配 {item.matchedChannels ?? 0} 个频道 · 每组最多 {item.max_lines_per_channel} 条 · {item.includeEpg ? '含 EPG' : '不含 EPG'}
                </div>
              </div>
              <Switch checked={item.enabled} onChange={() => void api.patch(`/api/admin/subscriptions/${item.id}`, { enabled: !item.enabled }).then(() => queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] }))} />
            </div>

            <div className="stack stack--tight" style={{ marginTop: 12 }}>
              <CopyField value={item.links.m3u} />
              <div className="row row--wrap" style={{ gap: 6 }}>
                {FORMATS.map((format) => (
                  <Button key={format} size="sm" onClick={() => navigator.clipboard.writeText(item.links[format]).then(() => show(`已复制 ${format.toUpperCase()}`))}>
                    {format.toUpperCase()}
                  </Button>
                ))}
                <Button size="sm" onClick={() => navigator.clipboard.writeText(item.links.epg).then(() => show('已复制 EPG 地址'))}>EPG</Button>
                <Button size="sm" onClick={() => navigator.clipboard.writeText(item.links.tvbox).then(() => show('已复制 TVBox 配置'))}>TVBox</Button>
              </div>
            </div>

            <div className="row row--wrap" style={{ marginTop: 12, gap: 6 }}>
              <Button size="sm" onClick={() => void loadPreview(item)}><Wand2 size={13} /> 预览</Button>
              <Button size="sm" onClick={() => openEdit(item)}>编辑</Button>
              <Button size="sm" onClick={() => rotate.mutate(item.id)}><RefreshCw size={13} /> 轮换令牌</Button>
              <Button size="sm" variant="danger" onClick={() => { if (confirm('删除该订阅？')) remove.mutate(item.id); }}>
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
          <Field label="名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="包含分组" hint="留空表示全部；多个分组用逗号分隔，例如：央视, 卫视">
            <input className="input" value={form.groups} onChange={(event) => setForm({ ...form, groups: event.target.value })} placeholder="央视, 卫视" />
          </Field>
          <Field label="排除分组">
            <input className="input" value={form.excludeGroups} onChange={(event) => setForm({ ...form, excludeGroups: event.target.value })} placeholder="付费, 地方" />
          </Field>
          <Field label="线路池模式" hint="精品池只导出精品线路；精品 + 备用在精品不足时用备用线路补位">
            <select className="select" value={form.poolMode} onChange={(event) => setForm({ ...form, poolMode: event.target.value })}>
              <option value="premium">精品池</option>
              <option value="premium_backup">精品 + 备用兜底</option>
              {form.poolMode === 'custom' ? <option value="custom">自定义线路（来自线路池）</option> : null}
            </select>
          </Field>
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
          <div className="row">
            <div className="grow">
              <Field label="最低分辨率">
                <select className="select" value={form.minResolution} onChange={(event) => setForm({ ...form, minResolution: event.target.value })}>
                  {RESOLUTIONS.map((value) => <option key={value} value={value}>{value === 'any' ? '不限' : value}</option>)}
                </select>
              </Field>
            </div>
            <div className="grow">
              <Field label="最低速率 (kbps)">
                <input className="input" inputMode="numeric" value={form.minSpeedKbps} onChange={(event) => setForm({ ...form, minSpeedKbps: event.target.value })} />
              </Field>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <Field label="每频道线路数" hint="0 = 导出全部可用线路">
                <input className="input" inputMode="numeric" value={form.maxLines} onChange={(event) => setForm({ ...form, maxLines: event.target.value })} />
              </Field>
            </div>
            <div className="grow">
              <Field label="导出格式">
                <select className="select" value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}>
                  {FORMATS.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <div className="list">
            <div className="list__row"><span className="grow">线路名带地区后缀</span><Switch checked={form.showRegionSuffix} onChange={(value) => setForm({ ...form, showRegionSuffix: value })} /></div>
            <div className="list__row"><span className="grow">M3U 头部写入 EPG 地址</span><Switch checked={form.includeEpg} onChange={(value) => setForm({ ...form, includeEpg: value })} /></div>
            <div className="list__row"><span className="grow">启用订阅</span><Switch checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} /></div>
          </div>
        </div>
      </Sheet>

      <Sheet open={Boolean(preview)} onClose={() => setPreview(null)} title={`预览 · ${preview?.name ?? ''}`} subtitle={`${preview?.format?.toUpperCase()} · 前 4 万字符`}>
        <pre className="code">{preview?.body}</pre>
      </Sheet>
    </div>
  );
}

function split(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}
