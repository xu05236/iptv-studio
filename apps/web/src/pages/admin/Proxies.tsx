import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Globe2, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import type { AppSettings, ProxyNode } from '@iptv/core';
import { api } from '../../lib/api';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { Badge, Button, EmptyState, Field, QueryError, Sheet, Switch, useToast } from '../../components/ui';
import { timeAgo } from '../../lib/format';

interface ProxyList {
  items: ProxyNode[];
  currentId?: string | null;
}

type ProxySort = 'default' | 'latency' | 'success' | 'recent' | 'name';

const PROTOCOLS = ['http', 'https', 'socks5', 'socks5h', 'vmess', 'vless', 'trojan', 'hysteria2', 'ss', 'anytls', 'tuic'];

// Frequently seen client UAs; some subscription servers only answer known apps.
const UA_PRESETS = [
  { label: 'Clash for Android', value: 'ClashForAndroid/2.5.12' },
  { label: 'Clash Meta for Android', value: 'ClashMetaForAndroid/2.11.6.Meta' },
  { label: 'v2rayNG', value: 'v2rayNG/1.9.16' },
  { label: 'NekoBox', value: 'NekoBox/1.3.2' },
  { label: 'Surfboard', value: 'Surfboard/2.30.0' },
  { label: 'Clash Verge Rev（桌面）', value: 'clash-verge/v2.0.3' },
];

function statusOf(node: ProxyNode): { label: string; tone: 'green' | 'orange' | 'default' | 'blue' } {
  if (node.kernelOnly) return { label: '需内核', tone: 'default' };
  if (node.lastOkAt) return { label: '可用', tone: 'green' };
  if (node.lastCheckedAt) return { label: '失败', tone: 'orange' };
  return { label: '未测活', tone: 'default' };
}

function successRate(node: ProxyNode): string {
  const total = node.successCount + node.failCount;
  if (!total) return '—';
  return `${Math.round((node.successCount / total) * 100)}%`;
}

