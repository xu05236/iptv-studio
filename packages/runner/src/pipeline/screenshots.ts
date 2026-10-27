import { execFile } from 'node:child_process';
import type { ChannelConfig, LineEntry } from '@iptv/core';
import type { ExportCatalog, ArtifactStore } from '../store.js';
import type { RunLogger } from '../logger.js';

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { encoding: 'buffer', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as Buffer);
      },
    );
  });
}

/**
 * Optional visual verification: grab one frame per channel and publish it to
 * R2 (`shots/<channelId>.jpg`). Proves the line decodes — not just that HTTP
 * returned 200 — and gives the channel page a real preview.
 */
export async function captureScreenshots(
  store: ArtifactStore,
  limit: number,
  logger: RunLogger,
): Promise<{ captured: number; attempted: number }> {
  const catalog = await store.getJson<ExportCatalog>('out/catalog.json');
  if (!catalog) {
    logger.warn('截图跳过：没有 out/catalog.json');
    return { captured: 0, attempted: 0 };
  }

  const targets: Array<{ channel: ChannelConfig; line: LineEntry }> = [];
  for (const item of catalog.items) {
    if (targets.length >= Math.max(0, limit)) break;
    const line = item.lines.find((candidate) => candidate.status === 'alive');
    if (line) targets.push({ channel: item.channel, line });
  }

  let captured = 0;
  for (const target of targets) {
    const { line, channel } = target;
    const headers: string[] = [];
    if (line.headers?.referer) headers.push(`Referer: ${line.headers.referer}\r\n`);
    if (line.headers?.origin) headers.push(`Origin: ${line.headers.origin}\r\n`);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', line.headers?.userAgent ?? 'VLC/3.0.20 LibVLC/3.0.20',
      ...(headers.length ? ['-headers', headers.join('')] : []),
      '-ss', '2',
      '-i', line.url,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    try {
      const image = await runFfmpeg(args);
      if (image.byteLength > 0) {
        await store.put(`shots/${channel.id}.jpg`, image, 'image/jpeg');
        captured++;
      }
    } catch {
      // a screenshot failure is not a pipeline failure
    }
  }

  logger.info('截图完成', { captured, attempted: targets.length });
  return { captured, attempted: targets.length };
}
