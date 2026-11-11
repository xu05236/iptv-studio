import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CalendarClock, HardDrive, Save, ShieldAlert, SlidersHorizontal, Wrench } from 'lucide-react';
import { activeProbeProfile, type AppSettings } from '@iptv/core';
import { api } from '../../lib/api';
import type { SettingsResponse } from '../../lib/types';
import { Badge, Button, Card, Field, Segmented, Skeleton, Switch, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { RulesGuide } from '../../components/RulesGuide';

/** Rough measurements from the 2026-10-30 1200-budget run (probe ~2 min / 302 MB). */
const BUDGET_TIERS = [
  { budget: 600, probe: '约 1 分钟', run: '5–6 分钟', traffic: '约 150 MB', kv: '30–50 次', actions: '约 6 分钟' },
  { budget: 1200, probe: '约 2 分钟', run: '8–10 分钟', traffic: '约 300 MB', kv: '30–50 次', actions: '约 10 分钟' },
  { budget: 3000, probe: '约 5 分钟', run: '13–16 分钟', traffic: '约 750 MB', kv: '30–50 次', actions: '约 15 分钟' },
  { budget: 6000, probe: '约 10 分钟', run: '20–25 分钟', traffic: '约 1.5 GB', kv: '30–50 次', actions: '约 25 分钟' },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [form, setForm] = useState<AppSettings | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<SettingsResponse>('/api/admin/settings'),
  });

  const schedule = useQuery({
    queryKey: ['admin', 'schedule'],
    queryFn: () => api.get<{
      enabled: boolean;
      times: string;
      budget: number;
      nextAt: string | null;
      lastRunAt: string | null;
      result: string | null;
      liveness: { enabled: boolean; times: string; nextAt: string | null; lastRunAt: string | null; lastScheduledAt: string | null; result: string | null };
    }>('/api/admin/schedule'),
  });

  const storage = useQuery({
    queryKey: ['admin', 'storage-sizes'],
    queryFn: () =>
      api.get<{
        items: Array<{ key: string; bytes: number }>;
        totalBytes: number;
        thresholds: { warnMb: number; blockMb: number };
        lastPublish: { generatedAt?: string } | null;
      }>('/api/admin/storage/sizes'),
  });

  const maintenance = useMutation({
    mutationFn: async (action: 'orphans' | 'logos') =>
      action === 'orphans'
        ? api.post<{ message: string }>('/api/admin/runs/dispatch', { command: 'cleanup-orphans', source: 'manual' })
        : api.post<{ cleaned: number }>('/api/admin/db/clean-logo-names'),
    onSuccess: (result) => {
      show('message' in result ? result.message : `已清理 ${result.cleaned} 条旧台标`);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  useEffect(() => {
    if (data?.settings) {
      setForm(data.settings);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put<{ settings: AppSettings }>('/api/admin/settings', { ...form }),
    onSuccess: () => {
      show('设置已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'schedule'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  if (isLoading || !form) {
    return <div className="stack"><Skeleton height={34} width={200} /><Skeleton height={400} radius={16} /></div>;
  }

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => setForm({ ...form, [key]: value });

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="SETTINGS"
        title="设置"
        description="影响下一轮采集、测速预算与导出行为。"
        actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}><Save size={15} /> 保存设置</Button>}
      />

      <nav className="settings-nav">
        <a href="#settings-basic">台标</a>
        <a href="#settings-probe">采集与探测</a>
        <a href="#settings-schedule">定时任务</a>
        <a href="#settings-notify">通知与保留</a>
        <a href="#settings-advanced">高级</a>
        <a href="#settings-maintenance">维护</a>
      </nav>

      <div className="settings-status">
        <span className="settings-status__label">当前状态</span>
        <div><span>自动采集</span><Badge tone={form.autoCollectEnabled ? 'green' : 'default'}>{form.autoCollectEnabled ? '开启' : '关闭'}</Badge></div>
        <div><span>分批探测</span><Badge tone={form.autoProbeEnabled ? 'green' : 'default'}>{form.autoProbeEnabled ? '开启' : '关闭'}</Badge></div>
        <div><span>自动发布</span><Badge tone={form.autoPublishEnabled ? 'green' : 'default'}>{form.autoPublishEnabled ? '开启' : '关闭'}</Badge></div>
      </div>

      <div className="settings-overview">
        <div><span>采集预算</span><strong>{form.probeBudget.toLocaleString('zh-CN')}</strong><em>条 / 轮</em></div>
        <div><span>并发数</span><strong>{form.concurrency}</strong><em>条同时探测</em></div>
        <div><span>分批间隔</span><strong>{activeProbeProfile(form).intervalHours}</strong><em>小时 / 批</em></div>
        <div><span>每日发布</span><strong>{form.autoPublishEnabled ? (form.autoPublishTimes ?? '08:30') : '关闭'}</strong><em>北京时间</em></div>
      </div>

      <Card>
        <details>
          <summary className="title-3" style={{ cursor: 'pointer' }}>规则说明（信誉分 / 线路池 / 预算）</summary>
          <div style={{ marginTop: 12 }}>
            <RulesGuide scope="admin" />
          </div>
        </details>
      </Card>

      <div id="settings-basic" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><SlidersHorizontal size={17} /></span>
          <div><div className="title-3">台标</div><div className="caption">台标地址、地区后缀与线路补偿</div></div>
        </div>
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="台标基础地址" hint="订阅或源自带 tvg-logo 优先；缺失时按 tvg-id 拼接。旧 fanmingming 地址会自动改用 jsDelivr；前台还会依次回退 Fastly / Gcore / testingcf / ghproxy / gh-proxy / 多个 fork / vircloud / GitHub raw。">
            <input className="input" value={form.logoBaseUrl} onChange={(event) => set('logoBaseUrl', event.target.value)} />
          </Field>
          <div className="list">
            <div className="list__row"><span className="grow" title="开启后线路名会带上地区/运营商，便于区分同名频道">线路名带地区/运营商后缀</span><Switch checked={form.regionSuffix} onChange={(value) => set('regionSuffix', value)} /></div>
            <div className="list__row"><span className="grow" title="频道没有任何可用线路时，是否回填可疑线路避免订阅空白">补偿机制（频道无可用时回填可疑线路）</span><Switch checked={form.compensate} onChange={(value) => set('compensate', value)} /></div>
            <div className="list__row"><span className="grow" title="允许可疑线路参与导出；关闭后只导出确认可用的线路">允许可疑线路作为兜底</span><Switch checked={form.keepSuspect} onChange={(value) => set('keepSuspect', value)} /></div>
          </div>
          <div className="caption">补偿只在频道没有可用线路时生效；兜底线路会降低稳定性，建议只在覆盖优先时开启。</div>
        </div>
      </Card>

      <div id="settings-probe" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><Activity size={17} /></span>
          <div><div className="title-3">采集与探测</div><div className="caption">预算、并发、复测间隔与预筛</div></div>
        </div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="grow"><Field label="采集预算（条）" hint="手动/定时触发未显式指定时使用；按未测 / 到期复检自动折算"><input className="input" inputMode="numeric" value={form.probeBudget} onChange={(event) => set('probeBudget', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="并发数" hint="同时探测的线路数；越高越快，但过高容易误判或被源站限速"><input className="input" inputMode="numeric" value={form.concurrency} onChange={(event) => set('concurrency', Number(event.target.value))} /></Field></div>
          </div>
          <div className="table-wrap" style={{ marginTop: 4 }}>
            <table className="table table--cards">
              <thead>
                <tr><th>预算</th><th>探测耗时</th><th>整轮耗时</th><th>探测流量</th><th>KV 写入</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {BUDGET_TIERS.map((row) => (
                  <tr key={row.budget} style={row.budget === form.probeBudget ? { background: 'rgba(245, 165, 36, 0.08)' } : undefined}>
                    <td data-label="预算">{row.budget}</td>
                    <td data-label="探测耗时">{row.probe}</td>
                    <td data-label="整轮耗时">{row.run}</td>
                    <td data-label="探测流量">{row.traffic}</td>
                    <td data-label="KV 写入">{row.kv}</td>
                    <td data-label="Actions">{row.actions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="caption">
            估算基于一次 1200 预算的实测：探测约 2 分钟 / 302 MB，整轮 8–10 分钟；KV 写入主要随发布固定，不随预算线性增长。
          </div>
          <div className="row">
            <div className="grow"><Field label="可用线路复测间隔（小时）" hint="每次探测通过自动 +3 天，上限 30 天"><input className="input" inputMode="numeric" value={form.probeAliveHours ?? 360} onChange={(event) => set('probeAliveHours', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="精品线路复测间隔（小时）" hint="默认 168 小时（7 天）"><input className="input" inputMode="numeric" value={form.probePremiumHours ?? 168} onChange={(event) => set('probePremiumHours', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="每频道每轮最多探测" hint="防止单个大频道吃掉整轮预算"><input className="input" inputMode="numeric" value={form.probePerChannel ?? 24} onChange={(event) => set('probePerChannel', Number(event.target.value))} /></Field></div>
          </div>
          <div className="list">
            <div className="list__row"><span className="grow">采集前轻量测活预筛（pending / suspect）</span><Switch checked={form.probePrefilterEnabled ?? true} onChange={(value) => set('probePrefilterEnabled', value)} /></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="每轮预筛条数" hint="先用清单 / 2KB 检查，通过后才进入完整测速；0 = 关闭"><input className="input" inputMode="numeric" value={form.probePrefilterBudget ?? 1200} onChange={(event) => set('probePrefilterBudget', Number(event.target.value))} /></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="ffprobe 每轮补全条数" hint="每轮最多用 ffprobe 实测多少条缺分辨率的 alive 线路；调大更完整但整轮更慢，0 = 关闭"><input className="input" inputMode="numeric" value={form.ffprobeLimit ?? 150} onChange={(event) => set('ffprobeLimit', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="线路留存天数" hint="源刷新不再列出后，已测线路仍保留的天数"><input className="input" inputMode="numeric" value={form.lineRetentionDays ?? 30} onChange={(event) => set('lineRetentionDays', Number(event.target.value))} /></Field></div>
          </div>
          <div className="caption">
            超时 9 秒、预热丢弃 512 KB、采样 1.5 秒、发布前冷却 60 秒已内置（调这些会影响误判率和测速准确性，不建议开放）。
          </div>
          <Field label="已淘汰线路保留天数" hint="线路进入已淘汰终态后保留的天数；到期由清理任务删除并写入墓碑，防止重抓再入">
            <input className="input" inputMode="numeric" value={form.rejectedRetentionDays ?? 30} onChange={(event) => set('rejectedRetentionDays', Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <div id="settings-schedule" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><CalendarClock size={17} /></span>
          <div><div className="title-3">定时任务</div><div className="caption">每一类定时各管什么；日常通常只需要「抓源 + 分批探测 + 每日发布」</div></div>
        </div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="caption" style={{ lineHeight: 1.7 }}>
            完整采集＝抓源＋探测＋发布＋EPG 全部串一遍，日常不用开，首次搭建或兜底时手动跑一次即可；
            抓源＝只重抓已有源，新增/导入源时系统仍会立刻抓一次，不受这个开关影响；
            分批探测＝只测线路，决定可用 / 待复测 / 淘汰；
            每日发布＝只重算产物与订阅，不抓源也不探测；
            池内测活＝只做轻量连通性检查，不做测速。
          </div>
          <div className="title-3" style={{ fontSize: 14 }}>完整采集</div>
          <div className="list">
            <div className="list__row"><span className="grow">启用定时采集（默认关闭）</span><Switch checked={form.autoCollectEnabled ?? false} onChange={(value) => set('autoCollectEnabled', value)} /></div>
          </div>
          <Field label="每天运行时刻（北京时间）" hint="HH:mm，多个用逗号分隔，例如 08:30 或 08:30, 20:30；建议在 08:00 额度重置后">
            <input className="input" value={form.autoCollectTimes ?? '08:30'} onChange={(event) => set('autoCollectTimes', event.target.value)} />
          </Field>
          <div className="caption">
            完整采集会把抓源、探测、发布、EPG 串成一次长任务（约 7 分钟 Actions）。日常不需要开；只有首次搭建、改过产物结构或想兜底时才手动跑一次。
            预算沿用上方「采集预算」；保护：KV 写入 ≥920 或已有任务在跑时自动跳过；时区固定北京时间（UTC+8）。
            {schedule.data?.nextAt ? ` 下次：${new Date(schedule.data.nextAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ' 当前未启用。'}
            {schedule.data?.lastRunAt ? ` · 上次：${new Date(schedule.data.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${schedule.data.result ?? '未知'}）` : ''}
          </div>

          <div className="title-3" style={{ fontSize: 14, marginTop: 8 }}>每日池内测活</div>
          <div className="list">
            <div className="list__row"><span className="grow">启用每日池内测活（只查连通性，不做测速）</span><Switch checked={form.autoLivenessEnabled ?? true} onChange={(value) => set('autoLivenessEnabled', value)} /></div>
          </div>
          <Field label="每天测活时刻（北京时间）" hint="HH:mm，多个用逗号分隔；只检查池内 alive 线路，不做测速">
            <input className="input" value={form.autoLivenessTimes ?? '20:30'} onChange={(event) => set('autoLivenessTimes', event.target.value)} />
          </Field>
          <div className="caption">
            分批探测每天能覆盖全部池内线路（1200 条/批 × 约 3 批/天）时，这项可以关，省一次 Actions；留着手动按钮应急即可。
            {schedule.data?.liveness?.nextAt ? ` 下次：${new Date(schedule.data.liveness.nextAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ' 当前未启用。'}
            {schedule.data?.liveness?.lastRunAt ? ` · 上次：${new Date(schedule.data.liveness.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${schedule.data.liveness.result ?? '未知'}）` : ''}
          </div>

          <div className="title-3" style={{ fontSize: 14, marginTop: 8 }}>分批探测</div>
          <div className="list">
            <div className="list__row"><span className="grow">启用自动分批探测（pending → 待复测 → 已淘汰）</span><Switch checked={form.autoProbeEnabled ?? true} onChange={(value) => set('autoProbeEnabled', value)} /></div>
          </div>
          <div className="title-3" style={{ fontSize: 14, marginTop: 8 }}>Actions 仓库模式与探测模板</div>
          <Field label="仓库模式" hint="私有仓库有 2,000 分钟额度，按保守模板调度；公开仓库标准运行不计费，可用更高的频率和批量。切换后立即按新模板生效。">
            <Segmented
              value={form.actionsRepoMode ?? 'private'}
              onChange={(value) => set('actionsRepoMode', value as 'private' | 'public')}
              options={[
                { label: '私有（额度限制）', value: 'private' },
                { label: '公开（不计费）', value: 'public' },
              ]}
            />
          </Field>
          {form.actionsRepoMode === 'public' ? (
            <div className="card" style={{ padding: 12 }}>
              <div className="title-3" style={{ fontSize: 13 }}>公开模板</div>
              <div className="row">
                <div className="grow"><Field label="每批条数"><input className="input" inputMode="numeric" value={form.publicProbeBatchSize ?? 2000} onChange={(event) => set('publicProbeBatchSize', Number(event.target.value))} /></Field></div>
                <div className="grow"><Field label="批次间隔（小时）"><input className="input" inputMode="numeric" value={form.publicProbeIntervalHours ?? 2} onChange={(event) => set('publicProbeIntervalHours', Number(event.target.value))} /></Field></div>
                <div className="grow"><Field label="每日派发上限"><input className="input" inputMode="numeric" value={form.publicMaxDailyDispatches ?? 30} onChange={(event) => set('publicMaxDailyDispatches', Number(event.target.value))} /></Field></div>
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: 12 }}>
              <div className="title-3" style={{ fontSize: 13 }}>私有模板</div>
              <div className="row">
                <div className="grow"><Field label="每批条数"><input className="input" inputMode="numeric" value={form.privateProbeBatchSize ?? 1200} onChange={(event) => set('privateProbeBatchSize', Number(event.target.value))} /></Field></div>
                <div className="grow"><Field label="批次间隔（小时）"><input className="input" inputMode="numeric" value={form.privateProbeIntervalHours ?? 8} onChange={(event) => set('privateProbeIntervalHours', Number(event.target.value))} /></Field></div>
                <div className="grow"><Field label="每日派发上限"><input className="input" inputMode="numeric" value={form.privateMaxDailyDispatches ?? 20} onChange={(event) => set('privateMaxDailyDispatches', Number(event.target.value))} /></Field></div>
              </div>
            </div>
          )}
          <div className="caption">
            只显示当前模式对应的模板；另一套参数会保留，切回去时不变。当前生效（{form.actionsRepoMode === 'public' ? '公开' : '私有'}）：每批 {activeProbeProfile(form).batchSize} 条 · 间隔 {activeProbeProfile(form).intervalHours} 小时 · 每天最多 {activeProbeProfile(form).maxDailyDispatches} 批。阶段顺序、提升/延后、暂停在概览页「检测任务」里调整；KV 写入 ≥920 时队列仍会自动暂停。
          </div>

          <div className="title-3" style={{ fontSize: 14, marginTop: 8 }}>抓源</div>
          <div className="list">
            <div className="list__row"><span className="grow">启用定时抓源（只重抓已有源）</span><Switch checked={form.autoFetchEnabled ?? true} onChange={(value) => set('autoFetchEnabled', value)} /></div>
          </div>
          <Field label="抓取间隔（天）" hint="按天定时：每天 / 每 2 天 / … / 每 7 天。与下面的时段配合使用：例如「每 2 天」+「06:30」= 隔天 06:30 抓一次；中间日期到点会自动跳过">
            <select className="select" value={form.fetchIntervalDays ?? 1} onChange={(event) => set('fetchIntervalDays', Number(event.target.value))}>
              {[1, 2, 3, 4, 5, 6, 7].map((days) => (
                <option key={days} value={days}>{days === 1 ? '每天' : `每 ${days} 天`}</option>
              ))}
            </select>
          </Field>
          <Field label="抓取时段（北京时间）" hint="固定定时或自定义多时段：可填 1 个或多个时刻，逗号分隔，例如 06:30 或 06:30,12:30,18:30；到点只抓源，新线路进 pending 后由分批探测处理">
            <input className="input" value={form.fetchTimes ?? '06:30'} onChange={(event) => set('fetchTimes', event.target.value)} />
          </Field>
          <div className="caption">新增/导入源时系统会立刻建一次抓源任务，与这个开关无关；这里只控制已有源的定期重抓。单源覆盖：采集站 → 过滤 / 更新策略 → 更新间隔（留空跟随分档，0 = 不自动重抓，24 = 每天，48 = 每 2 天）。分档规则：7 天内新源 24 小时、重点源（权重 ≥ 2）12 小时、其它 72 小时。</div>

          <div className="title-3" style={{ fontSize: 14, marginTop: 8 }}>每日发布</div>
          <div className="list">
            <div className="list__row"><span className="grow">启用每日发布（只更新 EPG/catalog，不探测）</span><Switch checked={form.autoPublishEnabled ?? true} onChange={(value) => set('autoPublishEnabled', value)} /></div>
          </div>
          <Field label="每天发布时刻（北京时间）" hint="只更新线路相关产物，不抓 EPG；可填多个时刻，用逗号分隔">
            <input className="input" value={form.autoPublishTimes ?? '08:30'} onChange={(event) => set('autoPublishTimes', event.target.value)} />
          </Field>
          <Field label="自动发布最小间隔（小时）" hint="探测更新线路池后，自动发布至少间隔多久；默认 6 小时，填 0 表示不限制（每次探测后都可发布）">
            <input className="input" inputMode="numeric" value={form.autoPublishIntervalHours ?? 6} onChange={(event) => set('autoPublishIntervalHours', Math.max(0, Number(event.target.value) || 0))} />
          </Field>
          <div className="list">
            <div className="list__row">
              <span className="grow">探测后自动发布（关闭后只按每日时刻发布）</span>
              <Switch checked={form.autoPublishAfterProbeEnabled ?? false} onChange={(value) => set('autoPublishAfterProbeEnabled', value)} />
            </div>
          </div>
        </div>
      </Card>

      <div id="settings-notify" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><CalendarClock size={17} /></span>
          <div><div className="title-3">通知与保留</div><div className="caption">Telegram 日报、截帧验证与快照保留；EPG 设置已移到「EPG 覆盖与映射」页。</div></div>
        </div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="list__row"><span className="grow">Telegram 日报（需在 Actions 配置 Secret）</span><Switch checked={form.notifyTelegram} onChange={(value) => set('notifyTelegram', value)} /></div>
            <div className="list__row"><span className="grow">每日截帧验证（需 runner 支持 ffmpeg）</span><Switch checked={form.screenshots} onChange={(value) => set('screenshots', value)} /></div>
          </div>
          <Field label="快照保留天数" hint="历史 catalog/index/订阅快照和日志、截图的保留天数，超过后由清理 cron 删除">
            <input className="input" inputMode="numeric" value={form.retentionDays} onChange={(event) => set('retentionDays', Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <div id="settings-advanced" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon settings-card__icon--warning"><ShieldAlert size={17} /></span>
          <div><div className="title-3">高级</div><div className="caption">中继与前台直连播放，涉及流量和使用条款</div></div>
        </div>
        <div className="list" style={{ marginTop: 10 }}>
          <div className="list__row">
            <div className="grow">
              <div className="list__title">开启 HLS 中继</div>
              <div className="caption">解决源站 CORS 限制，但视频流量将经过 Worker，可能不符合 Cloudflare 使用条款，请自行评估。</div>
            </div>
            <Switch checked={form.relayEnabled} onChange={(value) => set('relayEnabled', value)} />
          </div>
          <div className="list__row">
            <div className="grow">
              <div className="list__title">允许前台直连播放</div>
              <div className="caption">开启后公开接口会返回真实线路地址，浏览器可用你的网络绕过 Cloudflare 的 IP 限制；地址可能被爬取，请自行评估。</div>
            </div>
            <Switch checked={form.directPlayback} onChange={(value) => set('directPlayback', value)} />
          </div>
        </div>
        <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <Field label="每 token 日请求上限" hint="默认 20000；实例内存计数，重启清零">
            <input className="input" type="number" min={100} max={1000000} value={form.relayDailyRequests} onChange={(event) => set('relayDailyRequests', Number(event.target.value) || 20000)} />
          </Field>
          <Field label="每 token 日流量上限（GB）" hint="默认 2 GB；用尽后中继返回 429，新清单自动回退直连">
            <input
              className="input"
              type="number"
              min={0.1}
              step={0.1}
              value={Math.round(((form.relayDailyBytes ?? 2 * 1024 ** 3) / 1024 ** 3) * 10) / 10}
              onChange={(event) => set('relayDailyBytes', Math.round((Number(event.target.value) || 2) * 1024 ** 3))}
            />
          </Field>
        </div>
        {data?.publicBaseUrl ? <div className="caption" style={{ marginTop: 10 }}>公开地址：{data.publicBaseUrl}</div> : null}
      </Card>

      <div id="settings-maintenance" className="settings-anchor" />
      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><Wrench size={17} /></span>
          <div><div className="title-3">维护</div><div className="caption">清理孤儿线路和 D1 历史脏值</div></div>
        </div>
        <div className="list" style={{ marginTop: 10 }}>
          <div className="list__row">
            <div className="grow">
              <div className="list__title">清理孤儿线路</div>
              <div className="caption">删除频道记录已不存在的线路，缩短 state 并纠正统计；会创建一条手动任务。</div>
            </div>
            <Button size="sm" loading={maintenance.isPending} onClick={() => maintenance.mutate('orphans')}>开始清理</Button>
          </div>
          <div className="list__row">
            <div className="grow">
              <div className="list__title">清理 D1 旧台标值</div>
              <div className="caption">把历史遗留的非 http(s) 台标文件名置空，避免后台显示脏值；不影响已发布台标。</div>
            </div>
            <Button size="sm" variant="glass" loading={maintenance.isPending} onClick={() => maintenance.mutate('logos')}>清理旧值</Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="settings-card__head">
          <span className="settings-card__icon"><HardDrive size={17} /></span>
          <div><div className="title-3">容量与发布</div><div className="caption">各发布产物大小；单对象超过 15MB 告警、22MB 阻断发布（KV 单值上限 25MB）</div></div>
        </div>
        <div className="list" style={{ marginTop: 10 }}>
          {(storage.data?.items ?? []).map((item) => (
            <div className="list__row" key={item.key}>
              <div className="grow"><div className="list__title mono">{item.key}</div></div>
              <div className="caption" style={{ color: item.bytes > 15 * 1024 * 1024 ? 'var(--danger)' : undefined }}>
                {(item.bytes / 1024 / 1024).toFixed(2)} MB
              </div>
            </div>
          ))}
          {!storage.data?.items.length ? <div className="caption">{storage.isLoading ? '读取中…' : '暂无数据'}</div> : null}
        </div>
        {storage.data ? (
          <div className="caption" style={{ marginTop: 8 }}>
            合计 {(storage.data.totalBytes / 1024 / 1024).toFixed(1)} MB
            {storage.data.lastPublish?.generatedAt ? ` · 上次发布体积记录于 ${storage.data.lastPublish.generatedAt}` : ''}
          </div>
        ) : null}
      </Card>

      <Button block variant="primary" className="save-bar" loading={save.isPending} onClick={() => save.mutate()}>保存全部设置</Button>
    </div>
  );
}