export function Proxies() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState({ name: '', protocol: 'http', host: '', port: '', username: '', password: '', region: '', isp: '' });
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importUa, setImportUa] = useState('');
  const [importHeaders, setImportHeaders] = useState('');
  const [sort, setSort] = useState<ProxySort>('default');
  const [importResult, setImportResult] = useState<{ added: number; skipped: number; kernelOnly: number; warnings: string[] } | null>(null);
  const [pullTaskId, setPullTaskId] = useState<string | null>(null);

  const proxies = useQuery({
    queryKey: ['admin', 'proxies', sort],
    queryFn: () => api.get<ProxyList>(`/api/admin/proxies?sort=${sort}`),
  });
  const settingsQuery = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/api/admin/settings'),
  });

  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settingsQuery.data?.settings) setSettings(settingsQuery.data.settings);
  }, [settingsQuery.data?.settings]);

  const saveSettings = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.put<{ settings: AppSettings }>('/api/admin/settings', patch),
    onSuccess: (data) => {
      setSettings(data.settings);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      show('设置已保存');
    },
    onError: (error) => show(error instanceof Error ? error.message : '保存失败', 'error'),
  });

  const addProxy = useMutation({
    mutationFn: () => api.post<{ proxy: ProxyNode }>('/api/admin/proxies', {
      ...form,
      port: Number(form.port),
    }),
    onSuccess: () => {
      setAddOpen(false);
      setForm({ name: '', protocol: 'http', host: '', port: '', username: '', password: '', region: '', isp: '' });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
      show('代理已添加');
    },
    onError: (error) => show(error instanceof Error ? error.message : '添加失败', 'error'),
  });

  const importProxies = useMutation({
    mutationFn: () => {
      const headers: Record<string, string> = {};
      for (const line of importHeaders.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (key && value) headers[key] = value;
      }
      return api.post<{ added: number; skipped: number; kernelOnly: number; warnings: string[] }>('/api/admin/proxies/import', {
        text: importText,
        url: importUrl,
        userAgent: importUa.trim(),
        headers,
      });
    },
    onSuccess: (data) => {
      setImportResult(data);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
      show(`导入完成：新增 ${data.added}，跳过 ${data.skipped}`);
    },
    onError: (error) => show(error instanceof Error ? error.message : '导入失败', 'error'),
  });

  const patchProxy = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch<{ proxy: ProxyNode }>(`/api/admin/proxies/${id}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] }),
    onError: (error) => show(error instanceof Error ? error.message : '更新失败', 'error'),
  });

  const pullSubscription = useMutation({
    mutationFn: (mode: 'proxy' | 'actions') =>
      api.post<{ taskId: string }>('/api/admin/proxies/pull-subscription', { url: importUrl.trim(), userAgent: importUa.trim(), mode }),
    onSuccess: (data, mode) => {
      setImportOpen(false);
      setImportResult(null);
      setPullTaskId(data.taskId);
      show(mode === 'actions' ? '已派发 Actions 直连拉取，完成后会自动刷新列表' : '已派发代理拉取，完成后会自动刷新列表');
    },
    onError: (error) => show(error instanceof Error ? error.message : '派发失败', 'error'),
  });

  const pullTask = useQuery({
    queryKey: ['admin', 'proxy-pull-task', pullTaskId],
    queryFn: () => api.get<{ items: Array<{ id: string; status: string; message: string }> }>('/api/admin/tasks'),
    enabled: Boolean(pullTaskId),
    refetchInterval: (query) => {
      const item = query.state.data?.items.find((entry) => entry.id === pullTaskId);
      if (!item) return 3000;
      return item.status === 'done' || item.status === 'failed' || item.status === 'cancelled' ? false : 3000;
    },
  });

  useEffect(() => {
    if (!pullTaskId) return;
    const item = pullTask.data?.items.find((entry) => entry.id === pullTaskId);
    if (!item) return;
    if (item.status === 'done') {
      show(`订阅拉取完成：${item.message}`);
      setPullTaskId(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
    } else if (item.status === 'failed' || item.status === 'cancelled') {
      show(item.message || '订阅拉取失败', 'error');
      setPullTaskId(null);
    }
  }, [pullTask.data, pullTaskId]);

  const checkProxies = useMutation({
    mutationFn: (id?: string) => api.post<{ taskId: string }>('/api/admin/proxies/check-all', id ? { id } : {}),
    onSuccess: () => show('已派发测活任务'),
    onError: (error) => show(error instanceof Error ? error.message : '派发失败', 'error'),
  });

  const cnProbe = useMutation({
    mutationFn: () => api.post<{ taskId: string; dispatched?: boolean }>('/api/admin/pool/cn-probe', { limit: settings?.cnProbeBatchSize ?? 200 }),
    onSuccess: (data) => show(data?.dispatched ? '国内补测已开始' : '国内补测已排队'),
    onError: (error) => show(error instanceof Error ? error.message : '派发失败', 'error'),
  });

  const moveProxy = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      api.post<{ moved: boolean }>(`/api/admin/proxies/${id}/move`, { direction }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] }),
  });

  const removeProxy = useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/api/admin/proxies/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
      show('代理已删除');
    },
    onError: (error) => show(error instanceof Error ? error.message : '删除失败', 'error'),
  });

  const items = proxies.data?.items ?? [];
  const enabledCount = items.filter((item) => item.enabled && !item.kernelOnly).length;
  const kernelCount = items.filter((item) => item.kernelOnly).length;

  const settingsReady = Boolean(settings);
  const mode = settings?.proxyTestMode ?? 'interval';

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="DOMESTIC PROXIES"
        title="国内代理"
        description="用国内出口补测机房探测失败的线路；代理密码加密存储，接口只回掩码。"
        meta={proxies.isLoading ? '加载中…' : `共 ${items.length} 个 · 启用 ${enabledCount} 个${kernelCount ? ` · 需内核 ${kernelCount} 个` : ''}`}
        actions={
          <>
            <Button variant="ghost" loading={cnProbe.isPending} onClick={() => cnProbe.mutate(undefined)}><Globe2 size={14} /> 国内补测</Button>
            <Button variant="ghost" loading={checkProxies.isPending} onClick={() => checkProxies.mutate(undefined)}><RefreshCw size={14} /> 全部测活</Button>
            <Button variant="ghost" onClick={() => setImportOpen(true)}><Upload size={14} /> 批量导入</Button>
            <Button onClick={() => setAddOpen(true)}><Plus size={14} /> 添加代理</Button>
          </>
        }
      />

      <div className="card">
        <div className="card__header">
          <div>
            <div className="title-3">自动测活与补测</div>
            <div className="caption">自动测活只更新代理状态，不触发补测；补测前的预检始终执行，二者互不影响。</div>
          </div>
        </div>
        {settingsReady ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <strong>自动测活</strong>
                <div className="caption">关闭时不产生定时任务；手动测活不受影响。</div>
              </div>
              <Switch
                checked={Boolean(settings?.proxyTestEnabled)}
                onChange={(value) => {
                  setSettings((current) => (current ? { ...current, proxyTestEnabled: value } : current));
                  saveSettings.mutate({ proxyTestEnabled: value });
                }}
              />
            </div>
            {settings?.proxyTestEnabled ? (
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="测活模式">
                  <select
                    className="select"
                    value={mode}
                    onChange={(event) => {
                      const value = event.target.value as 'interval' | 'times';
                      setSettings((current) => (current ? { ...current, proxyTestMode: value } : current));
                      saveSettings.mutate({ proxyTestMode: value });
                    }}
                  >
                    <option value="interval">固定间隔</option>
                    <option value="times">每天固定时段</option>
                  </select>
                </Field>
                {mode === 'interval' ? (
                  <Field label="每隔多少小时">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={168}
                      value={settings?.proxyTestIntervalHours ?? 6}
                      onChange={(event) => setSettings((current) => (current ? { ...current, proxyTestIntervalHours: Number(event.target.value) } : current))}
                      onBlur={() => saveSettings.mutate({ proxyTestIntervalHours: settings?.proxyTestIntervalHours ?? 6 })}
                    />
                  </Field>
                ) : (
                  <Field label="每天时刻（北京时间，逗号分隔）">
                    <input
                      className="input"
                      placeholder="03:00,15:00"
                      value={settings?.proxyTestTimes ?? ''}
                      onChange={(event) => setSettings((current) => (current ? { ...current, proxyTestTimes: event.target.value } : current))}
                      onBlur={() => saveSettings.mutate({ proxyTestTimes: settings?.proxyTestTimes ?? '' })}
                    />
                  </Field>
                )}
              </div>
            ) : null}
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <strong>国内补测</strong>
                <div className="caption">主探测完成后，用国内代理复测失败线路；结果只用于标记「国内可达」。</div>
              </div>
              <Switch
                checked={Boolean(settings?.cnProbeEnabled)}
                onChange={(value) => {
                  setSettings((current) => (current ? { ...current, cnProbeEnabled: value } : current));
                  saveSettings.mutate({ cnProbeEnabled: value });
                }}
              />
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="每批补测条数">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1000}
                  value={settings?.cnProbeBatchSize ?? 200}
                  onChange={(event) => setSettings((current) => (current ? { ...current, cnProbeBatchSize: Number(event.target.value) } : current))}
                  onBlur={() => saveSettings.mutate({ cnProbeBatchSize: settings?.cnProbeBatchSize ?? 200 })}
                />
              </Field>
              <Field label="补测并发">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={settings?.cnProbeConcurrency ?? 5}
                  onChange={(event) => setSettings((current) => (current ? { ...current, cnProbeConcurrency: Number(event.target.value) } : current))}
                  onBlur={() => saveSettings.mutate({ cnProbeConcurrency: settings?.cnProbeConcurrency ?? 5 })}
                />
              </Field>
              <Button variant="ghost" loading={saveSettings.isPending} onClick={() => saveSettings.mutate({})}>
                <Save size={14} /> 保存
              </Button>
            </div>
          </div>
        ) : settingsQuery.isError ? (
          <QueryError title="设置加载失败" error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
        ) : (
          <div className="caption">加载中…</div>
        )}
      </div>

      {proxies.isLoading ? (
        <div className="caption">加载代理列表…</div>
      ) : proxies.isError ? (
        <QueryError title="代理列表加载失败" error={proxies.error} onRetry={() => void proxies.refetch()} />
      ) : items.length ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--sep)' }}>
            <div className="caption">排序只影响显示；上移/下移仅在「默认顺序」下可用。</div>
            <select className="select" style={{ width: 170 }} value={sort} onChange={(event) => setSort(event.target.value as ProxySort)}>
              <option value="default">默认顺序（当前优先）</option>
              <option value="latency">延迟最低</option>
              <option value="success">成功率最高</option>
              <option value="recent">最近测活</option>
              <option value="name">名称</option>
            </select>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>协议</th>
                <th>地址</th>
                <th>地区</th>
                <th>状态</th>
                <th>延迟</th>
                <th>成功率</th>
                <th>最近检测</th>
                <th style={{ width: 150 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((node, index) => {
                const status = statusOf(node);
                return (
                  <tr key={node.id} style={node.kernelOnly ? { opacity: 0.55 } : undefined}>
                    <td>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        {node.id === proxies.data?.currentId ? <Badge tone="blue">当前</Badge> : null}
                        <span>{node.name}</span>
                      </div>
                    </td>
                    <td><span className="mono">{node.protocol}</span></td>
                    <td className="mono">{node.host}:{node.port}{node.username ? ` · ${node.username}` : ''}{node.hasPassword ? ' · 有密码' : ''}</td>
                    <td>{[node.region, node.isp].filter(Boolean).join(' / ') || '—'}</td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {node.lastError ? <div className="caption" style={{ marginTop: 2 }}>{node.lastError}</div> : null}
                    </td>
                    <td>{node.lastLatencyMs != null ? `${node.lastLatencyMs} ms` : '—'}</td>
                    <td>{successRate(node)}</td>
                    <td className="caption">{node.lastCheckedAt ? timeAgo(node.lastCheckedAt) : '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <Switch
                          checked={node.enabled}
                          disabled={node.kernelOnly}
                          onChange={(value) => patchProxy.mutate({ id: node.id, patch: { enabled: value } })}
                        />
                        <Button variant="ghost" size="sm" title="测活" disabled={node.kernelOnly} onClick={() => checkProxies.mutate(node.id)}><RefreshCw size={13} /></Button>
                        <Button variant="ghost" size="sm" title={sort === 'default' ? '上移' : '仅默认顺序可上移'} disabled={sort !== 'default' || index === 0} onClick={() => moveProxy.mutate({ id: node.id, direction: 'up' })}><ArrowUp size={13} /></Button>
                        <Button variant="ghost" size="sm" title={sort === 'default' ? '下移' : '仅默认顺序可下移'} disabled={sort !== 'default' || index === items.length - 1} onClick={() => moveProxy.mutate({ id: node.id, direction: 'down' })}><ArrowDown size={13} /></Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm(`删除代理「${node.name}」？`)) removeProxy.mutate(node.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="还没有代理"
          description="支持 http/https/socks5，以及 Clash YAML、Base64、JSON、host:port:user:pass 等格式；vmess 等需内核节点会灰显保留。"
          action={<Button onClick={() => setImportOpen(true)}><Upload size={14} /> 批量导入</Button>}
        />
      )}

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="添加代理" subtitle="一期支持 http/https/socks5；vmess 等会标记需内核">
        <div className="stack">
          <Field label="名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="深圳电信" /></Field>
          <div className="row" style={{ gap: 10 }}>
            <Field label="协议">
              <select className="select" value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
                {PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
              </select>
            </Field>
            <Field label="服务器"><input className="input" value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="1.2.3.4" /></Field>
            <Field label="端口"><input className="input" type="number" value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} placeholder="8080" /></Field>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Field label="用户名（可选）"><input className="input" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
            <Field label="密码（可选）"><input className="input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Field label="地区"><input className="input" value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="深圳" /></Field>
            <Field label="运营商"><input className="input" value={form.isp} onChange={(event) => setForm({ ...form, isp: event.target.value })} placeholder="电信" /></Field>
          </div>
          <Button loading={addProxy.isPending} onClick={() => addProxy.mutate()}><Plus size={14} /> 添加</Button>
        </div>
      </Sheet>

      <Sheet open={importOpen} onClose={() => { setImportOpen(false); setImportResult(null); }} title="批量导入" subtitle="粘贴节点内容，或填订阅地址；自动去重">
        <div className="stack">
          <Field label="订阅地址（可选）">
            <input className="input" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://example.com/sub" />
          </Field>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div className="caption">直连被 403 时：可让已有代理去拉，或让 Actions 用它的出口去拉。</div>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="ghost" loading={pullSubscription.isPending} disabled={!importUrl.trim()} onClick={() => pullSubscription.mutate('proxy')}>
                <Globe2 size={14} /> 通过代理拉取
              </Button>
              <Button variant="ghost" loading={pullSubscription.isPending} disabled={!importUrl.trim()} onClick={() => pullSubscription.mutate('actions')}>
                <RefreshCw size={14} /> Actions 直连拉取
              </Button>
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Field label="订阅请求 UA（可选）">
              <div className="row" style={{ gap: 8 }}>
                <select
                  className="select"
                  style={{ width: 210 }}
                  value={UA_PRESETS.some((preset) => preset.value === importUa) ? importUa : 'custom'}
                  onChange={(event) => {
                    const value = event.target.value;
                    setImportUa(value === 'custom' ? '' : value);
                  }}
                >
                  <option value="custom">自定义 / 默认</option>
                  {UA_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                </select>
                <input className="input" value={importUa} onChange={(event) => setImportUa(event.target.value)} placeholder="留空用默认 UA" />
              </div>
            </Field>
          </div>
          <Field label="附加请求头（可选，每行 Key: Value）">
            <textarea className="input" rows={2} value={importHeaders} onChange={(event) => setImportHeaders(event.target.value)} placeholder="Accept: */*" />
          </Field>
          <Field label="节点内容">
            <textarea className="input" rows={8} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'http://user:pass@1.2.3.4:8080#深圳电信\nsocks5://5.6.7.8:1080\n或 Clash YAML / Base64 / JSON'} />
          </Field>
          <Button loading={importProxies.isPending} onClick={() => importProxies.mutate()}><Upload size={14} /> 导入</Button>
          {importResult ? (
            <div className="caption">
              新增 {importResult.added} 个 · 跳过 {importResult.skipped} 个{importResult.kernelOnly ? ` · 需内核 ${importResult.kernelOnly} 个` : ''}
              {importResult.warnings.length ? <div style={{ marginTop: 6 }}>{importResult.warnings.join('；')}</div> : null}
            </div>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
