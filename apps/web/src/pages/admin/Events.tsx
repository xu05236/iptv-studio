import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, ShieldCheck, Activity } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { Badge, Button, Card, Skeleton, useToast } from '../../components/ui';

interface FeedbackItem {
  id: string;
  entry_key: string | null;
  channel_id: string | null;
  source_id: string | null;
  kind: string;
  message: string | null;
  status: string;
  created_at: string;
}

interface AuditItem {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: string | null;
}

interface FailureCategory {
  pattern: string;
  stage: string;
  count: number;
  sources: string[];
  example: string;
}

interface FailureInsight {
  days: number;
  total: number;
  categories: FailureCategory[];
  byStage: Array<{ stage: string; count: number }>;
}

const KIND_LABEL: Record<string, string> = {
  dead: '线路失效',
  wrong: '名称/分类错误',
  epg: '节目单缺失',
  slow: '卡顿',
  ci: '部署/CI 失败',
  other: '其他',
};

const STATUS_LABEL: Record<string, string> = { open: '待处理', resolved: '已解决', ignored: '已忽略' };
const STATUS_TONE: Record<string, 'green' | 'orange' | 'default'> = { open: 'orange', resolved: 'green', ignored: 'default' };

export function Events() {
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'feedback' | 'audit' | 'failures'>('feedback');
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');

  const feedback = useQuery({
    queryKey: ['admin', 'feedback', status, q],
    queryFn: () => api.get<{ items: FeedbackItem[] }>(`/api/admin/feedback?status=${status}&q=${encodeURIComponent(q)}&limit=100`),
    enabled: tab === 'feedback',
  });

  const audit = useQuery({
    queryKey: ['admin', 'audit', q],
    queryFn: () => api.get<{ items: AuditItem[] }>(`/api/admin/audit?q=${encodeURIComponent(q)}&limit=80`),
    enabled: tab === 'audit',
  });

  const insights = useQuery({
    queryKey: ['admin', 'insights', 'failures'],
    queryFn: () => api.get<FailureInsight>('/api/admin/insights/failures?days=7'),
    enabled: tab === 'failures',
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'feedback'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] });
  };

  const setFeedbackStatus = useMutation({
    mutationFn: (input: { id: string; next: string }) => api.post(`/api/admin/feedback/${input.id}/status`, { status: input.next }),
    onSuccess: () => {
      show('已更新报障状态');
      refresh();
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  const probe = useMutation({
    mutationFn: (id: string) => api.post<{ message?: string }>(`/api/admin/feedback/${id}/probe`),
    onSuccess: (result) => {
      show(result.message ?? '已转为探测任务');
      refresh();
    },
    onError: (error: Error) => show(error.message, 'error'),
  });

  return (
    <>
      <AdminPageHeader
        eyebrow="运营发布"
        title="运营事件"
        description="前台报障与后台审计的统一入口：报障可一键转探测，审计记录改名/删源/发布等操作。"
      />
      <Card>
        <div className="caption">
          这里汇总三类信息：前台用户点「报障」提交的线路问题；部署流水线失败时自动上报的 CI 日志；后台改名、删源、发布等操作审计。
          列表里的「待处理」是还没人处理的报障——点「转探测」会让采集端复测这条线路；点「已解决」或「忽略」只是标注状态，不会删除记录。
        </div>
      </Card>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button variant={tab === 'feedback' ? 'primary' : undefined} onClick={() => setTab('feedback')}>
          <Bug size={15} /> 报障
        </Button>
        <Button variant={tab === 'audit' ? 'primary' : undefined} onClick={() => setTab('audit')}>
          <ShieldCheck size={15} /> 审计
        </Button>
        <Button variant={tab === 'failures' ? 'primary' : undefined} onClick={() => setTab('failures')}>
          <Activity size={15} /> 失败聚合
        </Button>
        <div style={{ flex: 1 }} />
        {tab === 'feedback' && (
          <div className="row" style={{ gap: 6 }}>
            {['open', 'resolved', 'ignored', 'all'].map((item) => (
              <button key={item} className={status === item && item !== 'all' ? 'chip chip--active' : 'chip'} onClick={() => setStatus(item)}>
                {item === 'all' ? '全部' : STATUS_LABEL[item]}
              </button>
            ))}
          </div>
        )}
        <input className="input" style={{ maxWidth: 240 }} placeholder="搜索消息 / 频道 / 线路 / 动作" value={q} onChange={(event) => setQ(event.target.value)} />
      </div>

      {tab === 'feedback' ? (
        <div className="stack" style={{ gap: 10 }}>
          {feedback.isLoading ? (
            <Skeleton height={90} />
          ) : (feedback.data?.items.length ?? 0) === 0 ? (
            <Card>
              <div className="caption">没有符合条件的报障。</div>
            </Card>
          ) : (
            feedback.data!.items.map((item) => (
              <Card key={item.id}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone="blue">{KIND_LABEL[item.kind] ?? item.kind}</Badge>
                      <Badge tone={STATUS_TONE[item.status] ?? 'default'}>{STATUS_LABEL[item.status] ?? item.status}</Badge>
                      <span className="caption">{timeAgo(item.created_at)} · {formatDateTime(item.created_at)}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {item.message && item.message.length > 180 ? (
                        <details>
                          <summary className="caption" style={{ cursor: 'pointer' }}>查看完整内容（{item.message.length} 字）</summary>
                          <pre className="code" style={{ marginTop: 6, maxHeight: 220, overflow: 'auto' }}>{item.message}</pre>
                        </details>
                      ) : (
                        <div>{item.message ?? '（无说明）'}</div>
                      )}
                    </div>
                    {item.kind === 'ci' ? (
                      <div className="caption" style={{ marginTop: 4 }}>
                        来自部署流水线（GitHub Actions）的自动上报，一般是 D1 迁移、构建或部署步骤失败；修好后点「已解决」。
                      </div>
                    ) : null}
                    <div className="caption" style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {item.channel_id && <span>频道 ID：{item.channel_id}</span>}
                      {item.source_id && <span>采集站 ID：{item.source_id}</span>}
                      {item.entry_key && <span>线路 key：{item.entry_key}</span>}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {item.entry_key && item.status !== 'resolved' && (
                      <Button variant="primary" onClick={() => probe.mutate(item.id)} disabled={probe.isPending}>
                        转探测
                      </Button>
                    )}
                    {item.status !== 'resolved' && (
                      <Button onClick={() => setFeedbackStatus.mutate({ id: item.id, next: 'resolved' })}>已解决</Button>
                    )}
                    {item.status !== 'ignored' && (
                      <Button onClick={() => setFeedbackStatus.mutate({ id: item.id, next: 'ignored' })}>忽略</Button>
                    )}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      ) : tab === 'failures' ? (
        <Card>
          {insights.isLoading ? (
            <Skeleton height={120} />
          ) : (insights.data?.categories.length ?? 0) === 0 ? (
            <div className="caption">最近 {insights.data?.days ?? 7} 天没有失败记录。</div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              <div className="caption">
                最近 {insights.data!.days} 天共 {insights.data!.total} 条失败，按归一化后的原因聚合。
              </div>
              {insights.data!.categories.map((item) => (
                <div key={`${item.stage}|${item.pattern}`}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <Badge tone="orange">{item.stage}</Badge>
                    <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>{item.pattern}</span>
                    <strong>{item.count}</strong>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: '#eef2f7', marginTop: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.round((item.count / insights.data!.categories[0]!.count) * 100)}%`,
                        height: '100%',
                        background: '#3b82f6',
                      }}
                    />
                  </div>
                  <div className="caption" style={{ marginTop: 3 }}>
                    示例：{item.example.length > 110 ? `${item.example.slice(0, 110)}…` : item.example}
                    {item.sources.length ? ` · ${item.sources.length} 个采集站` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <Card flush>
          {audit.isLoading ? (
            <div style={{ padding: 16 }}><Skeleton height={90} /></div>
          ) : (audit.data?.items.length ?? 0) === 0 ? (
            <div style={{ padding: 16 }} className="caption">没有符合条件的审计记录。</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>时间</th>
                  <th style={{ width: 180 }}>动作</th>
                  <th style={{ width: 110 }}>操作者</th>
                  <th>对象 / 详情</th>
                </tr>
              </thead>
              <tbody>
                {audit.data!.items.map((item) => (
                  <tr key={item.id}>
                    <td className="caption">{formatDateTime(item.at)}</td>
                    <td><Badge tone="blue">{item.action}</Badge></td>
                    <td className="caption">{item.actor ?? '—'}</td>
                    <td>
                      <details>
                        <summary className="caption" style={{ cursor: 'pointer' }}>{item.target ?? '—'}</summary>
                        <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{pretty(item.detail)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

function pretty(detail: string | null): string {
  if (!detail) return '（无详情）';
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}
