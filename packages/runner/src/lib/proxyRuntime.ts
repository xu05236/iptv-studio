import { probeKernelNode, startKernel, type KernelHandle } from './kernelBridge.js';
import { probeProxy, type ProxyProbeInput, type ProxyProbeResult } from './proxyFetch.js';

/** Proxy row as returned by `/api/admin/proxies?secrets=1`. */
export interface RuntimeProxy extends ProxyProbeInput {
  name?: string;
  enabled?: boolean;
  kernelOnly?: boolean;
  config?: string;
  engine?: string;
  lastOkAt?: string | null;
}

export interface ActiveProxy {
  proxy: ProxyProbeInput;
  kernelOnly: boolean;
  kernel: KernelHandle | null;
  stop: () => Promise<void>;
}

export function isKernelProxy(node: RuntimeProxy): boolean {
  return node.kernelOnly === true;
}

const UDP_ONLY_PROTOCOLS = new Set(['hysteria', 'hysteria2', 'tuic']);

/** hy2/tuic are UDP; Actions and HTTP CONNECT tunnels cannot carry them. */
export function isUdpOnlyProxy(node: { protocol: string }): boolean {
  return UDP_ONLY_PROTOCOLS.has(node.protocol.toLowerCase());
}

/** Probe a plain proxy or, for kernel nodes, start mihomo briefly and probe through it. */
export async function probeRuntimeProxy(node: RuntimeProxy): Promise<ProxyProbeResult> {
  if (!isKernelProxy(node)) return probeProxy(node);
  if (!node.config?.trim()) {
    return { ok: false, latencyMs: 0, egressIp: '', country: '', asn: '', error: '内核节点缺少配置' };
  }
  return probeKernelNode({ id: node.id, name: node.name ?? node.id, protocol: node.protocol, config: node.config });
}

/**
 * Start the node if it is a kernel node and return the local SOCKS5 endpoint to
 * use for every request in this run; always call `stop()` afterwards.
 */
export async function activateRuntimeProxy(node: RuntimeProxy): Promise<ActiveProxy> {
  if (!isKernelProxy(node)) {
    return { proxy: node, kernelOnly: false, kernel: null, stop: async () => undefined };
  }
  if (!node.config?.trim()) throw new Error(`内核节点 ${node.name ?? node.id} 缺少配置`);
  const kernel = await startKernel({ id: node.id, name: node.name ?? node.id, protocol: node.protocol, config: node.config });
  return {
    proxy: { id: node.id, protocol: 'socks5', host: '127.0.0.1', port: kernel.port },
    kernelOnly: true,
    kernel,
    stop: () => kernel.stop(),
  };
}
