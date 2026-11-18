import type { LineEntry } from '../types.js';
import { isDueForProbe } from '../aggregate/state.js';

/** Per-source counters shown on the admin sources page. */
export interface SourceProgress {
  total: number;
  tested: number;
  alive: number;
  pending: number;
  pendingTotal: number;
  quarantine: number;
  quarantineTotal: number;
  rejected: number;
  rejectedTotal: number;
  usableTotal: number;
  unmatched: number;
  channels: number;
}

export const ZERO_SOURCE_PROGRESS: SourceProgress = {
  total: 0,
  tested: 0,
  alive: 0,
  pending: 0,
  pendingTotal: 0,
  quarantine: 0,
  quarantineTotal: 0,
  rejected: 0,
  rejectedTotal: 0,
  usableTotal: 0,
  unmatched: 0,
  channels: 0,
};

const UNPROBEABLE = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;

/**
 * Compute the counters once (at publish time), so the admin sources route can
 * read them from a small artifact instead of parsing every line per request.
 * The definition must stay identical to what the page used to compute live.
 */
export function computeSourceProgress(
  lines: LineEntry[],
  channels: Array<{ id: string }>,
  now = new Date(),
): Map<string, SourceProgress> {
  const validChannels = new Set(channels.map((channel) => channel.id));
  const progress = new Map<string, SourceProgress>();
  const channelSets = new Map<string, Set<string>>();
  for (const line of lines) {
    const item = progress.get(line.sourceId) ?? { ...ZERO_SOURCE_PROGRESS };
    item.total++;
    if (line.lastProbeAt || line.lastLivenessAt) item.tested++;
    const usable = validChannels.has(line.channelId) && !UNPROBEABLE.test(line.url);
    const livenessReady = !line.lastLivenessAt || now.getTime() - Date.parse(line.lastLivenessAt) >= 6 * 3_600_000;
    if (usable && !line.lastProbeAt && line.status === 'unknown') {
      item.pending++;
      item.pendingTotal++;
    }
    if (usable && line.status === 'alive') {
      item.alive++;
      const set = channelSets.get(line.sourceId) ?? new Set<string>();
      set.add(line.channelId);
      channelSets.set(line.sourceId, set);
    } else if (usable && line.status === 'suspect') {
      item.quarantineTotal++;
      if (livenessReady && isDueForProbe(line, 'normal', now)) item.quarantine++;
    } else if (usable && line.status === 'dead') {
      item.rejectedTotal++;
      if (isDueForProbe(line, 'normal', now)) item.rejected++;
    }
    progress.set(line.sourceId, item);
  }
  for (const [sourceId, item] of progress) {
    item.usableTotal = item.alive + item.pendingTotal + item.quarantineTotal + item.rejectedTotal;
    item.unmatched = Math.max(0, item.total - item.usableTotal);
    item.channels = channelSets.get(sourceId)?.size ?? 0;
  }
  return progress;
}
