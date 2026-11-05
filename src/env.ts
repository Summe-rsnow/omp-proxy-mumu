import { parseProxyUrl } from "./config.js";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "PI_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "pi_proxy",
] as const;

export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];

export type ProxyEnvIssueReason = "malformed" | "unsupported-scheme";

export interface ProxyEnvIssue {
  key: string;
  value: string;
  reason: ProxyEnvIssueReason;
}

let snapshot: Map<ProxyEnvKey, string | undefined> | null = null;

/**
 * Canonical `<scheme>://host:port` that Bun's native fetch accepts.
 *
 * Bun's fetch (>=1.3) only understands http/https proxies: a socks, socks5 or
 * malformed value makes *every* request fail with `UnsupportedProxyProtocol`,
 * even when the URL never reaches a socket. Returning null here keeps that
 * value away from `fetch`.
 */
export function toFetchProxyUrl(rawUrl: string): string | null {
  const parsed = parseProxyUrl(rawUrl);
  if (!parsed) return null;
  if (!parsed.protocol.startsWith("http")) return null;
  const bracketless = parsed.host.startsWith("[") && parsed.host.endsWith("]")
    ? parsed.host
    : parsed.host.includes(":")
      ? `[${parsed.host}]`
      : parsed.host;
  return `${parsed.protocol}//${bracketless}:${parsed.port}`;
}

/** Records the proxy environment this process inherited, once. */
export function captureProxyEnv(): void {
  if (snapshot) return;
  snapshot = new Map();
  for (const key of PROXY_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
}

/**
 * Removes proxy env values that Bun's fetch cannot honor.
 *
 * Left in place they poison the host process: every fetch (including the
 * plugin's own direct fallback) throws `UnsupportedProxyProtocol`. The values
 * are unreachable for child processes too once the plugin manages env, so
 * dropping them is the only fail-safe option; the caller reports the issue.
 */
export function sanitizeInheritedProxyEnv(): ProxyEnvIssue[] {
  const issues: ProxyEnvIssue[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === "") continue;

    if (!parseProxyUrl(raw)) {
      issues.push({ key, value: raw, reason: "malformed" });
      delete process.env[key];
      continue;
    }

    if (!toFetchProxyUrl(raw)) {
      issues.push({ key, value: raw, reason: "unsupported-scheme" });
      delete process.env[key];
    }
  }
  return issues;
}

/** Hides every proxy env var (used when the proxy is off or downgraded). */
export function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
}

/** Applies one canonical http(s) proxy URL to every proxy env var. */
export function applyProxyEnv(url: string): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = url;
  }
}

/**
 * Restores the inherited proxy env, skipping values Bun's fetch cannot use.
 * Restoring a socks/malformed value would re-break every request in-process.
 */
export function restoreProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    const original = snapshot?.get(key);
    if (original !== undefined && original.trim() !== "" && toFetchProxyUrl(original)) {
      process.env[key] = original;
    } else {
      delete process.env[key];
    }
  }
}

/** Test hook: forget the captured snapshot. */
export function resetProxyEnvState(): void {
  snapshot = null;
}
