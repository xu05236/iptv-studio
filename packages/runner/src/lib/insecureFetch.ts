import http from 'node:http';
import https from 'node:https';

/**
 * node:https based fetch used only for sources with `allow_insecure_tls`.
 * undici (global fetch) has no per-request TLS switch, so this adapter exists
 * to let a source with an expired/mismatched certificate still be fetched.
 */
export const insecureFetch: typeof fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const lib = url.protocol === 'http:' ? http : https;
  const headers: Record<string, string> = {};
  const raw = init.headers as HeadersInit | undefined;
  if (raw) {
    if (Array.isArray(raw)) {
      for (const [key, value] of raw) headers[key] = value;
    } else if (typeof Headers !== 'undefined' && raw instanceof Headers) {
      raw.forEach((value, key) => { headers[key] = value; });
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) headers[key] = value;
    }
  }
  const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = lib.request(
      url,
      { method: (init.method ?? 'GET').toUpperCase(), headers, rejectUnauthorized: false },
      (upstream) => {
        const chunks: Buffer[] = [];
        upstream.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
        upstream.on('error', reject);
        upstream.on('end', () => resolve({ status: upstream.statusCode ?? 0, headers: upstream.headers, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
    }
    request.end();
  });
  const location = response.headers.location;
  if (response.status >= 300 && response.status < 400 && location && init.redirect !== 'manual') {
    const next = new URL(location, url).toString();
    return insecureFetch(next, init);
  }
  const headersOut = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') headersOut.set(key, value);
    else if (Array.isArray(value)) headersOut.set(key, value.join(', '));
  }
  return new Response(response.body.length ? new Uint8Array(response.body) : null, { status: response.status, headers: headersOut });
}) as typeof fetch;
