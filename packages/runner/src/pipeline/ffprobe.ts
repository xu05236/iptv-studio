import { execFile } from 'node:child_process';
import type { LineEntry } from '@iptv/core';
import type { RunLogger } from '../logger.js';

interface ProbeStream {
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

function runFfprobe(line: LineEntry): Promise<ProbeStream | null> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate',
      '-of', 'json',
      '-rw_timeout', '15000000',
    ];
    if (line.headers?.userAgent) args.push('-user_agent', line.headers.userAgent);
    const headerLines: string[] = [];
    if (line.headers?.referer) headerLines.push(`Referer: ${line.headers.referer}`);
    if (line.headers?.origin) headerLines.push(`Origin: ${line.headers.origin}`);
    if (headerLines.length) args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
    args.push(line.url);

    execFile('ffprobe', args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { streams?: ProbeStream[] };
        resolve(parsed.streams?.[0] ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Fill in real video dimensions with ffprobe.
 *
 * HLS master playlists often omit RESOLUTION (or the source is a bare media
 * playlist), so the HTTP probe alone leaves many lines at "unknown". We only
 * spend ffprobe time on lines that are alive and still missing a resolution.
 */
export async function enrichResolutions(lines: LineEntry[], limit: number, logger: RunLogger): Promise<number> {
  const targets = lines
    .filter((line) => line.status === 'alive' && !line.resolution && /^https?:/i.test(line.url))
    .slice(0, Math.max(0, limit));

  if (!targets.length) {
    logger.info('分辨率补全：没有需要处理的线路');
    return 0;
  }

  let enriched = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const line = targets[index];
      if (!line) return;
      const stream = await runFfprobe(line);
      if (!stream?.width || !stream?.height) continue;
      line.width = stream.width;
      line.height = stream.height;
      line.resolution = `${stream.width}x${stream.height}`;
      if (stream.avg_frame_rate) {
        const [num, den] = stream.avg_frame_rate.split('/').map(Number);
        if (num && den) line.frameRate = Math.round((num / den) * 100) / 100;
      }
      enriched++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
  logger.info('分辨率补全完成', { candidates: targets.length, enriched });
  return enriched;
}
