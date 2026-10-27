/** Structured run log: printed live and persisted as JSONL in R2. */
export class RunLogger {
  readonly entries: Array<Record<string, unknown>> = [];

  private write(level: string, message: string, data?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, message, ...(data ?? {}) };
    this.entries.push(entry);
    const suffix = data ? ` ${JSON.stringify(data)}` : '';
    (level === 'error' ? console.error : console.log)(`[${level}] ${message}${suffix}`);
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
