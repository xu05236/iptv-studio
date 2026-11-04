import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
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

  const items = [...(rules.data?.items ?? [])].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'zh-CN'));

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="RULES"
        title="规则"
        description="用可视化条件过滤/分组/重命名频道或线路，按优先级从高到低执行，下一轮采集生效。"
        actions={<Button variant="primary" onClick={() => { setForm(EMPTY); setOpen(true); }}><Plus size={15} /> 新建规则</Button>}
      />

      {rules.isLoading ? <Skeleton height={160} radius={16} /> : null}

      {!rules.isLoading && !items.length ? (
        <Card><div className="caption">还没有规则。规则可以排除垃圾频道、把频道归到正确分组、批量改台标或重命名。</div></Card>
      ) : null}

      <div className="stack">
        {items.map((rule) => (
          <Card key={rule.id}>
            <div className="row row--between row--wrap" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="title-3">{rule.name}</span>
                  <Badge tone={rule.enabled ? 'green' : 'default'}>{rule.enabled ? '启用' : '停用'}</Badge>
                  <Badge>优先级 {rule.priority}</Badge>
                  {rule.actions.exclude ? <Badge tone="red">排除</Badge> : null}
                </div>
                <div className="caption" style={{ marginTop: 4 }}>条件：{summarize(rule)}</div>
                <div className="caption">动作：{actionSummary(rule)}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Switch checked={rule.enabled} onChange={() => toggle.mutate(rule)} />
                <Button size="sm" variant="glass" onClick={() => { setForm(toForm(rule)); setOpen(true); }}><Pencil size={13} /> 编辑</Button>
                <Button size="sm" variant="danger" onClick={() => { if (window.confirm(`删除规则「${rule.name}」？`)) remove.mutate(rule.id); }}><Trash2 size={13} /></Button>
              </div>
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
          <div className="row">
            <div className="grow"><Field label="规则名称"><input className="input" value={form.name} onChange={(event) => set('name', event.target.value)} /></Field></div>
            <div className="grow"><Field label="优先级" hint="数字越大越先执行"><input className="input" inputMode="numeric" value={form.priority} onChange={(event) => set('priority', Number(event.target.value))} /></Field></div>
          </div>
          <div className="list">
            <div className="list__row"><span className="grow">启用规则</span><Switch checked={form.enabled} onChange={(value) => set('enabled', value)} /></div>
          </div>

          <div className="title-3" style={{ fontSize: 14 }}>匹配条件</div>
          <div className="row">
            <div className="grow"><Field label="分组" hint="逗号分隔，例如 央视,卫视"><input className="input" value={form.groups} onChange={(event) => set('groups', event.target.value)} /></Field></div>
            <div className="grow"><Field label="频道名包含" hint="支持正则表达式"><input className="input" value={form.namePattern} onChange={(event) => set('namePattern', event.target.value)} /></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="线路名包含" hint="支持正则表达式"><input className="input" value={form.channelPattern} onChange={(event) => set('channelPattern', event.target.value)} /></Field></div>
            <div className="grow"><Field label="协议" hint="hls,http,rtmp"><input className="input" value={form.protocols} onChange={(event) => set('protocols', event.target.value)} /></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="最低分辨率"><select className="input" value={form.minResolution} onChange={(event) => set('minResolution', event.target.value)}><option value="">不限</option><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2160p">2160p</option></select></Field></div>
            <div className="grow"><Field label="最低速率 (kbps)"><input className="input" inputMode="numeric" value={form.minSpeedKbps} onChange={(event) => set('minSpeedKbps', event.target.value)} /></Field></div>
          </div>
          <Field label="采集站 ID" hint="逗号分隔，留空表示所有源"><input className="input" value={form.sourceIds} onChange={(event) => set('sourceIds', event.target.value)} /></Field>
          <Field label="标签" hint="逗号分隔"><input className="input" value={form.tags} onChange={(event) => set('tags', event.target.value)} /></Field>

          <div className="title-3" style={{ fontSize: 14 }}>执行动作</div>
          <div className="list">
            <div className="list__row"><span className="grow">排除匹配的线路</span><Switch checked={form.exclude} onChange={(value) => set('exclude', value)} /></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="改分组"><input className="input" value={form.setGroup} onChange={(event) => set('setGroup', event.target.value)} /></Field></div>
            <div className="grow"><Field label="重命名"><input className="input" value={form.rename} onChange={(event) => set('rename', event.target.value)} /></Field></div>
          </div>
          <Field label="追加标签" hint="逗号分隔"><input className="input" value={form.addTags} onChange={(event) => set('addTags', event.target.value)} /></Field>
          <Field label="设置台标 URL"><input className="input" value={form.setLogo} onChange={(event) => set('setLogo', event.target.value)} /></Field>
        </div>
      </Sheet>
    </div>
  );
}
