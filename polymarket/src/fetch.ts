/**
 * Proxy-aware fetch. Node's native fetch doesn't respect HTTPS_PROXY,
 * so we use undici's ProxyAgent when a proxy is configured.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

export function pfetch(url: string, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher } as any) as any;
}
