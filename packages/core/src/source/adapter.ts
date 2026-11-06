import type { ParsedSource, SourceKind } from '../types.js';
import { detectSourceKind, parseHWCTC, parseJSONSource, parseM3U, parseSource, parseTXT } from '../parse/index.js';

/**
 * A source adapter describes one playlist dialect: how to recognise it, how to
 * parse it, and how to sanity-check the result. Built-ins wrap the existing
 * parsers so behaviour is identical; adding a new site dialect means adding one
 * file and registering it here (no dynamic loading — Workers cannot do that).
 */
export interface SourceAdapter {
  id: string;
  label: string;
  /** 0-1 confidence that this adapter understands the body. */
  detect(text: string): number;
  parse(text: string): ParsedSource;
  validate(entries: ParsedSource['entries']): string[];
}

const registry = new Map<string, SourceAdapter>();

const ALIASES: Record<string, string> = { tvbox: 'json' };

export function registerSourceAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getSourceAdapter(id: string): SourceAdapter | undefined {
  return registry.get(ALIASES[id] ?? id);
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...registry.values()];
}

function builtin(id: string, label: string, parser: (text: string) => ParsedSource): SourceAdapter {
  return {
    id,
    label,
    detect: (text) => (detectSourceKind(text) === id ? 1 : 0),
    parse: parser,
    validate: (entries) => (entries.length ? [] : ['未解析出任何条目']),
  };
}

registerSourceAdapter(builtin('m3u', 'M3U 播放列表', parseM3U));
registerSourceAdapter(builtin('txt', 'TXT 频道表', parseTXT));
registerSourceAdapter(builtin('json', 'JSON / TVBox', parseJSONSource));
registerSourceAdapter(builtin('hwctc', 'HWCTC', parseHWCTC));
registerSourceAdapter({
  id: 'auto',
  label: '自动识别',
  detect: () => 0,
  parse: (text) => parseSource(text, 'auto'),
  validate: (entries) => (entries.length ? [] : ['未解析出任何条目']),
});

/**
 * Parse with an explicit adapter id when given, otherwise pick the adapter with
 * the highest detect confidence (falling back to `auto`). Explicit kinds keep
 * the legacy parseSource behaviour so existing sources parse identically.
 */
export function parseWithAdapter(text: string, hint?: SourceKind | string | null): ParsedSource {
  if (hint && hint !== 'auto') {
    const explicit = getSourceAdapter(String(hint));
    if (explicit && explicit.id !== 'auto') return explicit.parse(text);
  }
  let best: SourceAdapter | null = null;
  let bestScore = 0;
  for (const adapter of registry.values()) {
    if (adapter.id === 'auto') continue;
    const score = adapter.detect(text);
    if (score > bestScore) {
      best = adapter;
      bestScore = score;
    }
  }
  return (best ?? registry.get('auto')!).parse(text);
}
