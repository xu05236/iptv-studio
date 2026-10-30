import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ShieldAlert, Trash2 } from 'lucide-react';
import type { AppSettings } from '@iptv/core';
import { api } from '../../lib/api';
import type { SettingsResponse } from '../../lib/types';
import { Button, Card, Field, Skeleton, Switch, useToast } from '../../components/ui';

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
  const [epgText, setEpgText] = useState('');
  const [newEpgUrl, setNewEpgUrl] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<SettingsResponse>('/api/admin/settings'),
  });

  const schedule = useQuery({
    queryKey: ['admin', 'schedule'],
    queryFn: () => api.get<{ enabled: boolean; times: string; budget: number; nextAt: string | null; lastRunAt: string | null; result: string | null }>('/api/admin/schedule'),
  });

  useEffect(() => {
    if (data?.settings) {
      setForm(data.settings);
      setEpgText((data.settings.epgUrls ?? []).join('\n'));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put<{ settings: AppSettings }>('/api/admin/settings', {
      ...form,
      epgUrls: epgText.split(/\n+/).map((line) => line.trim()).filter(Boolean),
    }),
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
  const epgUrls = epgText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const writeEpgUrls = (urls: string[]): void => setEpgText(urls.join('\n'));
  const addEpgUrl = (): void => {
    const value = newEpgUrl.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) {
      show('EPG 地址必须以 http:// 或 https:// 开头', 'error');
      return;
    }
    if (epgUrls.includes(value)) {
      show('这个 EPG 源已经存在');
      return;
    }
    writeEpgUrls([...epgUrls, value]);
    setNewEpgUrl('');
  };

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h1 className="large-title">设置</h1>
          <p className="subhead" style={{ marginTop: 4 }}>影响下一轮采集、测速预算与导出行为。</p>
        </div>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}><Save size={15} /> 保存</Button>
      </div>

      <Card>
        <div className="title-3">基础</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="台标基础地址" hint="订阅自带 tvg-logo 优先；缺失时按 tvg-id 拼接。旧 fanmingming 地址会自动改用 jsDelivr 镜像，前台还会多源回退。">
            <input className="input" value={form.logoBaseUrl} onChange={(event) => set('logoBaseUrl', event.target.value)} />
          </Field>
          <div className="row">
            <div className="grow"><Field label="每频道最多线路"><input className="input" inputMode="numeric" value={form.maxLinesPerChannel} onChange={(event) => set('maxLinesPerChannel', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="同源最多线路"><input className="input" inputMode="numeric" value={form.maxLinesPerSource} onChange={(event) => set('maxLinesPerSource', Number(event.target.value))} /></Field></div>
          </div>
          <div className="list">
            <div className="list__row"><span className="grow">线路名带地区/运营商后缀</span><Switch checked={form.regionSuffix} onChange={(value) => set('regionSuffix', value)} /></div>
            <div className="list__row"><span className="grow">补偿机制（频道无可用时回填可疑线路）</span><Switch checked={form.compensate} onChange={(value) => set('compensate', value)} /></div>
            <div className="list__row"><span className="grow">允许可疑线路作为兜底</span><Switch checked={form.keepSuspect} onChange={(value) => set('keepSuspect', value)} /></div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="title-3">采集与探测</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="grow"><Field label="采集预算（条）" hint="手动/定时触发未显式指定时使用；按未测 / 到期复检自动折算"><input className="input" inputMode="numeric" value={form.probeBudget} onChange={(event) => set('probeBudget', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="并发数"><input className="input" inputMode="numeric" value={form.concurrency} onChange={(event) => set('concurrency', Number(event.target.value))} /></Field></div>
          </div>
          <div className="table-wrap" style={{ marginTop: 4 }}>
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr><th>预算</th><th>探测耗时</th><th>整轮耗时</th><th>探测流量</th><th>KV 写入</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {BUDGET_TIERS.map((row) => (
                  <tr key={row.budget} style={row.budget === form.probeBudget ? { background: 'rgba(245, 165, 36, 0.08)' } : undefined}>
                    <td>{row.budget}</td>
                    <td>{row.probe}</td>
                    <td>{row.run}</td>
                    <td>{row.traffic}</td>
                    <td>{row.kv}</td>
                    <td>{row.actions}</td>
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
          <div className="row">
            <div className="grow"><Field label="超时 (ms)"><input className="input" inputMode="numeric" value={form.probeTimeoutMs} onChange={(event) => set('probeTimeoutMs', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="预热丢弃字节"><input className="input" inputMode="numeric" value={form.warmupBytes} onChange={(event) => set('warmupBytes', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="采样时长 (ms)"><input className="input" inputMode="numeric" value={form.sampleMs} onChange={(event) => set('sampleMs', Number(event.target.value))} /></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="ffprobe 每轮补全条数" hint="只补 alive 且缺分辨率的线路；0 = 关闭"><input className="input" inputMode="numeric" value={form.ffprobeLimit ?? 150} onChange={(event) => set('ffprobeLimit', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="发布前冷却（秒）" hint="批量探测后等待一段时间再上传，避免边缘限速"><input className="input" inputMode="numeric" value={Math.round((form.publishCooldownMs ?? 60_000) / 1000)} onChange={(event) => set('publishCooldownMs', Math.max(0, Number(event.target.value) || 0) * 1000)} /></Field></div>
            <div className="grow"><Field label="线路留存天数" hint="源刷新不再列出后，已测线路仍保留的天数"><input className="input" inputMode="numeric" value={form.lineRetentionDays ?? 30} onChange={(event) => set('lineRetentionDays', Number(event.target.value))} /></Field></div>
          </div>
          <Field label="失效线路复活天数" hint="连续 3 次失败判定失效，到期后允许复测一次">
            <input className="input" inputMode="numeric" value={form.deadReviveDays} onChange={(event) => set('deadReviveDays', Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="title-3">定时采集</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="list__row"><span className="grow">启用定时采集（默认关闭）</span><Switch checked={form.autoCollectEnabled ?? false} onChange={(value) => set('autoCollectEnabled', value)} /></div>
          </div>
          <Field label="每天运行时刻（北京时间）" hint="HH:mm，多个用逗号分隔，例如 08:30 或 08:30, 20:30；建议在 08:00 额度重置后">
            <input className="input" value={form.autoCollectTimes ?? '08:30'} onChange={(event) => set('autoCollectTimes', event.target.value)} />
          </Field>
          <div className="caption">
            预算沿用上方「采集预算」；保护：KV 写入 ≥920 或已有采集在跑时自动跳过；时区固定北京时间（UTC+8）。
            {schedule.data?.nextAt ? ` 下次：${new Date(schedule.data.nextAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ' 当前未启用。'}
            {schedule.data?.lastRunAt ? ` · 上次：${new Date(schedule.data.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${schedule.data.result ?? '未知'}）` : ''}
          </div>
        </div>
      </Card>

      <Card>
        <div className="title-3">EPG 与通知</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="XMLTV 源" hint="支持添加多个源；保存后下一轮采集生效。留空则不生成节目单。">
            <div className="stack stack--tight">
              {epgUrls.map((url, index) => (
                <div className="row row--wrap" key={`${url}-${index}`} style={{ gap: 6 }}>
                  <input
                    className="input grow"
                    value={url}
                    onChange={(event) => {
                      const next = [...epgUrls];
                      next[index] = event.target.value;
                      writeEpgUrls(next);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => writeEpgUrls(epgUrls.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2 size={14} /> 删除
                  </Button>
                </div>
              ))}
              {!epgUrls.length ? <div className="caption">当前没有 EPG 源。</div> : null}
              <div className="row row--wrap" style={{ gap: 6 }}>
                <input
                  className="input grow"
                  placeholder="https://example.com/epg.xml 或 .xml.gz"
                  value={newEpgUrl}
                  onChange={(event) => setNewEpgUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addEpgUrl();
                    }
                  }}
                />
                <Button size="sm" onClick={addEpgUrl} disabled={!newEpgUrl.trim()}>添加源</Button>
              </div>
              <div className="caption">当前 {epgUrls.length} 个源；当前默认包含 fanmingming、epg.pw、zsdc。</div>
            </div>
          </Field>
          <div className="list">
            <div className="list__row"><span className="grow">Telegram 日报（需在 Actions 配置 Secret）</span><Switch checked={form.notifyTelegram} onChange={(value) => set('notifyTelegram', value)} /></div>
            <div className="list__row"><span className="grow">每日截帧验证（需 runner 支持 ffmpeg）</span><Switch checked={form.screenshots} onChange={(value) => set('screenshots', value)} /></div>
          </div>
          <Field label="快照保留天数">
            <input className="input" inputMode="numeric" value={form.retentionDays} onChange={(event) => set('retentionDays', Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="row" style={{ color: 'var(--orange)' }}>
          <ShieldAlert size={18} />
          <div className="title-3">高级</div>
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
        {data?.publicBaseUrl ? <div className="caption" style={{ marginTop: 10 }}>公开地址：{data.publicBaseUrl}</div> : null}
      </Card>

      <Button block variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存全部设置</Button>
    </div>
  );
}
