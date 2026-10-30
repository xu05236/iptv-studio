import { Badge } from './ui';

export const REPUTATION_RULE =
  '信誉分 0–100，由采集站可用率、线路平均质量、抓取成功率综合计算：80+ 优质，50–79 正常，<50 降权。分数会影响探测排序、复测间隔和每轮完整测速预算份额。';

export type ReputationTier = 'high' | 'normal' | 'low';

export function reputationTier(score: number): ReputationTier {
  if (score >= 80) return 'high';
  if (score >= 50) return 'normal';
  return 'low';
}

export function reputationLabel(score: number): string {
  const tier = reputationTier(score);
  return tier === 'high' ? '优质' : tier === 'normal' ? '正常' : '降权';
}

export function ReputationBadge({ score }: { score: number }) {
  const tier = reputationTier(score);
  return (
    <span title={REPUTATION_RULE} style={{ cursor: 'help' }}>
      <Badge tone={tier === 'high' ? 'green' : tier === 'normal' ? 'blue' : 'orange'}>
        信誉 {Math.round(score)}/100 · {reputationLabel(score)}
      </Badge>
    </span>
  );
}
