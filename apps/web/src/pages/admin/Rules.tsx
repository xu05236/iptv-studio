import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Card, Field, Sheet, Skeleton, Switch, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';

interface RuleMatch {
  groups?: string[];
  namePattern?: string;
  channelPattern?: string;
  protocols?: string[];
  minResolution?: string;
  minSpeedKbps?: number;
  sourceIds?: string[];
  tags?: string[];
}

interface RuleActions {
  exclude?: boolean;
  setGroup?: string;
  addTags?: string[];
  rename?: string;
  setLogo?: string;
}

interface RuleItem {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: RuleMatch;
  actions: RuleActions;
}

interface RuleForm {
  id?: string;
  name: string;
  enabled: boolean;
  priority: number;
  groups: string;
  namePattern: string;
  channelPattern: string;
  protocols: string;
  minResolution: string;
  minSpeedKbps: string;
  sourceIds: string;
  tags: string;
  exclude: boolean;
  setGroup: string;
  addTags: string;
  rename: string;
  setLogo: string;
}

const EMPTY: RuleForm = {
  name: '', enabled: true, priority: 100, groups: '', namePattern: '', channelPattern: '',
  protocols: '', minResolution: '', minSpeedKbps: '', sourceIds: '', tags: '',
  exclude: false, setGroup: '', addTags: '', rename: '', setLogo: '',
};

function split(value: string): string[] {
  return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function toForm(rule: RuleItem): RuleForm {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    groups: (rule.match.groups ?? []).join(','),
    namePattern: rule.match.namePattern ?? '',
    channelPattern: rule.match.channelPattern ?? '',
    protocols: (rule.match.protocols ?? []).join(','),
    minResolution: rule.match.minResolution ?? '',
    minSpeedKbps: rule.match.minSpeedKbps ? String(rule.match.minSpeedKbps) : '',
    sourceIds: (rule.match.sourceIds ?? []).join(','),
    tags: (rule.match.tags ?? []).join(','),
    exclude: Boolean(rule.actions.exclude),
    setGroup: rule.actions.setGroup ?? '',
    addTags: (rule.actions.addTags ?? []).join(','),
    rename: rule.actions.rename ?? '',
    setLogo: rule.actions.setLogo ?? '',
  };
}

function toPayload(form: RuleForm): Omit<RuleItem, 'id'> & { id?: string } {
  return {
    id: form.id,
    name: form.name.trim(),
    enabled: form.enabled,
    priority: Number(form.priority) || 100,
    match: {
      groups: split(form.groups).length ? split(form.groups) : undefined,
      namePattern: form.namePattern.trim() || undefined,
      channelPattern: form.channelPattern.trim() || undefined,
      protocols: split(form.protocols).length ? split(form.protocols) : undefined,
      minResolution: form.minResolution || undefined,
      minSpeedKbps: form.minSpeedKbps ? Number(form.minSpeedKbps) : undefined,
      sourceIds: split(form.sourceIds).length ? split(form.sourceIds) : undefined,
      tags: split(form.tags).length ? split(form.tags) : undefined,
    },
    actions: {
      exclude: form.exclude || undefined,
      setGroup: form.setGroup.trim() || undefined,
      addTags: split(form.addTags).length ? split(form.addTags) : undefined,
      rename: form.rename.trim() || undefined,
      setLogo: form.setLogo.trim() || undefined,
    },
  };
}

function summarize(rule: RuleItem): string {
  const match: string[] = [];
  if (rule.match.groups?.length) match.push(`分组 ${rule.match.groups.join('/')}`);
  if (rule.match.namePattern) match.push(`频道名 ${rule.match.namePattern}`);
  if (rule.match.channelPattern) match.push(`线路名 ${rule.match.channelPattern}`);
  if (rule.match.protocols?.length) match.push(rule.match.protocols.join('/'));
  if (rule.match.minResolution) match.push(`≥${rule.match.minResolution}`);
  if (rule.match.minSpeedKbps) match.push(`≥${rule.match.minSpeedKbps}kbps`);
  if (rule.match.sourceIds?.length) match.push(`源 ${rule.match.sourceIds.length} 个`);
  if (rule.match.tags?.length) match.push(`标签 ${rule.match.tags.join('/')}`);
  return match.length ? match.join(' · ') : '匹配全部';
}

