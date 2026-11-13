import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronDown, GitCompare, LayoutGrid, List, Plus, RefreshCw, RadioTower, SlidersHorizontal, Star, Upload, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import type { SourceItem } from '../../lib/types';
import { formatDateTime, timeAgo } from '../../lib/format';
import { errorKindLabel } from '../../lib/fetchErrors';
import { Badge, Button, Card, EmptyState, Field, QueryError, Segmented, Sheet, Switch, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { ReputationBadge, reputationTier } from '../../components/ReputationBadge';

const formatNumber = (value: number): string => value.toLocaleString('zh-CN');

function Delta({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || value === 0) return null;
  return <em className={value > 0 ? 'delta delta--up' : 'delta delta--down'}>{value > 0 ? `+${value}` : value}</em>;
}

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

function needsAttention(source: SourceItem): boolean {
  return !source.enabled
    || source.status !== 'active'
    || Boolean(source.last_error)
    || Boolean(source.parseDrop)
    || Number(source.consecutive_failures ?? 0) > 0;
}

interface FilterForm {
  groups: string;
  excludeGroups: string;
  keywords: string;
  excludeKeywords: string;
  maxEntries: string;
  dropNumericNames: boolean;
}

const EMPTY_FILTER_FORM: FilterForm = { groups: '', excludeGroups: '', keywords: '', excludeKeywords: '', maxEntries: '', dropNumericNames: true };

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
  if (form.dropNumericNames === false) filters.dropNumericNames = false;
  return Object.keys(filters).length ? filters : undefined;
}

function filtersToForm(filters: SourceItem['filters']): FilterForm {
  return {
    groups: (filters?.groups ?? []).join(', '),
    excludeGroups: (filters?.excludeGroups ?? []).join(', '),
    keywords: (filters?.keywords ?? []).join(', '),
    excludeKeywords: (filters?.excludeKeywords ?? []).join(', '),
    maxEntries: filters?.maxEntries ? String(filters.maxEntries) : '',
    dropNumericNames: filters?.dropNumericNames !== false,
  };
}

