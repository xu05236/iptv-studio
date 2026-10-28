const TOKEN_KEY = 'iptv.admin.session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const method = (init.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { response, text } = await fetchWithTimeout(path, { ...init, headers });
      const data = text ? safeParse(text) : null;

      if (!response.ok) {
        if (response.status === 401) {
          clearToken();
          window.dispatchEvent(new Event('auth:logout'));
        }
        const message = (data as { error?: string } | null)?.error ?? `请求失败 (${response.status})`;
        throw new ApiError(response.status, message);
      }
      return data as T;
    } catch (error) {
      // 4xx/5xx are definitive; only network errors/timeouts get another IP
      // (Cloudflare returns two IPv4 addresses and one can be unreachable).
      if (error instanceof ApiError) throw error;
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new ApiError(
    0,
    lastError instanceof DOMException && lastError.name === 'AbortError'
      ? '连接 Cloudflare 超时，已自动重试；若持续失败请开启 IPv6 或稍后再试'
      : '网络连接失败，请检查网络后重试',
  );
}

async function fetchWithTimeout(path: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  // The China -> Cloudflare path can spend 9-10s in TLS alone; a 6s cap
  // aborted every request before it was even sent.
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export async function loginWithToken(token: string): Promise<string> {
  const result = await request<{ token: string }>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  setToken(result.token);
  return result.token;
}