function actionSummary(rule: RuleItem): string {
  const actions: string[] = [];
  if (rule.actions.exclude) actions.push('排除');
  if (rule.actions.setGroup) actions.push(`改分组 ${rule.actions.setGroup}`);
  if (rule.actions.rename) actions.push(`重命名 ${rule.actions.rename}`);
  if (rule.actions.addTags?.length) actions.push(`加标签 ${rule.actions.addTags.join('/')}`);
  if (rule.actions.setLogo) actions.push('设台标');
  return actions.length ? actions.join(' · ') : '无动作';
}

export function Rules() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [form, setForm] = useState<RuleForm>(EMPTY);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]): void => setForm((current) => ({ ...current, [key]: value }));

  const rules = useQuery({
    queryKey: ['admin', 'rules'],
    queryFn: () => api.get<{ items: RuleItem[] }>('/api/admin/rules'),
  });

  const save = useMutation({
    mutationFn: () => api.post<{ rule: RuleItem }>('/api/admin/rules', toPayload(form)),
    onSuccess: () => {
      show('规则已保存，下一轮采集生效');
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'rules'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/admin/rules/${id}`),
    onSuccess: () => {
      show('规则已删除');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'rules'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const toggle = useMutation({
    mutationFn: (rule: RuleItem) => api.post('/api/admin/rules', { ...rule, enabled: !rule.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'rules'] }),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const preview = useMutation({
    mutationFn: () =>
      api.post<{ items: Array<{ input: string; name: string; group: string; matched: string[] }> }>('/api/admin/rules/preview', {
        names: previewText.split('\n').map((line) => line.trim()).filter(Boolean),
      }),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const linePreview = useQuery({
    queryKey: ['admin', 'rules-preview-report'],
    queryFn: () =>
      api.get<{
        report: {
          generatedAt: string;
          changedChannels: number;
          changedLines: number;
          excludedLines: number;
          rules: Array<{ id: string; note: string; matchedLines: number; excludedLines: number; affectedChannels: number }>;
        } | null;
      }>('/api/admin/rules/preview-report'),
    refetchInterval: 60_000,
  });

  const runLinePreview = useMutation({
    mutationFn: () => api.post('/api/admin/runs', { command: 'rules-preview' }),
    onSuccess: () => show('已派发线路级预览，约 5 分钟后点「刷新结果」'),
    onError: (error: Error) => show(error.message, 'error'),
  });

  const items = [...(rules.data?.items ?? [])].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'zh-CN'));

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="RULES"
        title="规则"
        description="用可视化条件过滤/分组/重命名频道或线路，按优先级从高到低执行，下一轮采集生效。"
        actions={<Button variant="primary" onClick={() => { setForm(EMPTY); setOpen(true); }}><Plus size={15} /> 新建规则</Button>}
      />

      <Card>
        <div className="row row--between" style={{ alignItems: 'center' }}>
          <div>
            <div className="title-3">规则预览</div>
            <div className="caption">粘贴一批频道名（每行一个），看看会被分到哪个组、会不会被规则命中。</div>
          </div>
          <Button onClick={() => setPreviewOpen((value) => !value)}>{previewOpen ? '收起' : '打开预览'}</Button>
        </div>
        {previewOpen ? (
          <div style={{ marginTop: 10 }}>
            <textarea
              className="input"
              rows={5}
              style={{ width: '100%', fontFamily: 'monospace' }}
              placeholder={'CCTV-1 综合\n湖南卫视高清\n[V6] 深圳卫视 1080P'}
              value={previewText}
              onChange={(event) => setPreviewText(event.target.value)}
            />
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
              <Button variant="primary" loading={preview.isPending} onClick={() => preview.mutate()}>开始预览</Button>
              <span className="caption">最多 100 行，只做名称清洗/分组/规则匹配，不联网。</span>
            </div>
            {preview.data ? (
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>原始名称</th><th>清洗后名称</th><th>分组</th><th>命中规则</th></tr>
                </thead>
                <tbody>
                  {preview.data.items.map((item, index) => (
                    <tr key={`${item.input}-${index}`}>
                      <td>{item.input}</td>
                      <td>{item.name}</td>
                      <td>{item.group}</td>
                      <td className="caption">{item.matched.length ? item.matched.join(', ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="row row--between row--wrap" style={{ alignItems: 'center', gap: 8 }}>
          <div>
            <div className="title-3">线路级预览（真实目录）</div>
            <div className="caption">用已发布线路 + 当前规则跑一遍，统计每条规则真实命中/排除的线路数；约 5 分钟，消耗一轮 Actions。</div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Button variant="primary" loading={runLinePreview.isPending} onClick={() => runLinePreview.mutate()}>跑一次</Button>
            <Button variant="glass" onClick={() => void linePreview.refetch()}>刷新结果</Button>
          </div>
        </div>
        {linePreview.data?.report ? (
          <>
            <div className="caption" style={{ marginTop: 8 }}>
              生成于 {new Date(linePreview.data.report.generatedAt).toLocaleString('zh-CN', { hour12: false })} · 影响 {linePreview.data.report.changedChannels} 个频道 / {linePreview.data.report.changedLines} 条线路 · 排除 {linePreview.data.report.excludedLines} 条
            </div>
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>规则</th><th>说明</th><th>命中线路</th><th>排除线路</th><th>影响频道</th></tr>
              </thead>
              <tbody>
                {linePreview.data.report.rules.map((row) => (
                  <tr key={row.id}>
                    <td className="mono caption">{row.id.slice(0, 8)}</td>
                    <td>{row.note || '—'}</td>
                    <td>{row.matchedLines}</td>
                    <td>{row.excludedLines}</td>
                    <td>{row.affectedChannels}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="caption" style={{ marginTop: 8 }}>还没有预览结果，点「跑一次」。</div>
        )}
      </Card>

      {rules.isLoading ? <Skeleton height={160} radius={16} /> : null}
      {!rules.isLoading && !items.length ? (
        <Card className="rule-empty">
          <div className="rule-empty__icon"><Filter size={20} /></div>
          <div>
            <div className="title-3">还没有规则</div>
            <div className="caption">规则可以排除垃圾频道、把频道归到正确分组、批量改台标或重命名。新规则在下一轮采集生效。</div>
          </div>
          <Button variant="primary" onClick={() => { setForm(EMPTY); setOpen(true); }}><Plus size={15} /> 新建规则</Button>
        </Card>
      ) : null}

      {items.length ? (
        <div className="rule-stats">
          <div><strong>{items.length}</strong><span>规则总数</span></div>
          <div><strong>{items.filter((rule) => rule.enabled).length}</strong><span>已启用</span></div>
          <div><strong>{items.filter((rule) => rule.actions.exclude).length}</strong><span>排除规则</span></div>
          <div><strong>{Math.max(...items.map((rule) => rule.priority), 0)}</strong><span>最高优先级</span></div>
        </div>
      ) : null}

      <div className="rule-grid">
        {items.map((rule) => (
          <Card className={`rule-card rule-card--${rule.enabled ? 'green' : 'default'}`} key={rule.id}>
            <div className="rule-card__head">
              <div className="grow">
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="rule-card__name">{rule.name}</span>
                  <Badge tone={rule.enabled ? 'green' : 'default'}>{rule.enabled ? '启用' : '停用'}</Badge>
                  <Badge>优先级 {rule.priority}</Badge>
                  {rule.actions.exclude ? <Badge tone="red">排除</Badge> : null}
                </div>
              </div>
              <Switch checked={rule.enabled} onChange={() => toggle.mutate(rule)} />
            </div>
            <div className="rule-card__section">
              <div className="rule-card__label">匹配条件</div>
              <div className="rule-card__text">{summarize(rule)}</div>
            </div>
            <div className="rule-card__section">
              <div className="rule-card__label">执行动作</div>
              <div className="rule-card__text">{actionSummary(rule)}</div>
            </div>
            <div className="rule-card__actions">
              <Button size="sm" onClick={() => { setForm(toForm(rule)); setOpen(true); }}><Pencil size={13} /> 编辑规则</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`删除规则「${rule.name}」？`)) remove.mutate(rule.id); }}><Trash2 size={13} /> 删除</Button>
            </div>
          </Card>
        ))}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? '编辑规则' : '新建规则'}
        footer={<Button block variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={() => save.mutate()}>保存规则</Button>}
      >
        <div className="stack">
          <div className="sheet-section">基础信息</div>
          <div className="form-grid">
            <Field label="规则名称"><input className="input" value={form.name} onChange={(event) => set('name', event.target.value)} /></Field>
            <Field label="优先级" hint="数字越大越先执行"><input className="input" inputMode="numeric" value={form.priority} onChange={(event) => set('priority', Number(event.target.value))} /></Field>
          </div>
          <div className="list">
            <div className="list__row"><span className="grow">启用规则</span><Switch checked={form.enabled} onChange={(value) => set('enabled', value)} /></div>
          </div>

          <div className="sheet-section">匹配条件</div>
          <div className="form-grid">
            <Field label="分组" hint="逗号分隔，例如 央视,卫视"><input className="input" value={form.groups} onChange={(event) => set('groups', event.target.value)} /></Field>
            <Field label="频道名包含" hint="支持正则表达式"><input className="input" value={form.namePattern} onChange={(event) => set('namePattern', event.target.value)} /></Field>
            <Field label="线路名包含" hint="支持正则表达式"><input className="input" value={form.channelPattern} onChange={(event) => set('channelPattern', event.target.value)} /></Field>
            <Field label="协议" hint="hls,http,rtmp"><input className="input" value={form.protocols} onChange={(event) => set('protocols', event.target.value)} /></Field>
            <Field label="最低分辨率"><select className="input" value={form.minResolution} onChange={(event) => set('minResolution', event.target.value)}><option value="">不限</option><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2160p">2160p</option></select></Field>
            <Field label="最低速率 (kbps)"><input className="input" inputMode="numeric" value={form.minSpeedKbps} onChange={(event) => set('minSpeedKbps', event.target.value)} /></Field>
          </div>
          <Field label="采集站 ID" hint="逗号分隔，留空表示所有源"><input className="input" value={form.sourceIds} onChange={(event) => set('sourceIds', event.target.value)} /></Field>
          <Field label="标签" hint="逗号分隔"><input className="input" value={form.tags} onChange={(event) => set('tags', event.target.value)} /></Field>

          <div className="sheet-section">执行动作</div>
          <div className="list">
            <div className="list__row"><span className="grow">排除匹配的线路</span><Switch checked={form.exclude} onChange={(value) => set('exclude', value)} /></div>
          </div>
          <div className="form-grid">
            <Field label="改分组"><input className="input" value={form.setGroup} onChange={(event) => set('setGroup', event.target.value)} /></Field>
            <Field label="重命名"><input className="input" value={form.rename} onChange={(event) => set('rename', event.target.value)} /></Field>
          </div>
          <Field label="追加标签" hint="逗号分隔"><input className="input" value={form.addTags} onChange={(event) => set('addTags', event.target.value)} /></Field>
          <Field label="设置台标 URL"><input className="input" value={form.setLogo} onChange={(event) => set('setLogo', event.target.value)} /></Field>
        </div>
      </Sheet>
    </div>
  );
}
