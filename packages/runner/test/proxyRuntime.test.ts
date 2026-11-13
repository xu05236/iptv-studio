import { describe, expect, it } from 'vitest';
import { activateRuntimeProxy, isKernelProxy, probeRuntimeProxy } from '../src/lib/proxyRuntime.js';

describe('proxyRuntime', () => {
  it('classifies kernel nodes', () => {
    expect(isKernelProxy({ id: 'a', protocol: 'vmess', host: '', port: 0, kernelOnly: true })).toBe(true);
    expect(isKernelProxy({ id: 'b', protocol: 'http', host: '1.2.3.4', port: 8080 })).toBe(false);
  });

  it('reports missing kernel config instead of dialing', async () => {
    const node = { id: 'a', protocol: 'vmess', host: '', port: 0, kernelOnly: true };
    const result = await probeRuntimeProxy(node);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('缺少配置');
    await expect(activateRuntimeProxy(node)).rejects.toThrow('缺少配置');
  });

  it('returns the node itself for plain proxies', async () => {
    const node = { id: 'p', protocol: 'http', host: '127.0.0.1', port: 1 };
    const active = await activateRuntimeProxy(node);
    expect(active.kernelOnly).toBe(false);
    expect(active.proxy).toBe(node);
    await active.stop();
  });
});
