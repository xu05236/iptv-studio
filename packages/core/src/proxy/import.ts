import type { ProxyKernelProtocol, ProxyProtocol } from '../types.js';

export interface ParsedProxy {
  name: string;
  protocol: ProxyProtocol | ProxyKernelProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  kernelOnly: boolean;
  /** Original node config (raw YAML block / JSON / URI) kept for kernel protocols. */
  config?: string;
}

export interface ProxyParseResult {
  nodes: ParsedProxy[];
  warnings: string[];
}

const SUPPORTED = new Set<string>(['http', 'https', 'socks5', 'socks5h']);
const KERNEL = new Set<string>(['vmess', 'vless', 'trojan', 'hysteria2', 'ss', 'anytls', 'tuic']);

function normalizeProtocol(raw: string): ProxyProtocol | ProxyKernelProtocol | null {
  const value = raw.trim().toLowerCase();
  if (value === 'socks') return 'socks5';
  if (value === 'hy2') return 'hysteria2';
  if (SUPPORTED.has(value) || KERNEL.has(value)) return value as ProxyProtocol | ProxyKernelProtocol;
  return null;
}

function emptyNode(protocol: ProxyProtocol | ProxyKernelProtocol, name: string): ParsedProxy {
  return {
    name,
    protocol,
    host: '',
    port: 0,
    username: '',
    password: '',
    kernelOnly: !SUPPORTED.has(protocol),
  };
}

export function parseProxyUri(raw: string): ParsedProxy | null {
  const text = raw.trim();
  if (!text || text.startsWith('//')) return null;
  const hashIndex = text.indexOf('#');
  const label = hashIndex >= 0 ? decodeURIComponent(text.slice(hashIndex + 1)) : '';
  const base = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  try {
    const url = new URL(base);
    const protocol = normalizeProtocol(url.protocol.replace(':', ''));
    if (!protocol) return null;
    const node = emptyNode(protocol, label || protocol);
    node.host = url.hostname;
    node.port = Number(url.port) || 0;
    node.username = decodeURIComponent(url.username || '');
    node.password = decodeURIComponent(url.password || '');
    if (node.kernelOnly) node.config = text;
    return node;
  } catch {
    return null;
  }
}

/** host:port or host:port:username:password */
export function parseHostPortLine(raw: string): ParsedProxy | null {
  const text = raw.trim();
  if (!text || text.includes('://')) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const host = parts[0]?.trim();
  const port = Number(parts[1]);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65_535) return null;
  const node = emptyNode('http', host);
  node.host = host;
  node.port = port;
  if (parts.length >= 4) {
    node.username = parts[2]?.trim() ?? '';
    node.password = parts.slice(3).join(':').trim();
  }
  return node;
}

function unquote(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function nodeFromRecord(record: Record<string, unknown>, fallbackName: string): ParsedProxy | null {
  const rawType = String(record.type ?? record.protocol ?? '');
  const protocol = normalizeProtocol(rawType);
  if (!protocol) return null;
  const node = emptyNode(protocol, String(record.name ?? record.tag ?? fallbackName));
  node.host = String(record.server ?? record.host ?? record.address ?? '');
  node.port = Number(record.port ?? record.server_port) || 0;
  node.username = String(record.username ?? record.user ?? '');
  node.password = String(record.password ?? record.pass ?? '');
  // Kernel protocols need the complete config (ws/grpc/tls/reality/...), which
  // the flat fields above cannot represent. Keep the source object verbatim.
  if (node.kernelOnly) node.config = JSON.stringify(record);
  return node;
}

function parseJson(text: string): ProxyParseResult | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { proxies?: unknown[] }).proxies ?? (parsed as { outbounds?: unknown[] }).outbounds;
    if (!Array.isArray(list)) return null;
    const nodes: ParsedProxy[] = [];
    const warnings: string[] = [];
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const node = nodeFromRecord(item as Record<string, unknown>, `json-${index + 1}`);
      if (node) nodes.push(node);
      else warnings.push(`第 ${index + 1} 条 JSON 节点缺少可识别协议`);
    });
    return { nodes, warnings };
  } catch {
    return null;
  }
}

function parseClashYaml(text: string): ProxyParseResult | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^proxies\s*:\s*$/.test(line.trim()));
  if (start < 0) return null;
  const nodes: ParsedProxy[] = [];
  const warnings: string[] = [];
  let current: Record<string, unknown> | null = null;
  let rawLines: string[] = [];
  const flush = () => {
    if (!current) return;
    const node = nodeFromRecord(current, `yaml-${nodes.length + 1}`);
    if (node) {
      // Preserve the whole YAML block so kernel-only nodes keep ws/grpc/tls fields.
      if (node.kernelOnly) node.config = rawLines.join('\n').trim();
      nodes.push(node);
    } else {
      warnings.push(`YAML 节点 ${String(current.name ?? '')} 协议不支持`);
    }
    current = null;
    rawLines = [];
  };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      if (current) rawLines.push('');
      continue;
    }
    // A non-indented key ends the proxies block.
    if (/^\S/.test(line) && !line.startsWith('-')) break;
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      flush();
      rawLines = [line];
      const rest = item[1]?.trim() ?? '';
      if (rest.startsWith('{')) {
        const record: Record<string, unknown> = {};
        const body = rest.replace(/^\{/, '').replace(/\}$/, '');
        for (const pair of body.split(',')) {
          const split = pair.indexOf(':');
          if (split <= 0) continue;
          record[unquote(pair.slice(0, split))] = unquote(pair.slice(split + 1));
        }
        current = record;
        flush();
      } else {
        current = {};
        const pair = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (pair) current[pair[1]] = unquote(pair[2] ?? '');
      }
      continue;
    }
    if (current) rawLines.push(line);
    const pair = line.match(/^(\s+)([\w-]+)\s*:\s*(.*)$/);
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    // Only top-level node fields are read from the flat map; nested ws/grpc/tls
    // options stay in the preserved raw block above.
    if (pair && current && indent <= 4) current[pair[2]] = unquote(pair[3] ?? '');
  }
  flush();
  return { nodes, warnings };
}

function decodeBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  try {
    const decoded = atob(compact);
    return decoded.includes('://') || decoded.includes('\n') ? decoded : null;
  } catch {
    return null;
  }
}

export function parseProxyText(text: string): ProxyParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { nodes: [], warnings: ['内容为空'] };
  const json = parseJson(trimmed);
  if (json) return json;
  const yaml = parseClashYaml(trimmed);
  if (yaml) return yaml;
  const decoded = decodeBase64(trimmed);
  if (decoded) return parseProxyText(decoded);
  const nodes: ParsedProxy[] = [];
  const warnings: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const node = parseProxyUri(raw) ?? parseHostPortLine(raw);
    if (node) nodes.push(node);
    else warnings.push(`无法识别：${raw.slice(0, 60)}`);
  }
  return { nodes, warnings };
}

/** Dedupe by protocol + host + port + username; names are not part of identity. */
export function dedupeParsedProxies(nodes: ParsedProxy[]): ParsedProxy[] {
  const seen = new Set<string>();
  const result: ParsedProxy[] = [];
  for (const node of nodes) {
    const key = `${node.protocol}|${node.host.toLowerCase()}|${node.port}|${node.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}
