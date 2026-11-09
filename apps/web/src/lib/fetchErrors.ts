const LABELS: Record<string, string> = {
  timeout: '请求超时',
  network: '网络失败',
  tls: 'TLS 证书错误',
  http_4xx: 'HTTP 4xx（请求被拒绝）',
  http_5xx: 'HTTP 5xx（服务端错误）',
  challenge: 'Cloudflare 质询',
  not_playlist: '内容不是播放列表',
};

/** F1: human label for the source `last_error_kind` classification. */
export function errorKindLabel(kind?: string | null): string {
  if (!kind) return '';
  return LABELS[kind] ?? kind;
}
