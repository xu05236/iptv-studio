import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, Pencil, Search, Tag, Tv, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdminChannel } from '../../lib/types';
import { formatResolution, formatSpeed } from '../../lib/format';
import { Badge, Button, Card, Field, Sheet, Switch, useToast } from '../../components/ui';

export function ChannelsAdmin() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminChannel | null>(null);
  const [form, setForm] = useState({ name: '', group: '', tvgId: '', logo: '' });
  const [aliasChannel, setAliasChannel] = useState<AdminChannel | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'channels'],
    queryFn: () => api.get<{ items: AdminChannel[] }>('/api/admin/channels'),
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

  const items = useMemo(() => {
    const list = data?.items ?? [];
    const keyword = search.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter((item) => item.name.toLowerCase().includes(keyword) || item.id.includes(keyword) || (item.tvgId ?? '').toLowerCase().includes(keyword));
  }, [data, search]);

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
          <Button loading={cleanupNames.isPending} onClick={() => cleanupNames.mutate()}>
            <Eraser size={15} /> 清理名称
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

      {isLoading ? <Card><div className="caption">加载中…</div></Card> : null}

      <div className="list">
        {items.slice(0, 300).map((channel) => (
          <div key={channel.id} className="list__row">
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
        {!isLoading && !items.length ? (
          <div className="caption" style={{ padding: 16 }}><Tv size={14} /> 还没有频道，先运行一次采集。</div>
        ) : null}
      </div>

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
    </div>
  );
}
