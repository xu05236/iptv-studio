export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString('zh-CN');
}

export function formatSpeed(kbps: number | null | undefined): string {
  if (!kbps || kbps <= 0) return '—';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mb/s`;
  return `${Math.round(kbps)} kb/s`;
}

export function formatResolution(resolution: string | null | undefined): string {
  if (!resolution) return '未知';
  const match = /(\d{3,4})\s*[x×]\s*(\d{3,4})/i.exec(resolution);
  if (match) {
    const height = Number(match[2]);
    if (height >= 2000) return '4K';
    if (height >= 1400) return '2K';
    return `${height}P`;
  }
  return resolution.toUpperCase();
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return `${Math.round(ms)} ms`;
}

export function timeAgo(input: string | null | undefined): string {
  if (!input) return '从未';
  const time = new Date(input).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Date.now() - time;
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(input).toLocaleDateString('zh-CN');
}

export function formatDateTime(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatClock(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function statusTone(status: string): 'green' | 'orange' | 'red' | 'default' {
  if (status === 'alive') return 'green';
  if (status === 'suspect' || status === 'unknown') return 'orange';
  if (status === 'dead') return 'red';
  return 'default';
}

export function statusLabel(status: string): string {
  if (status === 'alive') return '可用';
  if (status === 'suspect') return '待观察';
  if (status === 'dead') return '失效';
  return '未测';
}
