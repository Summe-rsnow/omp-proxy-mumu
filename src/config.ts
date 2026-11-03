import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyConfig } from "./types.js";

/**
 * Default configuration for omp-proxy-mumu:
 * - off by default (enabled: false)
 * - default host: 127.0.0.1 (localhost)
 * - default port: 7890
 */
export const DEFAULT_CONFIG: Readonly<ProxyConfig> = Object.freeze({
  enabled: false,
  url: "http://127.0.0.1:7890",
  injectChildEnv: true,
  probeTimeoutMs: 800,
  lang: "auto",
  rules: {
    direct: [],
    proxy: [],
  },
});

let cachedConfigPath: string | null = null;

export function getConfigPath(): string {
  if (cachedConfigPath) return cachedConfigPath;
  const home = os.homedir();
  const dir = path.join(home, ".omp", "agent");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  cachedConfigPath = path.join(dir, "proxy-config.json");
  return cachedConfigPath;
}

export function parseProxyUrl(rawUrl: string): { protocol: string; host: string; port: number } | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (!protocol.startsWith("http") && !protocol.startsWith("socks")) {
      return null;
    }

    const host = parsed.hostname;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 0;
    if (!host || Number.isNaN(port) || port <= 0 || port > 65535) {
      return null;
    }

    return { protocol, host, port };
  } catch {
    return null;
  }
}

export function updateUrlPort(rawUrl: string, port: number): string {
  const parsed = parseProxyUrl(rawUrl);
  if (!parsed) {
    return `http://127.0.0.1:${port}`;
  }
  const protocol = parsed.protocol || "http:";
  const host = parsed.host || "127.0.0.1";
  return `${protocol}//${host}:${port}`;
}

/**
 * Gate check: Even if config.enabled is true,
 * if it is not configured with a valid host and port, it must NOT be enabled.
 */
export function isConfigured(config: ProxyConfig): boolean {
  if (!config || !config.url) return false;
  const parsed = parseProxyUrl(config.url);
  return parsed !== null && Boolean(parsed.host) && parsed.port > 0;
}

export function loadConfig(): ProxyConfig {
  const filePath = getConfigPath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<ProxyConfig>;
      return {
        enabled: Boolean(parsed.enabled),
        url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : DEFAULT_CONFIG.url,
        injectChildEnv: parsed.injectChildEnv ?? DEFAULT_CONFIG.injectChildEnv,
        probeTimeoutMs: parsed.probeTimeoutMs && parsed.probeTimeoutMs > 100 ? parsed.probeTimeoutMs : DEFAULT_CONFIG.probeTimeoutMs,
        lang: parsed.lang === "zh" || parsed.lang === "en" || parsed.lang === "auto" ? parsed.lang : "auto",
        rules: {
          direct: Array.isArray(parsed.rules?.direct) ? parsed.rules.direct : [],
          proxy: Array.isArray(parsed.rules?.proxy) ? parsed.rules.proxy : [],
        },
      };
    }
  } catch {
    // Corrupted file -> fallback to clean default
  }
  return {
    ...DEFAULT_CONFIG,
    rules: { direct: [], proxy: [] },
  };
}

export function saveConfig(config: ProxyConfig): void {
  const filePath = getConfigPath();
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}
