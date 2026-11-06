/**
 * F4: decode a fetched source body using its declared charset.
 *
 * Many Chinese IPTV sources still serve GBK/GB2312 bytes while the response
 * header says `text/plain` (or nothing at all). Decoding those as UTF-8 turns
 * every channel name into garbage, which then makes the parser drop the whole
 * file. We therefore honour the charset when present, try UTF-8 strictly, and
 * fall back to GBK/GB18030/Big5 (when the runtime supports them) before the
 * lossy UTF-8 fallback.
 */
export interface DecodedSourceText {
  text: string;
  encoding: string;
}

const LEGACY_FALLBACKS = ['gbk', 'gb18030', 'big5'] as const;

function charsetOf(contentType?: string | null): string | null {
  const match = /charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

function normalizeEncoding(encoding: string): string {
  if (encoding === 'gb2312' || encoding === 'gb_2312' || encoding === 'x-gbk') return 'gbk';
  return encoding;
}

type TextDecoderInit = ConstructorParameters<typeof TextDecoder>[1];
// `ignoreBOM` is required in the Workers typings but optional in lib.dom; the
// runtime treats it as optional everywhere, so build the init once.
const FATAL_DECODE = { fatal: true } as unknown as TextDecoderInit;

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, FATAL_DECODE).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeSourceText(bytes: Uint8Array, contentType?: string | null): DecodedSourceText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  const declared = charsetOf(contentType);
  if (declared) {
    const text = tryDecode(bytes, declared);
    if (text !== null) return { text, encoding: normalizeEncoding(declared) };
  }
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };
  for (const encoding of LEGACY_FALLBACKS) {
    const text = tryDecode(bytes, encoding);
    if (text !== null) return { text, encoding };
  }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
}
