import { isConfigured } from "./config.js";
import {
  applyProxyEnv,
  captureProxyEnv,
  restoreProxyEnv,
  sanitizeInheritedProxyEnv,
  toFetchProxyUrl,
  type ProxyEnvIssue,
} from "./env.js";
import { resolveLanguage, t, type ResolvedLang } from "./i18n.js";
import { probeProxy } from "./probe.js";
import { clearRouteCache, PROXY_ERROR_HEADER, shouldProxyHost, TunnelManager } from "./tunnel.js";
import type { ProxyConfig, ProxyRuntimeStatus } from "./types.js";
type ProxiedInit = RequestInit & { proxy?: string | false; respectNoProxy?: boolean };

/**
 * Forces a truly direct request: without `proxy: false`, Bun routes through
 * HTTP_PROXY/HTTPS_PROXY/ALL_PROXY even when the plugin chose the direct path.
 */
function directInit(init?: RequestInit): ProxiedInit {
  return { ...init, proxy: false };
}

/** Bun rejects these codes before opening a socket; retrying direct can fix it. */
const PROTOCOL_ERROR_CODES: Record<string, true> = {
  UnsupportedProxyProtocol: true,
  ERR_INVALID_ARG_VALUE: true,
};

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

function errorCode(err: unknown): string {
  if (err === null || typeof err !== "object" || !("code" in err)) return "";
  return typeof err.code === "string" ? err.code : "";
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "message" in err) {
    if (typeof err.message === "string" && err.message !== "") return err.message;
  }
  return String(err);
}

/**
 * A request body that survived the first attempt can be sent again, unless it
 * is a stream (already consumed) — retrying those would resend partial data.
 */
