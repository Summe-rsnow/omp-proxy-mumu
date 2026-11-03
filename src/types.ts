export interface ProxyRules {
  direct: string[];
  proxy: string[];
}

export interface ProxyConfig {
  /** Master switch for the proxy. If false, proxy is off. */
  enabled: boolean;
  /**
   * Target proxy URL, e.g. "http://127.0.0.1:7890" or "socks5://127.0.0.1:10808".
   * STRICT REQUIREMENT: Blank by default. If unconfigured, proxy is never enabled even if enabled=true.
   */
  url: string;
  /** Whether to inject HTTP_PROXY/HTTPS_PROXY/ALL_PROXY into child processes (bash tool). */
  injectChildEnv: boolean;
  /** Timeout in milliseconds for probe health-checks. Default 800ms. */
  probeTimeoutMs: number;
  /** Routing rules. Blank by default. */
  rules: ProxyRules;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type ProxyState = "disabled" | "unconfigured" | "unreachable" | "active";

export interface ProxyRuntimeStatus {
  state: ProxyState;
  configuredUrl: string;
  enabled: boolean;
  lastCheck?: HealthCheckResult;
  lastCheckTime?: number;
}
