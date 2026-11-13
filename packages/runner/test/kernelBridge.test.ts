import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildKernelConfig, clashProxyFromJson, ensureMihomoBinary } from '../src/lib/kernelBridge.js';

describe('kernelBridge config generation', () => {
  it('maps sing-box vmess security to cipher and flattens ws headers', () => {
    const proxy = clashProxyFromJson({
      type: 'vmess',
      server: '1.2.3.4',
      server_port: 80,
      uuid: '33bb',
      security: 'auto',
      alter_id: 0,
      transport: { type: 'ws', path: '/', headers: { Host: ['tms.dingtalk.com'] } },
    });
    expect(proxy).toMatchObject({ type: 'vmess', cipher: 'auto', alterId: 0, network: 'ws' });
    expect((proxy?.['ws-opts'] as { headers: Record<string, string> }).headers.Host).toBe('tms.dingtalk.com');
  });

  it('accepts anytls sing-box outbounds', () => {
    const proxy = clashProxyFromJson({
      type: 'anytls',
      server: 'v6.example.com',
      server_port: 8443,
      password: 'secret',
      tls: { enabled: true, server_name: 'v6.example.com', insecure: true },
    });
    expect(proxy).toMatchObject({ type: 'anytls', server: 'v6.example.com', port: 8443, password: 'secret', 'skip-cert-verify': true });
  });

  it('embeds a stored Clash YAML block and pins MATCH to its name', () => {
    const block = [
      '  - name: n1',
      '    type: vmess',
      '    server: 1.2.3.4',
      '    port: 443',
      '    uuid: abc',
      '    ws-opts:',
      '      path: /ws',
    ].join('\n');
    const built = buildKernelConfig([{ id: 'a', name: 'n1', protocol: 'vmess', config: block }], 7890);
    expect(built.usable).toHaveLength(1);
    expect(built.yaml).toContain('mixed-port: 7890');
    expect(built.yaml).toContain('ws-opts');
    expect(built.yaml).toContain('MATCH,n1');
  });

  it('converts a sing-box outbound into a mihomo proxy', () => {
    const config = JSON.stringify({
      type: 'trojan',
      tag: 'hk',
      server: 'x.example',
      server_port: 443,
      password: 'p',
      tls: { enabled: true, server_name: 'sni.example' },
      transport: { type: 'ws', path: '/ws' },
    });
    const built = buildKernelConfig([{ id: 'b', name: 'hk', protocol: 'trojan', config }]);
    expect(built.warnings).toHaveLength(0);
    expect(built.yaml).toContain('type: "trojan"');
    expect(built.yaml).toContain('servername: "sni.example"');
    expect(built.yaml).toContain('ws-opts');
    expect(built.yaml).toContain('MATCH,node-0');
  });

  it('converts a vmess URI', () => {
    const payload = { v: '2', ps: 'v', add: '1.2.3.4', port: '443', id: 'uuid', aid: '0', net: 'ws', path: '/ws', host: 'h' };
    const uri = `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
    const built = buildKernelConfig([{ id: 'c', name: 'v', protocol: 'vmess', config: uri }]);
    expect(built.warnings).toHaveLength(0);
    expect(built.yaml).toContain('type: "vmess"');
    expect(built.yaml).toContain('"1.2.3.4"');
  });

  it('skips unusable configs with a warning', () => {
    const built = buildKernelConfig([{ id: 'd', name: 'bad', protocol: 'vmess', config: 'not-a-config' }]);
    expect(built.usable).toHaveLength(0);
    expect(built.warnings).toHaveLength(1);
  });
});

describe('ensureMihomoBinary', () => {
  it('downloads a gzipped binary once and reuses the cache', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(gzipSync(Buffer.from('#!/bin/sh\necho mihomo\n')));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kernel-bridge-'));
    try {
      const binary = await ensureMihomoBinary(dir, { url: `http://127.0.0.1:${port}/mihomo.gz` });
      expect(readFileSync(binary, 'utf8')).toContain('echo mihomo');
      const again = await ensureMihomoBinary(dir, { url: `http://127.0.0.1:${port}/mihomo.gz` });
      expect(again).toBe(binary);
      expect(hits).toBe(1);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a checksum mismatch', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(gzipSync(Buffer.from('mihomo')));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kernel-bridge-'));
    try {
      await expect(
        ensureMihomoBinary(dir, { url: `http://127.0.0.1:${port}/mihomo.gz`, sha256: 'deadbeef' }),
      ).rejects.toThrow('校验失败');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
