import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchViaProxy } from '../src/lib/proxyFetch.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('fetchViaProxy', () => {
  it('reads a response through a CONNECT-only proxy', async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '9' });
      response.end('hello-sub');
    });
    const targetPort = await listen(target);
    const proxy = createServer();
    proxy.on('connect', (request, clientSocket) => {
      const [host, port] = String(request.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    try {
      const result = await fetchViaProxy(`http://127.0.0.1:${targetPort}/sub`, {
        id: 'p1',
        protocol: 'http',
        host: '127.0.0.1',
        port: proxyPort,
        username: '',
        password: '',
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe('hello-sub');
    } finally {
      target.close();
      proxy.close();
    }
  });

  it('rejects a proxy that answers CONNECT with 403', async () => {
    const proxy = createServer();
    proxy.on('connect', (_request, clientSocket) => {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const proxyPort = await listen(proxy);
    try {
      await expect(
        fetchViaProxy('http://example.com/sub', {
          id: 'p2',
          protocol: 'http',
          host: '127.0.0.1',
          port: proxyPort,
          username: '',
          password: '',
        }),
      ).rejects.toThrow('代理 CONNECT 失败 HTTP 403');
    } finally {
      proxy.close();
    }
  });
});
