import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import type { RunItem } from '../../lib/types';
import { formatBytes, formatDateTime, formatDuration, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Sheet, Skeleton, useToast } from '../../components/ui';

const TASK_LABEL: Record<string, string> = {
  collect: '完整采集',
  fetch: '抓源',
  publish: '发布',
  probe: '测速',
  'probe-batch': '分批探测',
  'probe-lines': '指定探测',
  liveness: '测活',
  epg: '节目单',
  export: '导出',
  'cleanup-orphans': '孤儿清理',
};

export function Runs() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<RunItem | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'runs', 50],
    queryFn: () => api.get<{ items: RunItem[] }>('/api/admin/runs?limit=50'),
  });

  const snapshots = useQuery({
    queryKey: ['admin', 'snapshots'],
    queryFn: () => api.get<{ items: Array<{ id: string; generatedAt: string; channels: number; lines: number; alive: number }> }>('/api/admin/snapshots'),
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
      <div>
        <h1 className="large-title">运行与日志</h1>
        <p className="subhead" style={{ marginTop: 4 }}>每次采集的抓取、测速、聚合结果都会留下结构化日志。</p>
      </div>

      <Card>
        <div className="row row--between">
          <div className="title-3">快照回滚</div>
          <span className="caption">保留最近 10 次发布</span>
        </div>
        <div className="list" style={{ marginTop: 8 }}>
          {(snapshots.data?.items ?? []).map((item) => (
            <div className="list__row" key={item.id}>
              <div className="grow">
                <div>{formatDateTime(item.generatedAt)}</div>
                <div className="caption">{item.channels} 频道 · {item.lines} 行 · {item.alive} 可用</div>
              </div>
              <Button
                size="sm"
                loading={restore.isPending}
                onClick={() => {
                  if (window.confirm(`恢复到 ${formatDateTime(item.generatedAt)} 的快照？`)) restore.mutate(item.id);
                }}
              >
                <RotateCcw size={14} /> 回滚
              </Button>
            </div>
          ))}
          {!snapshots.data?.items.length ? <div className="caption">还没有版本快照，下一次发布后生成。</div> : null}
        </div>
      </Card>

      {isLoading ? <Skeleton height={200} radius={16} /> : null}

      <Card flush>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="table">
            <thead>
              <tr><th>状态</th><th>任务</th><th>触发</th><th>开始</th><th>频道</th><th>线路 / 可用</th><th>已测</th><th>流量</th><th>耗时</th><th /></tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((run) => (
                <tr key={run.id}>
                  <td><Badge tone={run.status === 'success' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>{run.status}</Badge></td>
                  <td>
                    <div>{run.task_type ? TASK_LABEL[run.task_type] ?? run.task_type : '—'}</div>
                    {run.task_source ? <div className="caption">{run.task_source}</div> : null}
                  </td>
                  <td className="caption">{run.trigger}</td>
                  <td className="caption">{timeAgo(run.started_at)}</td>
                  <td>{run.channels}</td>
                  <td>{run.lines} / {run.alive}</td>
                  <td>{run.probed}</td>
                  <td className="caption">{formatBytes(run.bytes)}</td>
                  <td className="caption">{formatDuration(run.duration_ms)}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => void openRun(run)}><FileText size={14} /></Button></td>
                </tr>
              ))}
              {!isLoading && !data?.items.length ? (
                <tr><td colSpan={10}><div className="caption" style={{ padding: 16 }}>还没有运行记录，去检测中心触发一次采集。</div></td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="caption show-mobile" style={{ padding: '8px 14px' }}>← 左右滑动查看完整表格 →</div>
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
