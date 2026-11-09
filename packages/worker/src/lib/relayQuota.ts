export interface RelayQuotaLimits {
  requests: number;
  bytes: number;
}

export const DEFAULT_RELAY_LIMITS: RelayQuotaLimits = { requests: 20_000, bytes: 2 * 1024 ** 3 };

interface QuotaState {
  day: string;
  requests: number;
  bytes: number;
}

const quotas = new Map<string, QuotaState>();
let limits: RelayQuotaLimits = { ...DEFAULT_RELAY_LIMITS };

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function stateOf(id: string, now: number): QuotaState {
  const day = dayOf(now);
  const item = quotas.get(id);
  if (!item || item.day !== day) return { day, requests: 0, bytes: 0 };
  return item;
}

/** Settings live in D1; the relay caches them for 60s and refreshes the limits here. */
export function setRelayQuotaLimits(next: Partial<RelayQuotaLimits>): void {
  limits = {
    requests: Math.max(1, Math.floor(next.requests ?? limits.requests)),
    bytes: Math.max(1, Math.floor(next.bytes ?? limits.bytes)),
  };
}

export function relayQuotaExceeded(id: string, now = Date.now()): boolean {
  const item = stateOf(id, now);
  return item.requests >= limits.requests || item.bytes >= limits.bytes;
}

/** Records one relayed request; returns true when the caller has just hit a limit. */
export function recordRelayUse(id: string, bytes = 0, now = Date.now()): boolean {
  const item = stateOf(id, now);
  item.requests += 1;
  item.bytes += Math.max(0, Math.floor(bytes));
  quotas.set(id, item);
  if (quotas.size > 5_000) quotas.clear();
  return item.requests >= limits.requests || item.bytes >= limits.bytes;
}

/** Seconds until the quota window resets at UTC midnight. */
export function relayQuotaRetryAfter(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}
