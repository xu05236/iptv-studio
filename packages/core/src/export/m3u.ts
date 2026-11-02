import type { ExportChannel, PlaylistOptions } from './types.js';
import { escapeAttr, lineDisplayName } from './types.js';

/**
 * Standard M3U, optionally "M3U Plus" enriched with tvg-* attributes, catch-up
 * metadata and VLC request-header options (otherwise lines that need a UA or
 * Referer test fine but fail in the player).
 */
export function buildM3U(channels: ExportChannel[], options: PlaylistOptions = {}): string {
  const out: string[] = [];
  const epg = options.epgUrl ? ` url-tvg="${escapeAttr(options.epgUrl)}" x-tvg-url="${escapeAttr(options.epgUrl)}"` : '';
  out.push(`#EXTM3U${epg}`);
  if (options.headerComment) out.push(`# ${options.headerComment.replace(/[\r\n]+/g, ' ')}`);

  for (const channel of channels) {
    for (const line of channel.lines) {
      if (!line.url) continue;
      const attrs: string[] = [];
      // EPG XML uses canonical ids (cctv1); channel.tvgId is often uppercase
      // (CCTV1), which players treat as case-sensitive and fail to match.
      attrs.push(`tvg-id="${escapeAttr(channel.id)}"`);
      attrs.push(`tvg-name="${escapeAttr(channel.name)}"`);
      if (channel.logo) attrs.push(`tvg-logo="${escapeAttr(channel.logo)}"`);
      attrs.push(`group-title="${escapeAttr(channel.group)}"`);
      if (channel.number) attrs.push(`tvg-chno="${channel.number}"`);

      const catchup = line.catchup ?? options.catchupDefault;
      if (catchup) {
        attrs.push(`catchup="${escapeAttr(catchup)}"`);
        if (line.catchupSource) attrs.push(`catchup-source="${escapeAttr(line.catchupSource)}"`);
        if (line.catchupDays) attrs.push(`catchup-days="${line.catchupDays}"`);
      }

      out.push(`#EXTINF:-1 ${attrs.join(' ')},${lineDisplayName(channel, line, options)}`);
      // Some players ignore group-title but understand #EXTGRP; emit both.
      out.push(`#EXTGRP:${sanitize(channel.group)}`);
      for (const header of headerOptions(line.headers)) out.push(header);
      out.push(line.url.trim());
    }
  }
  return `${out.join('\n')}\n`;
}

function headerOptions(headers?: ExportChannel['lines'][number]['headers']): string[] {
  if (!headers) return [];
  const out: string[] = [];
  if (headers.userAgent) out.push(`#EXTVLCOPT:http-user-agent=${sanitize(headers.userAgent)}`);
  if (headers.referer) out.push(`#EXTVLCOPT:http-referrer=${sanitize(headers.referer)}`);
  if (headers.origin) out.push(`#EXTVLCOPT:http-origin=${sanitize(headers.origin)}`);
  if (headers.cookie) out.push(`#EXTVLCOPT:http-cookie=${sanitize(headers.cookie)}`);
  return out;
}

function sanitize(value: string): string {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}
