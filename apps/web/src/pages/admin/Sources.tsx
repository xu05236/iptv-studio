import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Plus, RefreshCw, RadioTower, SlidersHorizontal, Trash2, Upload, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import type { SourceItem } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Segmented, Sheet, Switch, useToast } from '../../components/ui';
import { ReputationBadge } from '../../components/ReputationBadge';

interface SourceHealthPoint {
  day: string;
  fetched: boolean;
  parsed: number;
  alive: number;
  dead: number;
  avgSpeedKbps: number;
  reputation: number;
}

interface SourceHealthItem {
  sourceId: string;
  name: string;
  points: SourceHealthPoint[];
}

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

interface FilterForm {
  groups: string;
  excludeGroups: string;
  keywords: string;
  excludeKeywords: string;
  maxEntries: string;
}

const EMPTY_FILTER_FORM: FilterForm = { groups: '', excludeGroups: '', keywords: '', excludeKeywords: '', maxEntries: '' };

function listOf(value: string): string[] {
  return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function buildFilters(form: FilterForm): NonNullable<SourceItem['filters']> | undefined {
  const filters: NonNullable<SourceItem['filters']> = {};
  if (listOf(form.groups).length) filters.groups = listOf(form.groups);
  if (listOf(form.excludeGroups).length) filters.excludeGroups = listOf(form.excludeGroups);
  if (listOf(form.keywords).length) filters.keywords = listOf(form.keywords);
  if (listOf(form.excludeKeywords).length) filters.excludeKeywords = listOf(form.excludeKeywords);
  if (Number(form.maxEntries) > 0) filters.maxEntries = Number(form.maxEntries);
  return Object.keys(filters).length ? filters : undefined;
}

function filtersToForm(filters: SourceItem['filters']): FilterForm {
  return {
    groups: (filters?.groups ?? []).join(', '),
    excludeGroups: (filters?.excludeGroups ?? []).join(', '),
    keywords: (filters?.keywords ?? []).join(', '),
    excludeKeywords: (filters?.excludeKeywords ?? []).join(', '),
    maxEntries: filters?.maxEntries ? String(filters.maxEntries) : '',
  };
}

function FilterFields({ form, onChange }: { form: FilterForm; onChange: (next: FilterForm) => void }) {
  return (
    <div className="stack">
      <div className="row">
        <div className="grow"><Field label="只保留分组" hint="逗号分隔，匹配分组或频道名"><input className="input" value={form.groups} onChange={(event) => onChange({ ...form, groups: event.target.value })} placeholder="央视, 卫视, 翡翠" /></Field></div>
        <div className="grow"><Field label="排除分组"><input className="input" value={form.excludeGroups} onChange={(event) => onChange({ ...form, excludeGroups: event.target.value })} placeholder="购物, 测试" /></Field></div>
      </div>
      <div className="row">
        <div className="grow"><Field label="只保留频道名包含"><input className="input" value={form.keywords} onChange={(event) => onChange({ ...form, keywords: event.target.value })} placeholder="CCTV, 湖南" /></Field></div>
        <div className="grow"><Field label="排除频道名包含"><input className="input" value={form.excludeKeywords} onChange={(event) => onChange({ ...form, excludeKeywords: event.target.value })} placeholder="支付, 广告" /></Field></div>
      </div>
      <Field label="最多保留条数" hint="过滤后硬上限，留空不限制">
        <input className="input" type="number" min={0} value={form.maxEntries} onChange={(event) => onChange({ ...form, maxEntries: event.target.value })} placeholder="例如 300" />
      </Field>
    </div>
  );
}

interface PreviewResult {
  exists: boolean;
  duplicateOf?: { id: string; name: string; reason: 'url' | 'content' };
  reachable: boolean;
  entries: number;
  groups?: Array<{ group: string; count: number }>;
  sample?: Array<{ name: string; url: string }>;
  warnings?: string[];
  error?: string;
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
  const [skipFetch, setSkipFetch] = useState(false);
  const [refreshHours, setRefreshHours] = useState('24');
  const [filterSource, setFilterSource] = useState<SourceItem | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [filterForm, setFilterForm] = useState({ groups: '', excludeGroups: '', keywords: '', excludeKeywords: '', maxEntries: '' });
  const [region, setRegion] = useState('');
  const [operator, setOperator] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeSummary | null>(null);
  const [activeSource, setActiveSource] = useState<SourceItem | null>(null);
  const [lineResults, setLineResults] = useState<Array<{ name?: string; url: string; result: { ok: boolean; speedKbps?: number; resolution?: string; error?: string } }> | null>(null);
  const [healthSort, setHealthSort] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => api.get<{ items: SourceItem[] }>('/api/admin/sources'),
  });

  const health = useQuery({
    queryKey: ['admin', 'source-health'],
    queryFn: () => api.get<{ days: number; items: SourceHealthItem[] }>('/api/admin/sources/health?days=7'),
  });

  const checkDuplicate = useMutation({
    mutationFn: () =>
      api.post<PreviewResult>('/api/admin/sources/preview', {
        url: mode === 'url' ? url.trim() : undefined,
        content: mode === 'url' ? undefined : content,
      }),
    onSuccess: (result) => setPreview(result),
    onError: (error: Error) => { setPreview(null); show(error.message, 'error'); },
  });

  const create = useMutation({
    mutationFn: () => api.post<ProbeSummary>('/api/admin/sources', {
      name: name.trim() || undefined,
      url: mode === 'url' ? url.trim() : undefined,
      content: mode === 'url' ? undefined : content,
      skipFetch: mode === 'url' ? skipFetch : undefined,
      refresh_hours: Number(refreshHours) || 24,
      filters: buildFilters(filterForm),
      region: region.trim() || undefined,
      operator: operator.trim() || undefined,
    }),
    onSuccess: (result) => {
      show(`已添加，解析到 ${result.summary?.entries ?? 0} 条`);
      setOpen(false);
      setName(''); setUrl(''); setContent(''); setRegion(''); setOperator(''); setSkipFetch(false); setFilterForm(EMPTY_FILTER_FORM); setPreview(null); setRefreshHours('24');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const saveFilters = useMutation({
    mutationFn: () => api.patch(`/api/admin/sources/${filterSource?.id}`, {
      filters: buildFilters(filterForm) ?? {},
      refresh_hours: Number(refreshHours) || 24,
    }),
    onSuccess: () => {
      show('过滤规则已保存，下一轮采集生效');
      setFilterSource(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({    mutationFn: (id: string) => api.post(`/api/admin/sources/${id}/toggle`),
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

  const items = useMemo(() => {
    const base = data?.items ?? [];
    if (!healthSort || !health.data) return base;
    const score = new Map(
      health.data.items.map((item) => {
        const total = item.points.reduce((sum, point) => sum + point.parsed, 0);
        const alive = item.points.reduce((sum, point) => sum + point.alive, 0);
        return [item.sourceId, total ? alive / total : 0];
      }),
    );
    return [...base].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
  }, [data, healthSort, health.data]);
  const sites = useMemo(() => [...new Set(items.map(sourceSite))], [items]);

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">采集站</h1>
          <p className="subhead" style={{ marginTop: 4 }}>这里列出所有采集来源（GitHub 项目 / 自建站点 / 上传文件），可启停、检查、抽样测速或删除。</p>
          <p className="caption" style={{ marginTop: 4 }}>信誉分综合可用率、线路质量、抓取成功率：80+ 优质 / 50–79 正常 / &lt;50 降权，会影响探测排序、复测间隔和每轮预算份额。</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus size={16} /> 添加采集站
        </Button>
      </div>

      {sites.length ? (
        <div className="row row--wrap">
          <span className="caption">当前采集站：</span>
          {sites.map((site) => <Badge key={site} tone="blue">{site}</Badge>)}
          <Button size="sm" variant={healthSort ? 'primary' : 'glass'} onClick={() => setHealthSort((value) => !value)}>
            按 7 天健康排序
          </Button>
        </div>
      ) : null}

      {health.data?.items.length ? (
        <Card>
          <div className="row row--between">
            <div className="row" style={{ gap: 6 }}><Activity size={15} /><span className="title-3">近 7 天源健康</span></div>
            <span className="caption">可用 / 解析 · UTC 日期</span>
          </div>
          <div className="table-wrap" style={{ marginTop: 10, border: 0 }}>
            <table className="table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th>采集站</th>
                  {Array.from({ length: health.data.days }, (_, index) => {
                    const date = new Date(Date.now() - (health.data.days - 1 - index) * 86_400_000).toISOString().slice(5, 10);
                    return <th key={date}>{date}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {health.data.items.map((item) => (
                  <tr key={item.sourceId}>
                    <td className="truncate" style={{ maxWidth: 160 }}>{item.name}</td>
                    {Array.from({ length: health.data.days }, (_, index) => {
                      const date = new Date(Date.now() - (health.data.days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
                      const point = item.points.find((entry) => entry.day === date);
                      if (!point) return <td key={date} className="caption">—</td>;
                      const pct = point.parsed ? Math.round((point.alive / point.parsed) * 100) : 0;
                      return (
                        <td key={date} style={{ color: !point.fetched ? 'var(--red)' : pct >= 30 ? 'var(--green)' : 'var(--orange)' }}>
                          {point.fetched ? `${point.alive}/${point.parsed}` : '失败'}
                          <div className="caption">{pct}%</div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
                  {source.entry_count} 条 · {source.alive_count} 可用 · <ReputationBadge score={source.reputation} /> · 更新 {timeAgo(source.last_ok_at)} · 每 {source.refresh_hours ?? 24}h
                  {source.region ? ` · ${source.region}${source.operator ?? ''}` : ''}
                </div>
                {source.progress ? (
                  <div className="caption" style={{ marginTop: 2 }}>
                    池内 {source.progress.total} · 已测 {source.progress.tested} · 可用 {source.progress.alive} · 待测 {source.progress.pending} · 待复测 {source.progress.quarantine} · 淘汰 {source.progress.rejected}
                  </div>
                ) : null}
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
              <Button size="sm" onClick={() => { setFilterSource(source); setFilterForm(filtersToForm(source.filters)); setRefreshHours(String(source.refresh_hours ?? 24)); }}>
                <SlidersHorizontal size={13} /> 过滤
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
          <div className="row">
            <Button loading={checkDuplicate.isPending} onClick={() => checkDuplicate.mutate()}>
              检查是否已存在
            </Button>
            <Button block variant="primary" loading={create.isPending} disabled={preview?.exists} onClick={() => create.mutate()}>
              添加并解析
            </Button>
          </div>
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
          {mode === 'url' ? (
            <div className="list__row" style={{ padding: '4px 0' }}>
              <div className="grow">
                <div className="list__title">跳过预检，交给采集器抓取</div>
                <div className="caption">源站限制 Cloudflare/海外 IP 时使用；添加时不再校验，下一轮采集由 GitHub Actions 抓取。</div>
              </div>
              <Switch checked={skipFetch} onChange={setSkipFetch} />
            </div>
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
          <FilterFields form={filterForm} onChange={setFilterForm} />
          <Field label="更新间隔（小时）" hint="未到间隔时跳过抓取，直接复用上一轮线路；0 表示每次都抓">
            <input className="input" type="number" min={0} value={refreshHours} onChange={(event) => setRefreshHours(event.target.value)} placeholder="24" />
          </Field>
          {mode !== 'url' && content ? <div className="caption"><Upload size={12} /> 已读取 {content.length.toLocaleString()} 字符</div> : null}
          {preview ? (
            <div className="caption" style={{ color: preview.exists ? 'var(--red)' : preview.reachable ? 'var(--green)' : 'var(--orange)' }}>
              {preview.exists
                ? `该订阅已存在：${preview.duplicateOf?.name}（${preview.duplicateOf?.reason === 'content' ? '内容相同' : '地址相同'}）`
                : preview.reachable
                  ? `未收录，预计 ${preview.entries} 条`
                  : `无法抓取：${preview.error ?? '未知错误'}；可勾选「跳过预检」交给采集器`}
            </div>
          ) : null}
        </div>
      </Sheet>

      <Sheet
        open={Boolean(filterSource)}
        onClose={() => setFilterSource(null)}
        title="源过滤"
        subtitle={filterSource?.name}
        footer={
          <Button block variant="primary" loading={saveFilters.isPending} onClick={() => saveFilters.mutate()}>
            保存过滤
          </Button>
        }
      >
        <div className="stack">
          <p className="caption">过滤在采集器解析后生效，不会删除已入库频道；清空后保存即恢复全量。</p>
          <FilterFields form={filterForm} onChange={setFilterForm} />
          <Field label="更新间隔（小时）" hint="未到间隔时跳过抓取，直接复用上一轮线路；0 表示每次都抓">
            <input className="input" type="number" min={0} value={refreshHours} onChange={(event) => setRefreshHours(event.target.value)} placeholder="24" />
          </Field>
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
