/** Structured run log: printed live and persisted as JSONL in the private store. */

const URL_RE = /\bhttps?:\/\/[^\s"'<>）)]+/gi;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
const HOST_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|cn|io|tv|xyz|top|fun|site|me|cc|co|info|biz|app|dev|pw|club|live|online|stream|link|us|uk|de|jp|hk|tw|ru)(?::\d+)?\b/gi;

/**
 * Mask addresses before they reach the console. GitHub Actions logs of a public
 * repository are world-readable, while the JSONL copy stays in our private
 * store; keep full detail there and redact only stdout/stderr.
 */
export function redact(text: string): string {
  return text.replace(URL_RE, '***').replace(IPV4_RE, '***').replace(IPV6_RE, '***').replace(HOST_RE, '***');
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ? `${error.message}\n${error.stack}` : error.message;
  return String(error);
}

/** Error text with the address details masked, for console-only output. */
export function redactError(prefix: string, error: unknown): string {
  return redact(`${prefix} ${describe(error)}`);
}

export class RunLogger {
  readonly entries: Array<Record<string, unknown>> = [];

  private write(level: string, message: string, data?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, message, ...(data ?? {}) };
    this.entries.push(entry);
    const suffix = data ? ` ${JSON.stringify(data)}` : '';
    (level === 'error' ? console.error : console.log)(redact(`[${level}] ${message}${suffix}`));
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data);
  }

  toJSONL(): string {
    return `${this.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }
}
