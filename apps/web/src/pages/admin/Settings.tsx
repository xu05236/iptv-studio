import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ShieldAlert } from 'lucide-react';
import type { AppSettings } from '@iptv/core';
import { api } from '../../lib/api';
import type { SettingsResponse } from '../../lib/types';
import { Button, Card, Field, Skeleton, Switch, useToast } from '../../components/ui';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const [form, setForm] = useState<AppSettings | null>(null);
  const [epgText, setEpgText] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<SettingsResponse>('/api/admin/settings'),
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
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  if (isLoading || !form) {
    return <div className="stack"><Skeleton height={34} width={200} /><Skeleton height={400} radius={16} /></div>;
  }

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => setForm({ ...form, [key]: value });

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
          <Field label="台标基础地址" hint="订阅自带 tvg-logo 优先；缺失时按 tvg-id 拼接，例如 https://live.fanmingming.com/tv/">
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
        <div className="title-3">采集与测速</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="grow"><Field label="每日测速预算（条）" hint="按未测 / 到期复检自动折算"><input className="input" inputMode="numeric" value={form.probeBudget} onChange={(event) => set('probeBudget', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="并发数"><input className="input" inputMode="numeric" value={form.concurrency} onChange={(event) => set('concurrency', Number(event.target.value))} /></Field></div>
          </div>
          <div className="row">
            <div className="grow"><Field label="超时 (ms)"><input className="input" inputMode="numeric" value={form.probeTimeoutMs} onChange={(event) => set('probeTimeoutMs', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="预热丢弃字节"><input className="input" inputMode="numeric" value={form.warmupBytes} onChange={(event) => set('warmupBytes', Number(event.target.value))} /></Field></div>
            <div className="grow"><Field label="采样时长 (ms)"><input className="input" inputMode="numeric" value={form.sampleMs} onChange={(event) => set('sampleMs', Number(event.target.value))} /></Field></div>
          </div>
          <Field label="失效线路复活天数" hint="连续 3 次失败判定失效，到期后允许复测一次">
            <input className="input" inputMode="numeric" value={form.deadReviveDays} onChange={(event) => set('deadReviveDays', Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="title-3">EPG 与通知</div>
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="XMLTV 地址（每行一个）" hint="留空则不生成节目单；默认已内置 fanmingming 与 epg.pw 两个源，可自行替换/追加">
            <textarea className="textarea" value={epgText} onChange={(event) => setEpgText(event.target.value)} placeholder="https://raw.githubusercontent.com/fanmingming/live/main/e.xml" />
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
        </div>
        {data?.publicBaseUrl ? <div className="caption" style={{ marginTop: 10 }}>公开地址：{data.publicBaseUrl}</div> : null}
      </Card>

      <Button block variant="primary" loading={save.isPending} onClick={() => save.mutate()}>保存全部设置</Button>
    </div>
  );
}
