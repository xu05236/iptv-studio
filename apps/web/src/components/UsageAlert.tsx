import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { UsageSnapshot } from '../lib/types';

interface UsageItem {
  label: string;
  used: number;
  limit: number;
  format: (value: number) => string;
}

function pct(used: number, limit: number): number {
  return limit > 0 ? Math.round((used / limit) * 100) : 0;
}

function number(value: number): string {
  return value.toLocaleString('zh-CN');
}

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

export function UsageAlert() {
  const { data } = useQuery({
    queryKey: ['admin', 'usage'],
    queryFn: () => api.get<{ usage: UsageSnapshot | null }>('/api/admin/usage'),
    staleTime: 60_000,
  });
  const usage = data?.usage;
  if (!usage) return null;
  const ageHours = (Date.now() - new Date(usage.collectedAt).getTime()) / 3_600_000;
  if (ageHours > 24) return null;

  const today = new Date().toISOString().slice(0, 10);
  const kvFresh = usage.kv.day === today;
  const d1Fresh = usage.d1.day === today;

  const items: UsageItem[] = [
    { label: 'KV 写入', used: kvFresh ? usage.kv.writes : 0, limit: 1000, format: number },
    { label: 'KV 读取', used: kvFresh ? usage.kv.reads : 0, limit: 100000, format: number },
    { label: 'KV 列表', used: kvFresh ? usage.kv.lists : 0, limit: 1000, format: number },
    { label: 'KV 存储', used: usage.kv.storageBytes, limit: 1024 ** 3, format: bytes },
    { label: 'D1 写入', used: d1Fresh ? usage.d1.rowsWritten : 0, limit: 100000, format: number },
    { label: 'D1 读取', used: d1Fresh ? usage.d1.rowsRead : 0, limit: 5_000_000, format: number },
    { label: 'Actions', used: usage.github.minutes, limit: 2000, format: (value) => `${value} 分钟` },
  ];
  const flagged = items
    .map((item) => ({ ...item, percent: pct(item.used, item.limit) }))
    .filter((item) => item.percent >= 60)
    .sort((a, b) => b.percent - a.percent);
  if (!flagged.length) return null;

  const critical = flagged.some((item) => item.percent >= 80);
  const color = critical ? 'var(--red, #e5484d)' : 'var(--orange, #f5a524)';

  return (
    <div
      style={{
        marginBottom: 16,
        padding: '11px 14px',
        borderRadius: 14,
        border: `1px solid ${color}`,
        background: critical ? 'rgba(229, 72, 77, 0.08)' : 'rgba(245, 165, 36, 0.08)',
        color,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
    >
      <TriangleAlert size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <div className="grow">
        <div style={{ fontWeight: 600, fontSize: 13 }}>{critical ? '资源用量接近免费额度上限' : '资源用量提醒'}</div>
        <div className="caption" style={{ color, marginTop: 2 }}>
          {flagged
            .map((item) => `${item.label} ${item.percent}%（${item.format(item.used)} / ${item.format(item.limit)}）`)
            .join(' · ')}
        </div>
      </div>
      <Link to="/admin" style={{ color, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        详情 <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}
