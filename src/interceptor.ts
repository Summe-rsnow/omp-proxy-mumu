import { isConfigured, parseProxyUrl } from "./config.js";
import { probeProxy } from "./probe.js";
import { clearRouteCache, shouldProxyHost, TunnelManager } from "./tunnel.js";
import type { ProxyConfig, ProxyRuntimeStatus } from "./types.js";

type ProxiedInit = RequestInit & { proxy?: string };

/**
 * Extracts a hostname from an http(s) URL without allocating a RegExp match.
 * Returns "" for anything unparsable so the caller takes the direct path.
 */
function hostnameFromUrlString(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return "";
  const len = url.length;
  let start = schemeEnd + 3;
  if (start >= len) return "";
  // Skip userinfo (user:pass@host) without allocating.
  const at = url.indexOf("@", start);
  const slash = url.indexOf("/", start);
  const query = url.indexOf("?", start);
  const hash = url.indexOf("#", start);
  let authorityEnd = len;
  if (slash >= 0 && slash < authorityEnd) authorityEnd = slash;
  if (query >= 0 && query < authorityEnd) authorityEnd = query;
  if (hash >= 0 && hash < authorityEnd) authorityEnd = hash;
  if (at >= 0 && at < authorityEnd) start = at + 1;
  // IPv6 literals keep their brackets out of the route check.
  if (url.charCodeAt(start) === 91 /* [ */) {
    const close = url.indexOf("]", start);
    if (close < 0) return "";
    return url.slice(start + 1, close);
  }
  let end = start;
  while (end < authorityEnd) {
    if (url.charCodeAt(end) === 58 /* : */) break;
    end++;
  }
  return end === start ? "" : url.slice(start, end);
}

function extractHostname(input: string | URL | Request): string {
  if (typeof input === "string") return hostnameFromUrlString(input);
  if (input instanceof URL) return input.hostname;
  const url = (input as Request).url;
  return typeof url === "string" ? hostnameFromUrlString(url) : "";
}

export class ProxyInterceptor {
  private config: ProxyConfig;
  private tunnelManager = new TunnelManager();
  private originalFetch: typeof fetch = globalThis.fetch;
  private status: ProxyRuntimeStatus = {
    state: "disabled",
    configuredUrl: "",
    enabled: false,
  };
  private isHooked = false;
  // Fast-path boolean: false means every fetch goes straight to the native implementation.
  private isActive = false;

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  getStatus(): ProxyRuntimeStatus {
    return { ...this.status };
  }

  getConfig(): ProxyConfig {
    return { ...this.config };
  }

  /** True only while the proxy is configured, reachable and enabled. */
  isProxyActive(): boolean {
    return this.isActive;
  }

  /**
   * Evaluates state and applies fail-safe health check.
   * STRICT BEHAVIOR:
   * 1. If not configured, even if enabled=true, state is unconfigured and proxy is NOT enabled.
   * 2. If configured and enabled, health check runs. If unreachable, state is unreachable and automatically falls back to OFF.
   * 3. Only if configured, enabled, and reachable does state become active.
   */
  async updateConfigAndApply(
    newConfig: ProxyConfig,
    notifyFn?: (msg: string, level: "info" | "warning" | "error") => void,
  ): Promise<ProxyRuntimeStatus> {
    this.config = newConfig;
    clearRouteCache();

    if (!newConfig.enabled) {
      this.isActive = false;
      this.status = {
        state: "disabled",
        configuredUrl: newConfig.url,
        enabled: false,
      };
      this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      return this.status;
    }

    if (!isConfigured(newConfig)) {
      this.isActive = false;
      this.status = {
        state: "unconfigured",
        configuredUrl: newConfig.url,
        enabled: true,
      };
      this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      notifyFn?.(
        "[omp-proxy] 代理开关已打开，但尚未配置有效代理地址，已自动保持直连 (OFF) 路径。",
        "warning",
      );
      return this.status;
    }

    // Health check probe
    const checkResult = await probeProxy(newConfig.url, newConfig.probeTimeoutMs, true);
    this.status.lastCheck = checkResult;
    this.status.lastCheckTime = Date.now();

    if (!checkResult.ok) {
      this.isActive = false;
      this.status.state = "unreachable";
      this.status.enabled = true;
      this.status.configuredUrl = newConfig.url;
      this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      notifyFn?.(
        `[omp-proxy] 代理目标不可达 (${checkResult.error || "连接失败"})，已自动降级为直连 (OFF) 路径。`,
        "warning",
      );
      return this.status;
    }

    // Reachable & configured
    this.isActive = true;
    this.status = {
      state: "active",
      configuredUrl: newConfig.url,
      enabled: true,
      lastCheck: checkResult,
      lastCheckTime: Date.now(),
    };
    this.syncChildProcessEnv(newConfig.injectChildEnv);
    notifyFn?.(
      `[omp-proxy] 代理已启用并已连通: ${newConfig.url} (延迟 ${checkResult.latencyMs}ms)`,
      "info",
    );
    return this.status;
  }

  private syncChildProcessEnv(active: boolean): void {
    if (active && this.config.url) {
      const parsed = parseProxyUrl(this.config.url);
      if (parsed) {
        const urlStr = `${parsed.protocol}://${parsed.host}:${parsed.port}`;
        process.env.HTTP_PROXY = urlStr;
        process.env.HTTPS_PROXY = urlStr;
        process.env.http_proxy = urlStr;
        process.env.https_proxy = urlStr;
        process.env.ALL_PROXY = urlStr;
        process.env.all_proxy = urlStr;
      }
    } else {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.http_proxy;
      delete process.env.https_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
    }
  }

  install(): void {
    if (this.isHooked) return;
    this.isHooked = true;

    const self = this;
    const nativeFetch = this.originalFetch;

    // Not an async function: when the proxy is off the native promise is returned
    // as-is, so the hook adds no promise allocation and no extra microtask.
    globalThis.fetch = function proxyAwareFetch(
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      if (!self.isActive) {
        return nativeFetch(input, init);
      }
      return self.fetchThroughProxy(nativeFetch, input, init);
    } as typeof fetch;
  }

  private async fetchThroughProxy(
    nativeFetch: typeof fetch,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Fast extraction of destination hostname; unroutable -> direct native fetch.
    const hostname = extractHostname(input);
    if (hostname === "" || !shouldProxyHost(hostname, this.config.rules)) {
      return nativeFetch(input, init);
    }

    const proxyUrl = await this.tunnelManager.getFetchProxyUrl(this.config);
    if (proxyUrl === null) {
      return nativeFetch(input, init);
    }

    // Fail-safe proxy execution with automatic fallback.
    const proxiedInit: ProxiedInit = { ...init, proxy: proxyUrl };
    try {
      return await nativeFetch(input, proxiedInit);
    } catch {
      // FAIL-SAFE: If proxy fails midway, seamlessly fall back to OFF path.
      return nativeFetch(input, init);
    }
  }

  uninstall(): void {
    if (!this.isHooked) return;
    globalThis.fetch = this.originalFetch;
    this.isHooked = false;
    this.isActive = false;
    this.syncChildProcessEnv(false);
    this.tunnelManager.stop().catch(() => {});
  }
}
