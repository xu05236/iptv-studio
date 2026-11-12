/** Shared task-type labels so the public overview, admin board, runs page and
 * probe center never drift apart when a new task type is added. */
export const TASK_TYPE_LABEL: Record<string, string> = {
  collect: '全量采集',
  fetch: '抓源',
  'probe-batch': '分批探测',
  'probe-lines': '指定线路探测',
  publish: '线路发布',
  epg: '节目单刷新',
  liveness: '池内测活',
  export: '重建导出',
  snapshot: '快照',
  'cleanup-orphans': '孤儿清理',
  'cleanup-rejected': '清理已淘汰',
  'revive-batch': '批量复活',
  'rules-preview': '规则预览',
  'proxy-test': '代理测活',
  'proxy-fetch-sub': '订阅拉取',
  'cn-probe': '国内补测',
};

export function taskTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return TASK_TYPE_LABEL[type] ?? type;
}