function isReplayable(input: string | URL | Request, init?: RequestInit): boolean {
  if (input instanceof Request && input.body !== null) return false;
  const body = init?.body;
  if (body === undefined || body === null) return true;
  return typeof ReadableStream === "undefined" || !(body instanceof ReadableStream);
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
  private listeners: Array<(status: ProxyRuntimeStatus) => void> = [];
  private notifier: ((msg: string, level: "info" | "warning" | "error") => void) | undefined;
  private noticeTimes = new Map<string, number>();
  private envIssues: ProxyEnvIssue[] = [];

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  /** Receives runtime warnings once a UI is available (session_start). */
  setNotifier(fn: ((msg: string, level: "info" | "warning" | "error") => void) | undefined): void {
    this.notifier = fn;
  }

  /** Proxy env vars dropped at install because Bun's fetch cannot honor them. */
  getEnvIssues(): ProxyEnvIssue[] {
    return [...this.envIssues];
  }

  private notifyThrottled(kind: string, msg: string, level: "info" | "warning" | "error"): void {
    const now = Date.now();
    const last = this.noticeTimes.get(kind) ?? 0;
    if (now - last < 30_000) return;
    this.noticeTimes.set(kind, now);
    this.notifier?.(msg, level);
  }

  onStatusChange(fn: (status: ProxyRuntimeStatus) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch {
        // ignore listener errors
      }
    }
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
    const lang = resolveLanguage(newConfig.lang);

    if (!newConfig.enabled) {
      this.isActive = false;
      this.status = {
        state: "disabled",
        configuredUrl: newConfig.url,
        enabled: false,
      };
      await this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      this.notifyListeners();
      return this.status;
    }

    if (!isConfigured(newConfig)) {
      this.isActive = false;
      this.status = {
        state: "unconfigured",
        configuredUrl: newConfig.url,
        enabled: true,
      };
      await this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      this.notifyListeners();
      notifyFn?.(
        `[omp-proxy-mumu] ${t(lang, "onUnconfigured")}`,
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
      await this.syncChildProcessEnv(false);
      await this.tunnelManager.stop();
      this.notifyListeners();
      notifyFn?.(
        `[omp-proxy-mumu] ${t(lang, "onUnreachable", { url: newConfig.url, error: checkResult.error || "failed" })}`,
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
    await this.syncChildProcessEnv(newConfig.injectChildEnv);
    this.notifyListeners();
    notifyFn?.(
      `[omp-proxy-mumu] ${t(lang, "onActive", { url: newConfig.url, latency: checkResult.latencyMs })}`,
      "info",
    );
    return this.status;
  }

  /**
   * Mirrors the active proxy into this process (children inherit it).
   *
   * Only values Bun's fetch can honor are written: an http(s) URL, or the local
   * HTTP CONNECT bridge when the configured proxy is socks. Anything else makes
   * every in-process request fail with UnsupportedProxyProtocol.
   */
  private async syncChildProcessEnv(inject: boolean): Promise<void> {
    if (!this.isActive || !inject || !this.config.url) {
      restoreProxyEnv();
      return;
    }

    const direct = toFetchProxyUrl(this.config.url);
    if (direct) {
      applyProxyEnv(direct);
      return;
    }

    try {
      const bridged = await this.tunnelManager.getFetchProxyUrl(this.config);
      const envUrl = bridged ? toFetchProxyUrl(bridged) : null;
      if (envUrl) {
        applyProxyEnv(envUrl);
        return;
      }
    } catch {
      // Bridge unavailable: fall through and leave the inherited env alone.
    }
    restoreProxyEnv();
  }

  install(): void {
    if (this.isHooked) return;
    this.isHooked = true;

    // A socks/malformed HTTP(S)_PROXY in the inherited env makes Bun's fetch
    // throw UnsupportedProxyProtocol on every call, proxy or not. Clean it up
    // before the first request, and remember it for the session warning.
    captureProxyEnv();
    this.envIssues = sanitizeInheritedProxyEnv();

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
      return nativeFetch(input, directInit(init));
    }

    const lang = resolveLanguage(this.config.lang);

    let proxyUrl: string | null;
    try {
      proxyUrl = await this.tunnelManager.getFetchProxyUrl(this.config);
    } catch (err) {
      // Bridge cannot start: degrade instead of failing every request.
      this.degrade("bridge", err, lang);
      return nativeFetch(input, directInit(init));
    }
    if (proxyUrl === null) {
      return nativeFetch(input, directInit(init));
    }

    // Bun's fetch only accepts http(s) proxies and rejects anything else before
    // opening a socket, so never hand it an unsupported scheme.
    if (toFetchProxyUrl(proxyUrl) === null) {
      this.degrade("protocol", new Error(`unsupported proxy protocol: ${proxyUrl}`), lang);
      return nativeFetch(input, directInit(init));
    }

    const replayable = isReplayable(input, init);
    let proxyError: unknown;

    try {
      const proxiedInit: ProxiedInit = { ...init, proxy: proxyUrl, respectNoProxy: false };
      const response = await nativeFetch(input, proxiedInit);
      // Bun turns a proxy socket that dies before replying into an empty 200.
      // The bridge marks its own failures so they get retried directly instead.
      if (response.headers.get(PROXY_ERROR_HEADER) === null) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      proxyError = new Error(t(lang, "bridgeFailure", { status: String(response.status) }));
    } catch (err) {
      proxyError = err;
    }

    if (!replayable) {
      // Resending a consumed stream would duplicate a partial upload.
      this.notifyThrottled(
        "body",
        `[omp-proxy-mumu] ${t(lang, "proxyBodyNotReplayable", {
          url: this.config.url,
          error: errorMessage(proxyError),
        })}`,
        "warning",
      );
      throw proxyError;
    }

    if (PROTOCOL_ERROR_CODES[errorCode(proxyError)] === true) {
      // The runtime refused the scheme; the inherited env may be the cause.
      sanitizeInheritedProxyEnv();
      this.degrade("protocol", proxyError, lang);
    } else {
      this.notifyThrottled(
        "fallback",
        `[omp-proxy-mumu] ${t(lang, "proxyFallback", {
          url: this.config.url,
          error: errorMessage(proxyError),
        })}`,
        "warning",
      );
    }

    // FAIL-SAFE: fall back to the native direct path (`proxy: false` keeps the
    // injected env from dragging the retry through the failing proxy again).
    try {
      return await nativeFetch(input, directInit(init));
    } catch (directError) {
      // A poisoned env var fails the direct path identically: clean, retry once.
      if (PROTOCOL_ERROR_CODES[errorCode(directError)] === true) {
        sanitizeInheritedProxyEnv();
        try {
          return await nativeFetch(input, directInit(init));
        } catch (retryError) {
          throw this.failureError(retryError, proxyError, lang);
        }
      }
      throw this.failureError(directError, proxyError, lang);
    }
  }

  /** Error surfaced to the caller when both the proxy and direct paths failed. */
  private failureError(directError: unknown, proxyError: unknown, lang: ResolvedLang): Error {
    return new Error(
      `[omp-proxy-mumu] ${t(lang, "proxyAndDirectFailed", {
        url: this.config.url,
        error: errorMessage(proxyError),
        directError: errorMessage(directError),
      })}`,
      { cause: directError },
    );
  }

  /**
   * Stops proxying for the rest of the session and reports why. Used when the
   * runtime or the bridge can only fail: continuing would break every request.
   */
  private degrade(kind: "protocol" | "bridge", error: unknown, lang: ResolvedLang): void {
    const detail = errorMessage(error);
    this.isActive = false;
    this.status = {
      state: "degraded",
      configuredUrl: this.config.url,
      enabled: true,
      lastError: detail,
    };
    restoreProxyEnv();
    const key = kind === "protocol" ? "degradeProtocol" : "degradeBridge";
    this.notifyThrottled(
      `degrade:${kind}`,
      `[omp-proxy-mumu] ${t(lang, key, { error: detail })}`,
      "warning",
    );
    this.notifyListeners();
  }

  uninstall(): void {
    if (!this.isHooked) return;
    globalThis.fetch = this.originalFetch;
    this.isHooked = false;
    this.isActive = false;
    this.status = { state: "disabled", configuredUrl: "", enabled: false };
    restoreProxyEnv();
    this.tunnelManager.stop().catch(() => {});
    this.notifyListeners();
  }
}
