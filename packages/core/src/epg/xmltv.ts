import { XMLParser } from 'fast-xml-parser';

export interface EpgChannel {
  id: string;
  names: string[];
  icon?: string;
}

export interface EpgProgramme {
  channelId: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  stop?: number;
  title: string;
  desc?: string;
  category?: string;
  icon?: string;
}

export interface EpgData {
  channels: EpgChannel[];
  programmes: EpgProgramme[];
}

/** `20261027120000 +0800` -> epoch ms. */
export function parseXmltvDate(raw: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(String(raw ?? '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (!offset) return utc;
  const sign = offset.startsWith('-') ? -1 : 1;
  const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  return utc - offsetMinutes * 60_000;
}

export function formatXmltvDate(epochMs: number, offsetMinutes = 480): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}` +
    `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** Parse XMLTV. Tolerant: some providers omit icons, descriptions or stop times. */
export function parseXmltv(xml: string): EpgData {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => ['programme', 'channel', 'display-name'].includes(name),
  });

  const root = parser.parse(xml) as { tv?: Record<string, unknown> } | null;
  const tv = root?.tv;
  if (!tv) return { channels: [], programmes: [] };

  const channels: EpgChannel[] = [];
  for (const raw of asArray(tv.channel)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = textOf(record['@_id']);
    if (!id) continue;
    const names = asArray(record['display-name'])
      .map((entry) => (typeof entry === 'string' ? entry : textOf((entry as Record<string, unknown>)['#text'])))
      .filter(Boolean);
    const icons = asArray(record.icon);
    const icon = icons.length ? textOf((icons[0] as Record<string, unknown>)?.['@_src']) : undefined;
    channels.push({ id, names: names.length ? names : [id], icon });
  }

  const programmes: EpgProgramme[] = [];
  for (const raw of asArray(tv.programme)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const channelId = textOf(record['@_channel']);
    const start = parseXmltvDate(textOf(record['@_start']));
    if (!channelId || start === null) continue;
    const stop = parseXmltvDate(textOf(record['@_stop'])) ?? undefined;
    const title = firstText(record.title);
    if (!title) continue;
    const icons = asArray(record.icon);
    programmes.push({
      channelId,
      start,
      stop: stop ?? undefined,
      title,
      desc: firstText(record.desc) || undefined,
      category: firstText(record.category) || undefined,
      icon: icons.length ? textOf((icons[0] as Record<string, unknown>)?.['@_src']) : undefined,
    });
  }

  return { channels, programmes };
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return textOf((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function firstText(value: unknown): string {
  for (const item of asArray(value)) {
    const text = textOf(item);
    if (text) return text;
  }
  return '';
}

export interface BuildXmltvOptions {
  generator?: string;
  timezoneOffsetMinutes?: number;
  channelNames?: Map<string, string>;
  includeEmptyChannels?: boolean;
}

/** Serialise a merged guide. Written by hand to keep output small and stable. */
export function buildXmltv(data: EpgData, options: BuildXmltvOptions = {}): string {
  const offset = options.timezoneOffsetMinutes ?? 480;
  const names = options.channelNames ?? new Map<string, string>();
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
  out.push(`<tv generator-info-name="${escapeXml(options.generator ?? 'iptv-studio')}">`);

  const withProgrammes = new Set(data.programmes.map((programme) => programme.channelId));
  for (const channel of data.channels) {
    if (!options.includeEmptyChannels && !withProgrammes.has(channel.id)) continue;
    const display = names.get(channel.id) ?? channel.names[0] ?? channel.id;
    out.push(`  <channel id="${escapeXml(channel.id)}">`);
    out.push(`    <display-name>${escapeXml(display)}</display-name>`);
    if (channel.icon) out.push(`    <icon src="${escapeXml(channel.icon)}"/>`);
    out.push('  </channel>');
  }

  for (const programme of data.programmes) {
    const stop = programme.stop ? ` stop="${formatXmltvDate(programme.stop, offset)}"` : '';
    out.push(
      `  <programme start="${formatXmltvDate(programme.start, offset)}"${stop} channel="${escapeXml(programme.channelId)}">`,
    );
    out.push(`    <title lang="zh">${escapeXml(programme.title)}</title>`);
    if (programme.desc) out.push(`    <desc lang="zh">${escapeXml(programme.desc)}</desc>`);
    if (programme.category) out.push(`    <category lang="zh">${escapeXml(programme.category)}</category>`);
    if (programme.icon) out.push(`    <icon src="${escapeXml(programme.icon)}"/>`);
    out.push('  </programme>');
  }

  out.push('</tv>');
  return out.join('\n');
}

export function escapeXml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
