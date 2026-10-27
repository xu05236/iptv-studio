import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, RadioTower, Trash2, Upload, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import type { SourceItem } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Segmented, Sheet, Switch, useToast } from '../../components/ui';

function sourceSite(source: SourceItem): string {
  if (source.url) {
    try {
      return new URL(source.url).hostname;
    } catch {
      return '远程源';
    }
  }
  return source.origin === 'upload' ? '本地上传' : '手动粘贴';
}

interface ProbeSummary {
  summary?: {
    kind: string;
    entries: number;
    groups: Array<{ group: string; count: number }>;
    sample: Array<{ name: string; url: string }>;
    warnings: string[];
  };
  notModified?: boolean;
  message?: string;
}

export function Sources() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'url' | 'paste' | 'file'>('url');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [region, setRegion] = useState('');
  const [operator, setOperator] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeSummary | null>(null);
  const [activeSource, setActiveSource] = useState<SourceItem | null>(null);
  const [lineResults, setLineResults] = useState<Array<{ name?: string; url: string; result: { ok: boolean; speedKbps?: number; resolution?: string; error?: string } }> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => api.get<{ items: SourceItem[] }>('/api/admin/sources'),
  });

  const create = useMutation({
    mutationFn: () => api.post<ProbeSummary>('/api/admin/sources', {
      name: name.trim() || undefined,
      url: mode === 'url' ? url.trim() : undefined,
      content: mode === 'url' ? undefined : content,
      region: region.trim() || undefined,
      operator: operator.trim() || undefined,
    }),
    onSuccess: (result) => {
      show(`已添加，解析到 ${result.summary?.entries ?? 0} 条`);
      setOpen(false);
      setName(''); setUrl(''); setContent(''); setRegion(''); setOperator('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/sources/${id}/toggle`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] }),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/sources/${id}`),
    onSuccess: () => {
      show('已删除');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const probe = useMutation({
    mutationFn: (id: string) => api.post<ProbeSummary>(`/api/admin/sources/${id}/probe`),
    onSuccess: (result, id) => {
      setProbeResult(result);
      setActiveSource(data?.items.find((item) => item.id === id) ?? null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const probeLines = useMutation({
    mutationFn: (id: string) => api.post<{ results: typeof lineResults }>(`/api/admin/sources/${id}/probe-lines`, { limit: 8 }),
    onSuccess: (result) => setLineResults(result.results ?? []),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const sites = useMemo(() => [...new Set(items.map(sourceSite))], [items]);

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">采集站</h1>
          <p className="subhead" style={{ marginTop: 4 }}>这里列出所有采集来源（GitHub 项目 / 自建站点 / 上传文件），可启停、检查、抽样测速或删除。</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus size={16} /> 添加采集站
        </Button>
      </div>

      {sites.length ? (
        <div className="row row--wrap">
          <span className="caption">当前采集站：</span>
          {sites.map((site) => <Badge key={site} tone="blue">{site}</Badge>)}
        </div>
      ) : null}

      {isLoading ? <Card><div className="caption">加载中…</div></Card> : null}

      {!isLoading && !items.length ? (
        <EmptyState
          icon={<RadioTower size={24} />}
          title="还没有采集站"
          description="添加一个 M3U / TXT / JSON 订阅，或上传本地列表。格式会自动识别。"
          action={<Button variant="primary" onClick={() => setOpen(true)}>添加第一个采集站</Button>}
        />
      ) : null}

      <div className="stack">
        {items.map((source) => (
          <Card key={source.id}>
            <div className="row row--between" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="title-3 truncate">{source.name}</span>
                  <Badge tone="blue">{sourceSite(source)}</Badge>
                  <Badge>{source.kind.toUpperCase()}</Badge>
                  {source.origin !== 'remote' ? <Badge>{source.origin === 'upload' ? '文件' : '粘贴'}</Badge> : null}
                  {source.status === 'degraded' ? <Badge tone="red">抓取异常</Badge> : null}
                </div>
                <div className="caption" style={{ marginTop: 4 }}>
                  {source.entry_count} 条 · {source.alive_count} 可用 · 信誉 {Math.round(source.reputation)} · 更新 {timeAgo(source.last_ok_at)}
                  {source.region ? ` · ${source.region}${source.operator ?? ''}` : ''}
                </div>
                {source.url ? <div className="caption mono truncate" style={{ marginTop: 2 }}>{source.url}</div> : null}
                {source.last_error ? <div className="caption" style={{ color: 'var(--red)', marginTop: 4 }}>{source.last_error}</div> : null}
              </div>
              <Switch checked={source.enabled} onChange={() => toggle.mutate(source.id)} />
            </div>

            <div className="meter" style={{ marginTop: 12 }}>
              <div
                className="meter__fill"
                style={{ width: `${Math.min(100, Math.max(2, source.reputation))}%`, background: source.reputation >= 80 ? 'var(--green)' : source.reputation >= 50 ? 'var(--blue)' : 'var(--orange)' }}
              />
            </div>

            <div className="row row--wrap" style={{ marginTop: 12, gap: 6 }}>
              <Button size="sm" loading={probe.isPending} onClick={() => probe.mutate(source.id)}>
                <RefreshCw size={13} /> 检查解析
              </Button>
              <Button size="sm" loading={probeLines.isPending} onClick={() => probeLines.mutate(source.id)}>
                <Zap size={13} /> 抽样测速
              </Button>
              <Button size="sm" variant="danger" onClick={() => { if (confirm(`删除「${source.name}」？`)) remove.mutate(source.id); }}>
                <Trash2 size={13} /> 删除
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="添加采集站"
        subtitle="支持 M3U / TXT / JSON / TVBox lives / 华为 JSP，自动识别"
        footer={
          <Button block variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            添加并解析
          </Button>
        }
      >
        <div className="stack">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'url', label: '订阅地址' },
              { value: 'paste', label: '粘贴文本' },
              { value: 'file', label: '上传文件' },
            ]}
          />
          <Field label="名称（可选）">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：社区 4K 源" />
          </Field>
          {mode === 'url' ? (
            <Field label="订阅 URL" hint="仅支持 http/https；添加时会先真实抓取一次并校验可解析。">
              <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/iptv.m3u" inputMode="url" />
            </Field>
          ) : null}
          {mode === 'paste' ? (
            <Field label="列表内容">
              <textarea className="textarea" value={content} onChange={(event) => setContent(event.target.value)} placeholder="#EXTM3U&#10;#EXTINF:-1 tvg-id=&quot;CCTV1&quot;,CCTV-1 综合&#10;http://..." />
            </Field>
          ) : null}
          {mode === 'file' ? (
            <Field label="选择文件" hint="支持 .m3u / .m3u8 / .txt / .json">
              <input
                className="input"
                type="file"
                accept=".m3u,.m3u8,.txt,.json,text/plain,application/json"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setContent(await file.text());
                    if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
                  }
                }}
              />
            </Field>
          ) : null}
          <div className="row">
            <div className="grow"><Field label="地区（可选）"><input className="input" value={region} onChange={(event) => setRegion(event.target.value)} placeholder="江苏" /></Field></div>
            <div className="grow"><Field label="运营商（可选）"><input className="input" value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="电信" /></Field></div>
          </div>
          {mode !== 'url' && content ? <div className="caption"><Upload size={12} /> 已读取 {content.length.toLocaleString()} 字符</div> : null}
        </div>
      </Sheet>

      <Sheet open={Boolean(probeResult)} onClose={() => setProbeResult(null)} title="解析结果" subtitle={activeSource?.name}>
        {probeResult?.notModified ? <p className="subhead">{probeResult.message}</p> : null}
        {probeResult?.summary ? (
          <div className="stack">
            <div className="row row--wrap">
              <Badge tone="blue">{probeResult.summary.kind}</Badge>
              <Badge>{probeResult.summary.entries} 条</Badge>
              {probeResult.summary.groups.slice(0, 6).map((group) => (
                <Badge key={group.group}>{group.group} {group.count}</Badge>
              ))}
            </div>
            <div className="list">
              {probeResult.summary.sample.map((entry, index) => (
                <div key={`${entry.url}-${index}`} className="list__row">
                  <span className="caption" style={{ width: 24 }}>{index + 1}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="list__title truncate">{entry.name}</div>
                    <div className="caption truncate mono">{entry.url}</div>
                  </div>
                </div>
              ))}
            </div>
            {probeResult.summary.warnings.length ? (
              <div className="caption" style={{ color: 'var(--orange)' }}>{probeResult.summary.warnings.join('；')}</div>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={Boolean(lineResults)} onClose={() => setLineResults(null)} title="抽样测速" subtitle="最多 8 条，Worker 内直接探测">
        <div className="list">
          {(lineResults ?? []).map((item, index) => (
            <div key={`${item.url}-${index}`} className="list__row" style={{ alignItems: 'flex-start' }}>
              <Badge tone={item.result.ok ? 'green' : 'red'}>{item.result.ok ? 'OK' : 'FAIL'}</Badge>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list__title truncate">{item.name ?? item.url}</div>
                <div className="caption">
                  {item.result.resolution ?? '—'} · {item.result.speedKbps ? `${Math.round(item.result.speedKbps)} kbps` : item.result.error}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
