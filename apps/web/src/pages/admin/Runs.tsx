import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Camera, FileText, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RunItem } from '../../lib/types';
import { formatBytes, formatDateTime, formatDuration, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Sheet, Skeleton, Switch, useToast } from '../../components/ui';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { TASK_TYPE_LABEL } from '@iptv/core';

export function Runs() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<RunItem | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [snapshotOnPublish, setSnapshotOnPublish] = useState(false);
  const [snapshotSchedule, setSnapshotSchedule] = useState(false);
  const [snapshotTimes, setSnapshotTimes] = useState('03:00');

  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: { snapshotOnPublishEnabled?: boolean; snapshotScheduleEnabled?: boolean; snapshotScheduleTimes?: string } }>('/api/admin/settings'),
  });

  useEffect(() => {
    if (!settings.data) return;
    setSnapshotOnPublish(Boolean(settings.data.settings.snapshotOnPublishEnabled));
    setSnapshotSchedule(Boolean(settings.data.settings.snapshotScheduleEnabled));
    setSnapshotTimes(settings.data.settings.snapshotScheduleTimes ?? '03:00');
  }, [settings.data]);

  const saveSnapshotSettings = useMutation({
    mutationFn: () => api.put('/api/admin/settings', {
      snapshotOnPublishEnabled: snapshotOnPublish,
      snapshotScheduleEnabled: snapshotSchedule,
      snapshotScheduleTimes: snapshotTimes,
    }),
    onSuccess: () => {
      show('快照策略已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const clearSnapshots = useMutation({
    mutationFn: () => api.del<{ removed: number }>('/api/admin/snapshots'),
    onSuccess: (result) => {
      show(`已清空 ${result.removed} 个快照`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'snapshots'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'runs', 50],
    queryFn: () => api.get<{ items: RunItem[] }>('/api/admin/runs?limit=50'),
  });

  const snapshots = useQuery({
    queryKey: ['admin', 'snapshots'],
    queryFn: () => api.get<{ items: Array<{ id: string; generatedAt: string; channels: number; lines: number; alive: number }> }>('/api/admin/snapshots'),
  });

  const createSnapshot = useMutation({
    mutationFn: () => api.post<{ item: unknown }>('/api/admin/snapshots'),
    onSuccess: () => {
      show('快照已创建');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'snapshots'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean }>(`/api/admin/snapshots/${id}/restore`),
    onSuccess: () => {
      show('已恢复该快照');
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  async function openRun(run: RunItem): Promise<void> {
    setSelected(run);
    setLog(null);
    if (!run.log_key) return;
    setLoadingLog(true);
    try {
      const text = await api.get<string>(`/api/admin/runs/${run.id}/log`);
      setLog(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    } catch (error) {
      show(error instanceof Error ? error.message : '日志读取失败', 'error');
    } finally {
      setLoadingLog(false);
    }
  }

  return (
    <div className="stack">
      <AdminPageHeader
        eyebrow="OPERATIONS"
        title="运行与日志"
        description="每次采集的抓取、测速、聚合结果都会留下结构化日志。"
      />

      <Card className="snapshot-policy">
        <div className="snapshot-policy__head">
          <span className="snapshot-policy__icon"><Camera size={17} /></span>
          <div className="grow">
            <div className="title-3">快照策略</div>
            <div className="caption">发布后或定时保存一个可回滚的版本</div>
          </div>
          <div className="row" style={{ gap: 5 }}>
            <Badge tone={snapshotOnPublish ? 'green' : 'default'}>{snapshotOnPublish ? '发布后自动' : '发布后关闭'}</Badge>
            <Badge tone={snapshotSchedule ? 'green' : 'default'}>{snapshotSchedule ? '定时开启' : '定时关闭'}</Badge>
          </div>
        </div>

        <div className="snapshot-options">
          <div className="snapshot-option">
            <span className="snapshot-option__icon"><Camera size={15} /></span>
            <div className="grow">
              <div className="snapshot-option__title">发布成功后自动创建</div>
              <div className="caption">每次发布完成保存频道、线路、订阅池和节目单</div>
            </div>
            <Switch checked={snapshotOnPublish} onChange={setSnapshotOnPublish} />
          </div>
          <div className="snapshot-option">
            <span className="snapshot-option__icon"><CalendarClock size={15} /></span>
            <div className="grow">
              <div className="snapshot-option__title">独立定时创建</div>
              <div className="caption">按指定时间自动保存，不依赖发布任务</div>
            </div>
            <Switch checked={snapshotSchedule} onChange={setSnapshotSchedule} />
          </div>
        </div>

        <div className="snapshot-time">
          <Field label="快照时间（北京时间）" hint="开启独立定时后生效；支持多个时间，逗号分隔">
            <input className="input" value={snapshotTimes} onChange={(event) => setSnapshotTimes(event.target.value)} placeholder="00:10, 17:10" />
          </Field>
        </div>

        <div className="snapshot-policy__footer">
          <Button size="sm" variant="primary" loading={saveSnapshotSettings.isPending} onClick={() => saveSnapshotSettings.mutate()}>保存策略</Button>
          <Button
            size="sm"
            variant="ghost"
            loading={clearSnapshots.isPending}
            onClick={() => {
              if (window.confirm('删除所有快照记录和文件，此操作不可恢复？')) clearSnapshots.mutate();
            }}
          >
            <Trash2 size={13} /> 清空快照
          </Button>
        </div>
      </Card>

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">快照回滚</div>
            <div className="caption">手动创建 · 保留最近 3 个</div>
          </div>
          <Button size="sm" variant="primary" loading={createSnapshot.isPending} onClick={() => createSnapshot.mutate()}>
            <Camera size={14} /> 创建快照
          </Button>
        </div>
        <div className="run-list">
          {(snapshots.data?.items ?? []).map((item) => (
            <div className="run-row run-row--blue" key={item.id}>
              <div className="run-row__status"><Badge tone="blue">快照</Badge></div>
              <div className="grow">
                <div className="run-row__title">{formatDateTime(item.generatedAt)}</div>
                <div className="caption run-row__message">发布版本 · 可用于回滚频道、线路、订阅池和节目单</div>
              </div>
              <div className="run-row__metrics">
                <span><strong>{item.channels}</strong> 频道</span>
                <span><strong>{item.lines}</strong> 线路</span>
                <span><strong>{item.alive}</strong> 可用</span>
              </div>
              <Button
                size="sm"
                variant="glass"
                loading={restore.isPending}
                onClick={() => {
                  if (window.confirm(`恢复到 ${formatDateTime(item.generatedAt)} 的快照？`)) restore.mutate(item.id);
                }}
              >
                <RotateCcw size={14} /> 回滚
              </Button>
            </div>
          ))}
          {!snapshots.data?.items.length ? <div className="task-empty">还没有快照，点击右上角「创建快照」保存当前发布版本。</div> : null}
        </div>
      </Card>

      {isLoading ? <Skeleton height={200} radius={16} /> : null}

      <Card>
        <div className="card__header" style={{ padding: '2px 2px 12px' }}>
          <div>
            <div className="title-3">运行记录</div>
            <div className="caption">最近 {data?.items.length ?? 0} 条</div>
          </div>
          <span className="caption">点击日志查看完整输出</span>
        </div>
        <div className="run-list">
          {(data?.items ?? []).map((run) => {
            const tone = run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange';
            const statusText = run.status === 'success' ? '成功' : run.status === 'partial' ? '部分' : run.status === 'running' ? '运行中' : '失败';
            return (
              <div className={`run-row run-row--${tone}`} key={run.id}>
                <div className="run-row__status"><Badge tone={tone}>{statusText}</Badge></div>
                <div className="grow">
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <span className="run-row__title">{run.task_label ?? (run.task_type ? TASK_TYPE_LABEL[run.task_type] ?? run.task_type : '运行记录')}</span>
                    <Badge>{run.trigger}</Badge>
                  </div>
                  {(run.message ?? run.task_message) ? <div className="caption run-row__message">{run.message ?? run.task_message}</div> : null}
                  {run.task_failure_reason ? <div className="caption task-failure">失败原因：{run.task_failure_reason}</div> : null}
                </div>
                <div className="run-row__metrics">
                  <span><strong>{run.channels}</strong> 频道</span>
                  <span><strong>{run.alive}</strong> 可用</span>
                  <span><strong>{run.probed}</strong> 已测</span>
                  <span><strong>{formatBytes(run.bytes)}</strong> 流量</span>
                </div>
                <div className="run-row__time">
                  <span>{timeAgo(run.started_at)}</span>
                  <span className="caption">{formatDuration(run.duration_ms)}</span>
                </div>
                <Button size="sm" variant="glass" onClick={() => void openRun(run)}><FileText size={14} /> 日志</Button>
              </div>
            );
          })}
          {!isLoading && !data?.items.length ? <div className="task-empty">还没有运行记录，去检测中心触发一次采集。</div> : null}
        </div>
      </Card>

      <Sheet open={Boolean(selected)} onClose={() => setSelected(null)} title="运行详情" subtitle={selected?.id}>
        {selected ? (
          <div className="stack">
            <div className="row row--wrap">
              <Badge tone={selected.status === 'success' ? 'green' : selected.status === 'failed' ? 'red' : 'orange'}>{selected.status}</Badge>
              <Badge>{selected.trigger}</Badge>
              <span className="caption">{formatDateTime(selected.started_at)}</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div><div className="caption">频道</div><div className="title-3">{selected.channels}</div></div>
              <div><div className="caption">线路</div><div className="title-3">{selected.lines}</div></div>
              <div><div className="caption">可用</div><div className="title-3">{selected.alive}</div></div>
              <div><div className="caption">已测</div><div className="title-3">{selected.probed}</div></div>
              <div><div className="caption">流量</div><div className="title-3">{formatBytes(selected.bytes)}</div></div>
              <div><div className="caption">耗时</div><div className="title-3">{formatDuration(selected.duration_ms)}</div></div>
            </div>
            {selected.task_message ? <div className="caption">{selected.task_message}</div> : null}
            {selected.task_failure_reason ? <div className="caption" style={{ color: 'var(--red, #e5484d)' }}>失败原因：{selected.task_failure_reason}</div> : null}
            {selected.error ? <div className="caption" style={{ color: 'var(--red)' }}>{selected.error}</div> : null}
            {selected.warnings?.length ? (
              <div className="stack stack--tight">
                <div className="caption">警告</div>
                {selected.warnings.map((warning, index) => <div key={index} className="caption mono">{warning}</div>)}
              </div>
            ) : null}
            <div className="caption">日志 {selected.log_key ?? '（无）'}</div>
            {loadingLog ? <Skeleton height={180} /> : log ? <pre className="code">{log}</pre> : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