function FilterFields({ form, onChange }: { form: FilterForm; onChange: (next: FilterForm) => void }) {
  return (
    <div className="stack stack--tight">
      <div className="form-grid">
        <Field label="只保留分组" hint="逗号分隔，匹配分组或频道名"><input className="input" value={form.groups} onChange={(event) => onChange({ ...form, groups: event.target.value })} placeholder="央视, 卫视, 翡翠" /></Field>
        <Field label="排除分组"><input className="input" value={form.excludeGroups} onChange={(event) => onChange({ ...form, excludeGroups: event.target.value })} placeholder="购物, 测试" /></Field>
        <Field label="只保留频道名包含"><input className="input" value={form.keywords} onChange={(event) => onChange({ ...form, keywords: event.target.value })} placeholder="CCTV, 湖南" /></Field>
        <Field label="排除频道名包含"><input className="input" value={form.excludeKeywords} onChange={(event) => onChange({ ...form, excludeKeywords: event.target.value })} placeholder="支付, 广告" /></Field>
      </div>
      <div className="list__row">
        <span className="grow">过滤纯数字频道名（如 1、106）</span>
        <Switch checked={form.dropNumericNames} onChange={(value) => onChange({ ...form, dropNumericNames: value })} />
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
  const [kind, setKind] = useState('auto');
  const [skipFetch, setSkipFetch] = useState(false);
  const [refreshHours, setRefreshHours] = useState('');
  const [filterSource, setFilterSource] = useState<SourceItem | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [filterForm, setFilterForm] = useState<FilterForm>(EMPTY_FILTER_FORM);
  const [region, setRegion] = useState('');
  const [operator, setOperator] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeSummary | null>(null);
  const [activeSource, setActiveSource] = useState<SourceItem | null>(null);
  const [lineResults, setLineResults] = useState<Array<{ name?: string; url: string; result: { ok: boolean; speedKbps?: number; resolution?: string; error?: string } }> | null>(null);
  const [requestHeaders, setRequestHeaders] = useState('');
  const [mirrorUrls, setMirrorUrls] = useState('');
  const [fetchMode, setFetchMode] = useState('direct');
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);
  const [fetchTimeoutMs, setFetchTimeoutMs] = useState('45');
  const [fetchConcurrency, setFetchConcurrency] = useState('1');
  const [fetchDelayMs, setFetchDelayMs] = useState('0');
  const [mergeChannelName, setMergeChannelName] = useState('');
  const [mergeChannelGroup, setMergeChannelGroup] = useState('');
  const [healthSort, setHealthSort] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const reputationParam = searchParams.get('reputation');
  const reputationFilter: 'high' | 'normal' | 'low' | null =
    reputationParam === 'high' || reputationParam === 'normal' || reputationParam === 'low' ? reputationParam : null;
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => api.get<{ items: SourceItem[]; reportGeneratedAt?: string | null }>('/api/admin/sources'),
    // A fetch task finishes in the background; keep the cards' 「更新」 times
    // from going stale while the page stays open.
    refetchInterval: 30_000,
  });
  const [overlapOpen, setOverlapOpen] = useState(false);
  const overlap = useQuery({
    queryKey: ['admin', 'sources', 'overlap'],
    queryFn: () =>
      api.get<{
        generatedAt: string | null;
        totalLines: number;
        uniqueUrls: number;
        duplicateUrls: number;
        duplicatedLines: number;
        items: Array<{ id: string; name: string; enabled: boolean; reputation: number; total: number; duplicated: number; unique: number; earliestWins: number; share: number }>;
      }>('/api/admin/sources/overlap'),
    enabled: overlapOpen,
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
        kind,
      }),
    onSuccess: (result) => setPreview(result),
    onError: (error: Error) => { setPreview(null); show(error.message, 'error'); },
  });

  const create = useMutation({
    mutationFn: () => api.post<ProbeSummary>('/api/admin/sources', {
      name: name.trim() || undefined,
      url: mode === 'url' ? url.trim() : undefined,
      content: mode === 'url' ? undefined : content,
      kind,
      skipFetch: mode === 'url' ? skipFetch : undefined,
      refresh_hours: refreshHours.trim() === '' ? null : Number(refreshHours),
      filters: buildFilters(filterForm),
      region: region.trim() || undefined,
      operator: operator.trim() || undefined,
    }),
    onSuccess: (result) => {
      show(`已添加，解析到 ${result.summary?.entries ?? 0} 条`);
      setOpen(false);
      setName(''); setUrl(''); setContent(''); setKind('auto'); setRegion(''); setOperator(''); setSkipFetch(false); setFilterForm(EMPTY_FILTER_FORM); setPreview(null); setRefreshHours('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const saveFilters = useMutation({
    mutationFn: () => {
      let headers: Record<string, string> | undefined;
      if (requestHeaders.trim()) {
        try {
          const parsed = JSON.parse(requestHeaders);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
          headers = parsed as Record<string, string>;
        } catch (error) {
          throw new Error(`请求设置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const mirrorList = mirrorUrls
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5);
      return api.patch(`/api/admin/sources/${filterSource?.id}`, {
        filters: buildFilters(filterForm) ?? {},
        refresh_hours: refreshHours.trim() === '' ? null : Number(refreshHours),
        requestHeaders: headers ?? {},
        allowInsecureTls,
        mirrorUrls: mirrorList,
        fetchMode,
        fetchTimeoutMs: Number(fetchTimeoutMs) * 1000 || 45_000,
        fetchConcurrency: Number(fetchConcurrency) || 1,
        fetchDelayMs: Number(fetchDelayMs) || 0,
        mergeChannelName: mergeChannelName.trim() || null,
        mergeChannelGroup: mergeChannelGroup.trim() || null,
      });
    },
    onSuccess: () => {
      show('源设置已保存，下一轮采集生效');
      setFilterSource(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/sources/${id}/toggle`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] }),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const recover = useMutation({
    mutationFn: (id: string) => api.post<{ message?: string }>(`/api/admin/sources/${id}/recover`),
    onSuccess: (result) => {
      show(result?.message ?? '已重试恢复');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const fetchNow = useMutation({
    mutationFn: (id: string) => api.post<{ message?: string }>(`/api/admin/sources/${id}/fetch-now`),
    onSuccess: (result) => {
      show(result?.message ?? '已派发抓源任务');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tasks'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const favorite = useMutation({
    mutationFn: (source: SourceItem) => api.patch(`/api/admin/sources/${source.id}`, { weight: source.weight >= 2 ? 1 : 2 }),
    onSuccess: () => {
      show('收藏状态已更新');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
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

  const bulk = useMutation({
    mutationFn: async (action: { kind: 'enable' | 'disable' | 'delete' | 'tag' | 'priority'; tag?: string; priority?: number }) => {
      const ids = [...selected];
      const results = await Promise.allSettled(ids.map((id) => {
        if (action.kind === 'delete') return api.del(`/api/admin/sources/${id}`);
        if (action.kind === 'tag') {
          const source = data?.items.find((item) => item.id === id);
          const tags = [...new Set([...(source?.tags ?? []), action.tag ?? ''])].filter(Boolean);
          return api.patch(`/api/admin/sources/${id}`, { tags });
        }
        if (action.kind === 'priority') return api.patch(`/api/admin/sources/${id}`, { priority: action.priority ?? 100 });
        return api.patch(`/api/admin/sources/${id}`, { enabled: action.kind === 'enable' ? 1 : 0 });
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        const first = failed[0] as PromiseRejectedResult;
        const reason = first.reason instanceof Error ? first.reason.message : '请求失败';
        throw new Error(`批量操作部分失败（${ids.length - failed.length}/${ids.length} 成功）：${reason}`);
      }
    },
    onSuccess: () => {
      show('批量操作完成');
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => {
      // Half of the requests may have succeeded; refresh so the UI shows the
      // real state instead of the pre-bulk snapshot.
      show(error.message, 'error');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
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

  const revive = useMutation({
    mutationFn: (id: string) => api.post<{ revived: number; taskId?: string }>('/api/admin/pool/revive', { sourceId: id }),
    onSuccess: (result) => {
      show(`已复活 ${result.revived} 条已淘汰线路${result.taskId ? '，已派发探测' : ''}`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const items = useMemo(() => {
    const all = (data?.items ?? [])
      .filter((source) => !tagFilter || (source.tags ?? []).includes(tagFilter))
      .filter((source) => !reputationFilter || reputationTier(source.reputation ?? 0) === reputationFilter);
    const base = attentionOnly ? all.filter(needsAttention) : all;
    const favorite = (source: SourceItem): number => (source.weight >= 2 ? 1 : 0);
    const added = (source: SourceItem): number => Date.parse(source.created_at) || 0;
    if (!healthSort || !health.data) {
      return [...base].sort((a, b) => favorite(b) - favorite(a) || added(b) - added(a) || a.name.localeCompare(b.name, 'zh-CN'));
    }
    const score = new Map(
      health.data.items.map((item) => {
        const total = item.points.reduce((sum, point) => sum + point.parsed, 0);
        const alive = item.points.reduce((sum, point) => sum + point.alive, 0);
        return [item.sourceId, total ? alive / total : 0];
      }),
    );
    return [...base].sort((a, b) => favorite(b) - favorite(a) || added(b) - added(a) || (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
  }, [data, healthSort, health.data, attentionOnly, tagFilter, reputationFilter]);
  const attentionCount = useMemo(() => (data?.items ?? []).filter(needsAttention).length, [data]);
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const source of data?.items ?? []) for (const tag of source.tags ?? []) tags.add(tag);
    return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [data]);
  const sites = useMemo(() => [...new Set(items.map(sourceSite))], [items]);
  const siteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of items) counts.set(sourceSite(source), (counts.get(sourceSite(source)) ?? 0) + 1);
    return counts;
  }, [items]);
  const healthSummary = useMemo(() => {
    if (!health.data?.items.length) return null;
    let alive = 0;
    let parsed = 0;
    let failToday = 0;
    for (const item of health.data.items) {
      const last = item.points.at(-1);
      if (!last?.fetched) failToday++;
      for (const point of item.points) {
        if (!point.fetched) continue;
        alive += point.alive;
        parsed += point.parsed;
      }
    }
    return {
      average: parsed > 0 ? Math.round((alive / parsed) * 100) : 0,
      failToday,
      sources: health.data.items.length,
    };
  }, [health.data]);

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="SOURCES"
        title="采集站"
        description="这里列出所有采集来源（GitHub 项目 / 自建站点 / 上传文件），可启停、检查、抽样测速或删除。"
        meta={<>信誉分综合可用率、线路质量、抓取成功率：80+ 优质 / 50–79 正常 / &lt;50 降权，会影响探测排序、复测间隔和每轮预算份额。</>}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button onClick={() => setOverlapOpen(true)}><GitCompare size={16} /> 重复线路</Button>
            <Button variant="primary" onClick={() => setOpen(true)}><Plus size={16} /> 添加采集站</Button>
          </div>
        }
      />

      {sites.length ? (
        <div className="source-toolbar">
          <div className="source-toolbar__summary">
            <span className="source-toolbar__icon"><RadioTower size={17} /></span>
            <div>
              <div className="source-toolbar__title">当前采集站</div>
              <div className="caption">{sites.length} 个站点 · {items.length} 个源 · {items.filter((source) => source.enabled).length} 个启用</div>
            </div>
          </div>
          <div className="source-toolbar__sites">
            <details className="source-sites">
              <summary className="source-sites__summary">
                {sites.length} 个站点 <ChevronDown size={13} />
              </summary>
              <div className="source-sites__menu">
                <div className="source-sites__head">站点 · 源数量</div>
                <div className="source-sites__list">
                  {sites.map((site) => (
                    <div className="source-sites__item" key={site}>
                      <span className="truncate">{site}</span>
                      <span className="source-sites__count">{siteCounts.get(site) ?? 0}</span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </div>
          <div className="source-toolbar__actions">
            <div className="source-view-toggle">
              <Button size="sm" variant={view === 'grid' ? 'primary' : 'ghost'} onClick={() => setView('grid')}><LayoutGrid size={14} /> 网格</Button>
              <Button size="sm" variant={view === 'list' ? 'primary' : 'ghost'} onClick={() => setView('list')}><List size={14} /> 列表</Button>
            </div>
            <Button size="sm" variant={attentionOnly ? 'primary' : 'default'} onClick={() => setAttentionOnly((value) => !value)}>
              只看需处理{attentionCount ? `（${attentionCount}）` : ''}
            </Button>
            <Button size="sm" variant={healthSort ? 'primary' : 'default'} onClick={() => setHealthSort((value) => !value)}>
              按 7 天健康排序
            </Button>
          </div>
        </div>
      ) : null}

      {reputationFilter ? (
        <div className="row row--wrap" style={{ gap: 6, alignItems: 'center' }}>
          <Badge tone={reputationFilter === 'high' ? 'green' : reputationFilter === 'normal' ? 'blue' : 'orange'}>
            只看：{reputationFilter === 'high' ? '优质' : reputationFilter === 'normal' ? '正常' : '降权'}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('reputation');
              setSearchParams(next, { replace: true });
            }}
          >
            清除筛选
          </Button>
        </div>
      ) : null}

      {allTags.length ? (
        <div className="row row--wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className="caption">标签：</span>
          <Button size="sm" variant={tagFilter ? 'ghost' : 'primary'} onClick={() => setTagFilter('')}>全部</Button>
          {allTags.map((tag) => (
            <Button key={tag} size="sm" variant={tagFilter === tag ? 'primary' : 'ghost'} onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}>{tag}</Button>
          ))}
        </div>
      ) : null}

      {selected.size ? (
        <Card>
          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Badge tone="orange">已选 {selected.size} 个源</Badge>
            <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ kind: 'enable' })}>批量启用</Button>
            <Button size="sm" loading={bulk.isPending} onClick={() => bulk.mutate({ kind: 'disable' })}>批量停用</Button>
            <Button size="sm" loading={bulk.isPending} onClick={() => {
              const value = window.prompt('输入优先级（数字越小越靠前，默认 100）', '100');
              const priority = Number(value);
              if (value?.trim() && Number.isFinite(priority)) bulk.mutate({ kind: 'priority', priority });
            }}>改优先级</Button>
            <Button size="sm" loading={bulk.isPending} onClick={() => {
              const value = window.prompt('输入标签名（逗号分隔只取第一个，最多 8 个）');
              if (value?.trim()) bulk.mutate({ kind: 'tag', tag: value.split(/[,，]/)[0].trim() });
            }}>加标签</Button>
            <Button size="sm" variant="ghost" loading={bulk.isPending} onClick={() => {
              if (window.confirm(`确认删除选中的 ${selected.size} 个源？`)) bulk.mutate({ kind: 'delete' });
            }}>批量删除</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
          </div>
        </Card>
      ) : null}

      {health.data?.items.length ? (
        <details className="source-health">
          <summary className="source-health__summary">
            <span className="source-health__icon"><Activity size={16} /></span>
            <div className="grow">
              <div className="source-health__title">近 7 天源健康</div>
              <div className="caption">{healthSummary?.sources ?? health.data.items.length} 个源 · 可用 / 解析</div>
            </div>
            <div className="source-health__metrics">
              <span><strong>{healthSummary?.average ?? 0}%</strong><em>平均可用率</em></span>
              <span><strong className={healthSummary?.failToday ? 'is-bad' : undefined}>{healthSummary?.failToday ?? 0}</strong><em>今日失败源</em></span>
            </div>
            <span className="source-health__toggle">明细</span>
          </summary>
          <div className="source-health__body">
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table table--cards">
                <thead>
                  <tr>
                    <th>源</th>
                    {Array.from({ length: health.data.days }, (_, index) => {
                      const date = new Date(Date.now() - (health.data.days - 1 - index) * 86_400_000).toISOString().slice(5, 10);
                      return <th key={date}>{date}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {health.data.items.map((item) => (
                    <tr key={item.sourceId}>
                      <td data-label="源" className="truncate" style={{ maxWidth: 160 }}>{item.name}</td>
                      {Array.from({ length: health.data.days }, (_, index) => {
                        const date = new Date(Date.now() - (health.data.days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
                        const point = item.points.find((entry) => entry.day === date);
                        if (!point) return <td key={date} data-label={date.slice(5)} className="caption">—</td>;
                        const pct = point.parsed ? Math.round((point.alive / point.parsed) * 100) : 0;
                        return (
                          <td key={date} data-label={date.slice(5)} style={{ color: !point.fetched ? 'var(--red)' : pct >= 30 ? 'var(--green)' : 'var(--orange)' }}>
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
          </div>
        </details>
      ) : null}

      {isLoading ? <Card><div className="caption">加载中…</div></Card> : null}
      {isError ? <Card><QueryError title="采集站加载失败" error={error} onRetry={() => void refetch()} /></Card> : null}

      {!isLoading && !items.length ? (
        <EmptyState
          icon={<RadioTower size={24} />}
          title="还没有采集站"
          description="添加一个 M3U / TXT / JSON 订阅，或上传本地列表。格式会自动识别。"
          action={<Button variant="primary" onClick={() => setOpen(true)}>添加第一个采集站</Button>}
        />
      ) : null}

      <div className={`source-grid${view === 'list' ? ' source-grid--list' : ''}`}>
        {items.map((source) => {
          const pendingDue = source.progress?.pending ?? 0;
          const pendingTotal = source.progress?.pendingTotal ?? source.progress?.pending ?? 0;
          const quarantineDue = source.progress?.quarantine ?? 0;
          const quarantineTotal = source.progress?.quarantineTotal ?? source.progress?.quarantine ?? 0;
          const cardTone = !source.enabled ? 'orange' : source.status === 'paused' ? 'orange' : source.status === 'degraded' || source.last_error ? 'red' : (source.alive_count ?? 0) > 0 ? 'green' : 'default';
          const report = source.report;
          const delta = source.delta ?? null;
          const unmatched = source.progress?.unmatched ?? 0;
          const reportReused = report ? report.reused + report.skippedRejected : 0;
          const reportParsed = report ? (report.parsed ?? (report.added + reportReused + (report.skippedTombstoned ?? 0))) : 0;
          return (
            <Card className={`source-card source-card--${cardTone}`} key={source.id}>
              <div className="source-card__head">
                <input
                  type="checkbox"
                  aria-label={`选择 ${source.name}`}
                  checked={selected.has(source.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(source.id)) next.delete(source.id); else next.add(source.id);
                    setSelected(next);
                  }}
                  style={{ marginRight: 8, flexShrink: 0 }}
                />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <Link to={`/admin/sources/${source.id}`} className="source-card__name truncate">{source.name}</Link>
                    {source.weight >= 2 ? <Badge tone="orange">收藏</Badge> : null}
                    {(source.tags ?? []).slice(0, 3).map((tag) => <Badge key={tag} tone="default">{tag}</Badge>)}
                    {source.status === 'degraded' ? <Badge tone="red">抓取异常</Badge> : null}
                    {source.status === 'paused' ? <Badge tone="orange">已暂停</Badge> : null}
                  </div>
                  <div className="row row--wrap" style={{ gap: 5, marginTop: 6 }}>
                    <Badge tone="blue">{sourceSite(source)}</Badge>
                    <Badge>{source.kind.toUpperCase()}</Badge>
                    {source.origin !== 'remote' ? <Badge>{source.origin === 'upload' ? '文件' : '粘贴'}</Badge> : null}
                    <ReputationBadge score={source.reputation} />
                  </div>
                </div>
                <div className="source-card__switch">
                  <Button size="sm" variant="ghost" title={source.weight >= 2 ? '取消收藏' : '收藏'} onClick={() => favorite.mutate(source)}>
                    <Star size={15} fill={source.weight >= 2 ? 'currentColor' : 'none'} color={source.weight >= 2 ? 'var(--orange)' : undefined} />
                  </Button>
                  <Switch checked={source.enabled} onChange={() => toggle.mutate(source.id)} />
                </div>
              </div>

              <div className="source-card__stats">
                <div><strong>{formatNumber(source.progress?.usableTotal ?? source.entry_count ?? 0)}<Delta value={delta?.total ?? null} /></strong><span>线路</span></div>
                <div><strong>{formatNumber(source.alive_count ?? 0)}<Delta value={delta?.alive ?? null} /></strong><span>可用</span></div>
                <div title="变化值相对该源上一轮抓取"><strong>{pendingDue}<Delta value={delta?.pending ?? null} /><em>/{pendingTotal}</em></strong><span>待测</span></div>
                <div title="变化值相对该源上一轮抓取"><strong>{quarantineDue}<Delta value={delta?.quarantine ?? null} /><em>/{quarantineTotal}</em></strong><span>待复测</span></div>
                <div><strong>{formatNumber(source.progress?.rejectedTotal ?? 0)}<Delta value={delta?.rejected ?? null} /></strong><span>已淘汰</span></div>
              </div>

              <div className="source-card__meta-lines">
              {unmatched > 0 ? (
                <div className="caption">另有 {formatNumber(unmatched)} 条未匹配频道/不可探测，未计入以上统计</div>
              ) : null}
              <div className="source-card__meta">
                更新 {timeAgo(source.last_fetch_at ?? source.last_ok_at)} · {source.refresh_hours != null && source.refresh_hours > 0 ? (source.refresh_hours % 24 === 0 ? `每 ${source.refresh_hours / 24} 天` : `每 ${source.refresh_hours}h`) : source.refresh_hours === 0 ? '不自动重抓' : '跟随分档（12/24/72h）'}
                {source.region ? ` · ${source.region}${source.operator ?? ''}` : ''}
              </div>
              <div className="source-card__meta">
                最近成功 {source.last_ok_at ? timeAgo(source.last_ok_at) : '还没有成功过'}
                {source.consecutive_failures ? ` · 连续失败 ${source.consecutive_failures} 次` : ''}
                {source.progress?.channels ? ` · 贡献 ${formatNumber(source.progress.channels)} 个频道` : ''}
              </div>
              {report ? (
                <div className="source-card__meta" title="解析=本轮上游出现的线路总数；新增=池中原本没有；重复=池中已有并按抓取前状态分类；跳过重复=同一 URL 已由别的来源收录（按最早收录保留）；已淘汰=已淘汰线路再次出现、不会回池。卡片上的 +N / -N 是当前值相对本轮抓取前的变化。">
                  来自 {report.fetchedAt ? formatDateTime(report.fetchedAt) : data?.reportGeneratedAt ? formatDateTime(data.reportGeneratedAt) : '上一轮'} 的抓取：解析 {formatNumber(reportParsed)} 条 · 新增 {formatNumber(report.added)} 条 · 重复 {formatNumber(reportReused)} 条{report.reusedAlive !== undefined ? `（可用 ${formatNumber(report.reusedAlive)} · 待测 ${formatNumber(report.reusedPending ?? 0)} · 待复测 ${formatNumber(report.reusedQuarantine ?? 0)}${report.reusedOther ? ` · 其他 ${formatNumber(report.reusedOther)}` : ''} · 已淘汰 ${formatNumber(report.skippedRejected)}）` : '（明细从下一次抓取开始显示）'}
                  {report.skippedDuplicate ? ` · 跳过重复 ${formatNumber(report.skippedDuplicate)} 条` : ''}
                  {report.skippedTombstoned ? ` · 跳过已删除 ${formatNumber(report.skippedTombstoned)}` : ''}
                </div>
              ) : null}
              {report && (report.disappeared || report.retained) ? (
                <div className="source-card__meta">
                  上游消失 {formatNumber(report.disappeared)} 条 · 保留 {formatNumber(report.retained)} 条（保留期内的旧线路仍在池中）
                </div>
              ) : null}
              </div>
              <div className="source-card__error-lines">
              {source.parseDrop ? (
                <div className="source-card__error">解析条数较上轮下降 {source.parseReport?.dropPercent ?? 0}%（{formatNumber(source.parseReport?.entries ?? 0)} 条）</div>
              ) : null}
              {source.feedbackOpen ? (
                <div className="source-card__error">{source.feedbackOpen} 条待处理报障 · 信誉扣 {source.feedbackOpen * 5}</div>
              ) : null}
              {source.last_error ? (
                <div className="source-card__error">
                  {source.lastErrorKind ? `[${errorKindLabel(source.lastErrorKind)}] ` : ''}
                  {source.last_error}
                </div>
              ) : null}
              </div>
              {source.url ? <div className="caption mono truncate source-card__url">{source.url}</div> : null}

              <div className="source-card__actions">
                <Link to={`/admin/sources/${source.id}`}><Button size="sm">详情</Button></Link>
                <Button size="sm" title="只抓这一个源，不跑全量采集" loading={fetchNow.isPending} onClick={() => fetchNow.mutate(source.id)}>抓源</Button>
                {source.status !== 'active' ? (
                  <Button size="sm" title="重试恢复" loading={recover.isPending} onClick={() => recover.mutate(source.id)}>恢复</Button>
                ) : null}
                <Button size="sm" title="检查解析" loading={probe.isPending} onClick={() => probe.mutate(source.id)}>检查</Button>
                <Button size="sm" title="抽样测速" loading={probeLines.isPending} onClick={() => probeLines.mutate(source.id)}>测速</Button>
                <Button size="sm" title="复活本源的已淘汰线路" loading={revive.isPending} onClick={() => revive.mutate(source.id)}>复活</Button>
                <Button size="sm" onClick={() => { setFilterSource(source); setFilterForm(filtersToForm(source.filters)); setRefreshHours(source.refresh_hours == null ? '' : String(source.refresh_hours)); setRequestHeaders(source.requestHeaders && Object.keys(source.requestHeaders).length ? JSON.stringify(source.requestHeaders, null, 2) : ''); setMirrorUrls((source.mirrorUrls ?? []).join('\n')); setFetchMode(source.fetchMode ?? 'direct'); setAllowInsecureTls(Boolean(source.allowInsecureTls)); setFetchTimeoutMs(String(Math.round((source.fetchTimeoutMs ?? 45_000) / 1000))); setFetchConcurrency(String(source.fetchConcurrency ?? 1)); setFetchDelayMs(String(source.fetchDelayMs ?? 0)); setMergeChannelName(source.mergeChannelName ?? ''); setMergeChannelGroup(source.mergeChannelGroup ?? ''); }}>过滤</Button>
                <Button size="sm" title="删除本源" loading={remove.isPending} onClick={() => { if (confirm(`删除「${source.name}」？该源的线路会一起移除。`)) remove.mutate(source.id); }}>删除</Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Sheet
        open={open}
        onClose={() => { setOpen(false); setName(''); setUrl(''); setContent(''); setPreview(null); setKind('auto'); setSkipFetch(false); }}
        title="添加采集站"
        subtitle="支持 M3U / TXT / JSON / TVBox lives / 华为 JSP，自动识别"
        footer={
          <div className="sheet-actions">
            <Button loading={checkDuplicate.isPending} onClick={() => checkDuplicate.mutate()}>
              检查是否已存在
            </Button>
            <Button variant="primary" loading={create.isPending} disabled={preview?.exists} onClick={() => create.mutate()}>
              添加并解析
            </Button>
          </div>
        }
      >
        <div className="stack">
          <div className="source-mode-toggle">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'url', label: '订阅地址' },
                { value: 'paste', label: '粘贴文本' },
                { value: 'file', label: '上传文件' },
              ]}
            />
          </div>
          <div className="sheet-section">基础信息</div>
          <div className="form-grid">
            <Field label="列表格式" hint="自动识别失败时可手动指定">
              <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="auto">自动识别</option>
                <option value="m3u">M3U / M3U8</option>
                <option value="txt">TXT</option>
                <option value="json">JSON / TVBox</option>
                <option value="hwctc">华为 HWCTC</option>
              </select>
            </Field>
            <Field label="名称（可选）">
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：社区 4K 源" />
            </Field>
          </div>
          {mode === 'url' ? (
            <Field label="订阅 URL" hint="仅支持 http/https；添加时会先真实抓取一次并校验可解析。">
              <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/iptv.m3u" inputMode="url" />
            </Field>
          ) : null}
          {mode === 'url' ? (
            <div className="source-check">
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
          <div className="form-grid">
            <Field label="地区（可选）"><input className="input" value={region} onChange={(event) => setRegion(event.target.value)} placeholder="江苏" /></Field>
            <Field label="运营商（可选）"><input className="input" value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="电信" /></Field>
          </div>
          <div className="sheet-section">线路过滤</div>
          <FilterFields form={filterForm} onChange={setFilterForm} />
          <div className="sheet-section">抓取策略</div>
          <Field label="更新间隔（小时）" hint="留空 = 跟随分档（7 天内新源 24h、重点源 12h、其它 72h）；0 = 不自动重抓；24 = 每天；48 = 每 2 天；72 = 每 3 天；96 = 每 4 天；其它数字 = 自定义小时">
            <input className="input" type="number" min={0} value={refreshHours} onChange={(event) => setRefreshHours(event.target.value)} placeholder="留空（跟随分档）" />
          </Field>
          {mode !== 'url' && content ? <div className="caption"><Upload size={12} /> 已读取 {content.length.toLocaleString()} 字符</div> : null}
          {preview ? (
            <div className={`source-preview source-preview--${preview.exists ? 'red' : preview.reachable ? 'green' : 'orange'}`}>
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
            保存设置
          </Button>
        }
      >
        <div className="stack">
          <p className="caption">过滤在采集器解析后生效，不会删除已入库频道；清空后保存即恢复全量。</p>
          <div className="sheet-section">过滤规则</div>
          <FilterFields form={filterForm} onChange={setFilterForm} />
          <div className="sheet-section">更新策略</div>
          <Field label="更新间隔（小时）" hint="留空 = 跟随分档（7 天内新源 24h、重点源 12h、其它 72h）；0 = 不自动重抓；24 = 每天；48 = 每 2 天；72 = 每 3 天；96 = 每 4 天；其它数字 = 自定义小时">
            <input className="input" type="number" min={0} value={refreshHours} onChange={(event) => setRefreshHours(event.target.value)} placeholder="留空（跟随分档）" />
          </Field>
          <div className="sheet-section">合并频道（直播平台）</div>
          <Field label="合并到频道" hint="填了以后，这个源的所有线路都挂到同一个频道；留空则每条线路名一个频道（同名多条线路归到该频道）。">
            <input className="input" value={mergeChannelName} onChange={(event) => setMergeChannelName(event.target.value)} placeholder="留空 = 名称即频道（如 周星星）" />
          </Field>
          <Field label="频道分类" hint="合并频道或按线路名建频道时统一使用的分组，例如 虎牙频道；留空用源自带分组/影视。">
            <input className="input" value={mergeChannelGroup} onChange={(event) => setMergeChannelGroup(event.target.value)} placeholder="例如 虎牙频道" />
          </Field>
          <div className="sheet-section">请求设置</div>
          <details className="stack">
            <summary className="caption">源站要求 UA / Referer / Cookie 时展开填写</summary>
            <Field label="请求头（JSON）" hint="源级请求头覆盖默认 UA；线路级 #EXTVLCOPT 仍然优先。">
              <textarea className="textarea mono" rows={5} value={requestHeaders} onChange={(event) => setRequestHeaders(event.target.value)} placeholder={'{\n  "Referer": "https://example.com/"\n}'} />
            </Field>
          </details>
          <Field label="抓取方式" hint="worker 代拉需要 F3；未上线前按直连处理。">
            <select className="input" value={fetchMode} onChange={(event) => setFetchMode(event.target.value)}>
              <option value="direct">直连（GitHub Actions）</option>
              <option value="worker">Worker 代拉（F3）</option>
            </select>
          </Field>
          <div className="list">
            <div className="list__row">
              <span className="grow">允许证书错误（仅该源）</span>
              <Switch checked={allowInsecureTls} onChange={setAllowInsecureTls} />
            </div>
          </div>
          <div className="caption">站点证书过期或域名不匹配时仍尝试抓取；只影响这个源，默认关闭。</div>
          <Field label="备用地址" hint="主地址失败（404/超时/5xx）时按顺序尝试，每行一个，最多 5 个。">
            <textarea className="textarea mono" rows={3} value={mirrorUrls} onChange={(event) => setMirrorUrls(event.target.value)} placeholder={'https://mirror.example/list.m3u'} />
          </Field>
          <div className="sheet-section">抓取参数（高级）</div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="超时（秒）" hint="该源单独快速失败，不拖整轮；默认 45 秒。">
              <input className="input" type="number" min={2} max={120} value={fetchTimeoutMs} onChange={(event) => setFetchTimeoutMs(event.target.value)} placeholder="45" />
            </Field>
            <Field label="并发" hint="同一源主/备地址并行尝试数；默认 1（顺序）。">
              <input className="input" type="number" min={1} max={4} value={fetchConcurrency} onChange={(event) => setFetchConcurrency(event.target.value)} placeholder="1" />
            </Field>
            <Field label="间隔（毫秒）" hint="抓取该源前的礼貌等待；默认 0。">
              <input className="input" type="number" min={0} max={5000} value={fetchDelayMs} onChange={(event) => setFetchDelayMs(event.target.value)} placeholder="0" />
            </Field>
          </div>
        </div>
      </Sheet>

      <Sheet open={overlapOpen} onClose={() => setOverlapOpen(false)} title="重复线路" subtitle="按规范化 URL 统计；同一 URL 被多个来源收录时只算一条线路">
        {overlap.isLoading ? (
          <div className="caption">统计中…</div>
        ) : overlap.isError ? (
          <QueryError title="统计失败" error={overlap.error} onRetry={() => void overlap.refetch()} />
        ) : overlap.data ? (
          <div className="stack">
            {overlap.data.generatedAt ? (
              <div className="caption">统计生成于 {formatDateTime(overlap.data.generatedAt)}</div>
            ) : null}
            {overlap.data.items.length ? null : (
              <div className="caption">统计尚未生成，下一次发布后可用。</div>
            )}
            <div className="caption">
              共 {formatNumber(overlap.data.totalLines)} 条线路 / {formatNumber(overlap.data.uniqueUrls)} 个 URL；其中{' '}
              {formatNumber(overlap.data.duplicateUrls)} 个 URL 被多个来源收录（涉及 {formatNumber(overlap.data.duplicatedLines)} 条线路）。
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr><th>来源</th><th>线路</th><th>重复</th><th>独有</th><th>重复占比</th><th>最早收录</th></tr>
                </thead>
                <tbody>
                  {overlap.data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="truncate" style={{ maxWidth: 200 }}>{item.name}{item.enabled ? '' : '（已停用）'}</td>
                      <td>{formatNumber(item.total)}</td>
                      <td>{formatNumber(item.duplicated)}</td>
                      <td>{formatNumber(item.unique)}</td>
                      <td>{Math.round(item.share * 100)}%</td>
                      <td className="mono">{formatNumber(item.earliestWins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="caption">
              「最早收录」= 该来源是最早出现某个重复 URL 的次数。独有越多越值得保留；重复占比高、独有少的源可以考虑合并或删除（删源后记得清理它的孤立线路）。
            </div>
          </div>
        ) : null}
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
