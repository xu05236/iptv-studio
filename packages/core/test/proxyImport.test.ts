import { describe, expect, it } from 'vitest';
import { dedupeParsedProxies, parseProxyText } from '../src/proxy/import.js';

describe('parseProxyText', () => {
  it('parses URI lines with auth and a display name', () => {
    const result = parseProxyText([
      'http://user:pass@1.2.3.4:8080#深圳电信',
      'socks5://5.6.7.8:1080',
      'vmess://eyJ2IjoiMiJ9#老节点',
    ].join('\n'));
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0]).toMatchObject({ protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass', name: '深圳电信', kernelOnly: false });
    expect(result.nodes[1]).toMatchObject({ protocol: 'socks5', host: '5.6.7.8', port: 1080, kernelOnly: false });
    expect(result.nodes[2]).toMatchObject({ protocol: 'vmess', kernelOnly: true });
  });

  it('parses host:port:user:pass lines', () => {
    const result = parseProxyText('1.2.3.4:3128:alice:wonder:land');
    expect(result.nodes[0]).toMatchObject({ protocol: 'http', host: '1.2.3.4', port: 3128, username: 'alice', password: 'wonder:land' });
  });

  it('parses a Clash YAML proxies block and skips unsupported types', () => {
    const yaml = [
      'proxies:',
      '  - name: 上海联通',
      '    type: http',
      '    server: 9.9.9.9',
      '    port: 8080',
      '    username: u',
      '    password: p',
      '  - {name: 内核节点, type: vmess, server: 2.2.2.2, port: 443}',
      'rules:',
      '  - MATCH,DIRECT',
    ].join('\n');
    const result = parseProxyText(yaml);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({ name: '上海联通', host: '9.9.9.9', port: 8080, username: 'u' });
    expect(result.nodes[1]).toMatchObject({ protocol: 'vmess', kernelOnly: true });
  });

  it('parses JSON arrays and reports unusable entries', () => {
    const result = parseProxyText(JSON.stringify([
      { name: 'a', type: 'socks5', server: '3.3.3.3', port: 1080 },
      { name: 'bad', type: 'unknown-proto' },
    ]));
    expect(result.nodes).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('decodes base64 subscriptions and dedupes identical exits', () => {
    const plain = 'http://u:p@1.1.1.1:8000#A\nhttp://u:p@1.1.1.1:8000#B';
    const result = parseProxyText(btoa(plain));
    expect(result.nodes).toHaveLength(2);
    expect(dedupeParsedProxies(result.nodes)).toHaveLength(1);
  });

  it('keeps the full YAML block for kernel-only nodes', () => {
    const yaml = [
      'proxies:',
      '  - name: n1',
      '    type: vmess',
      '    server: 1.2.3.4',
      '    port: 443',
      '    uuid: abc',
      '    network: ws',
      '    ws-opts:',
      '      path: /ws',
      '      headers:',
      '        Host: example.com',
    ].join('\n');
    const result = parseProxyText(yaml);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ protocol: 'vmess', host: '1.2.3.4', port: 443, kernelOnly: true });
    expect(result.nodes[0]?.config).toContain('ws-opts');
    expect(result.nodes[0]?.config).toContain('/ws');
    expect(result.nodes[0]?.config).toContain('example.com');
  });

  it('parses sing-box outbounds with tag/server_port and keeps their config', () => {
    const result = parseProxyText(JSON.stringify({
      outbounds: [{ type: 'trojan', tag: 'hk', server: 'x.example', server_port: 8443, password: 'p' }],
    }));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ name: 'hk', protocol: 'trojan', host: 'x.example', port: 8443, kernelOnly: true });
    expect(result.nodes[0]?.config).toContain('x.example');
  });

  it('keeps the raw URI as config for kernel protocols', () => {
    const raw = 'vmess://eyJ2IjoiMiIsInBzIjoi5rWL6K+VIn0=#name';
    const node = parseProxyText(raw).nodes[0];
    expect(node?.kernelOnly).toBe(true);
    expect(node?.config).toBe(raw);
  });
});

describe('client line formats (Quantumult X / Surge / Loon)', () => {
  it('parses a Quantumult X shadowsocks line', () => {
    const result = parseProxyText('shadowsocks=1.2.3.4:8388, method=aes-256-gcm, password=pass123, tag=香港');
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node).toMatchObject({ protocol: 'ss', host: '1.2.3.4', port: 8388, password: 'pass123', name: '香港', kernelOnly: true });
    expect(JSON.parse(node.config!)).toMatchObject({
      type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'pass123',
    });
  });

  it('parses a Surge vmess line into a mihomo JSON config', () => {
    const result = parseProxyText('东京 = vmess, 5.6.7.8, 443, username=uuid-1234, tls=true, ws=true, ws-path=/ws');
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node).toMatchObject({ protocol: 'vmess', host: '5.6.7.8', port: 443, username: 'uuid-1234', name: '东京', kernelOnly: true });
    expect(JSON.parse(node.config!)).toMatchObject({
      type: 'vmess', server: '5.6.7.8', port: 443, uuid: 'uuid-1234', tls: true, network: 'ws',
    });
  });

  it('parses a Loon positional shadowsocks line', () => {
    const result = parseProxyText('香港 = Shadowsocks, 9.9.9.9, 8388, aes-128-gcm, "pw"');
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node).toMatchObject({ protocol: 'ss', host: '9.9.9.9', port: 8388, password: 'pw' });
    expect(JSON.parse(node.config!)).toMatchObject({ type: 'ss', cipher: 'aes-128-gcm', password: 'pw' });
  });

  it('parses a Surge http proxy without kernel framing', () => {
    const result = parseProxyText('公司 = http, 10.0.0.5, 8080, user=alice, password=secret');
    expect(result.nodes[0]).toMatchObject({ protocol: 'http', host: '10.0.0.5', port: 8080, username: 'alice', password: 'secret', kernelOnly: false });
    expect(result.nodes[0]!.config).toBeUndefined();
  });
});
