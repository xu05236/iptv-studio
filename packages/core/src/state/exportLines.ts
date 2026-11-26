import type { LineEntry } from '../types.js';
import type { PoolSnapshot } from '../linePool.js';

/**
 * Keep only the fields the export/render path actually reads.
 *
 * `pool.json` and `out/catalog.json` used to carry the full line record,
 * including probe diagnostics and lifecycle timestamps nobody on the read path
 * needs. Those fields roughly double the artifact size. `urlKey`/`firstSeenAt`/
 * `lastSeenAt`/`tags`/`bandwidthKbps` are only used while building the artifacts
 * (dedupe, rules, probe), never by the subscription renderer. Those fields are
 * kept as empty placeholders because `LineEntry` requires them; the bytes that
 * matter (timestamps, normalized URLs) are gone. `bandwidthKbps` is optional
 * and dropped outright. Workers do re-run `selectLines` on catalog lines, so
 * status/failCount/score/speedKbps/resolution and lastProbeAt must stay.
 */
export function slimExportLine(line: LineEntry): LineEntry {
  const slim: LineEntry = {
    key: line.key,
    sourceId: line.sourceId,
    channelId: line.channelId,
    name: line.name,
    url: line.url,
    urlKey: '',
    protocol: line.protocol,
    status: line.status,
    failCount: line.failCount,
    score: line.score,
    firstSeenAt: '',
    lastSeenAt: '',
    tags: [],
  };
  if (line.headers && Object.keys(line.headers).length) slim.headers = line.headers;
  if (line.resolution) slim.resolution = line.resolution;
  if (line.height) slim.height = line.height;
  if (line.speedKbps) slim.speedKbps = line.speedKbps;
  if (line.latencyMs) slim.latencyMs = line.latencyMs;
  if (line.codecs) slim.codecs = line.codecs;
  if (line.lastProbeAt) slim.lastProbeAt = line.lastProbeAt;
  if (line.official) slim.official = true;
  if (line.favorite) slim.favorite = true;
  if (line.region) slim.region = line.region;
  if (line.operator) slim.operator = line.operator;
  if (line.catchup) slim.catchup = line.catchup;
  if (line.catchupSource) slim.catchupSource = line.catchupSource;
  if (line.catchupDays) slim.catchupDays = line.catchupDays;
  if (line.cnReachable) slim.cnReachable = true;
  return slim;
}

/** Slim every bucket of a pool snapshot in place and return it. */
export function slimPoolSnapshot(snapshot: PoolSnapshot): PoolSnapshot {
  for (const channel of Object.values(snapshot.channels)) {
    channel.premium = channel.premium.map(slimExportLine);
    channel.backup = channel.backup.map(slimExportLine);
    channel.candidate = channel.candidate.map(slimExportLine);
  }
  return snapshot;
}
