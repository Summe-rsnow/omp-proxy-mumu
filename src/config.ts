import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyConfig } from "./types.js";

/**
 * STRICT REQUIREMENT:
 * Zero default rules, zero default ports.
 * Unconfigured by default.
 */
export const DEFAULT_CONFIG: Readonly<ProxyConfig> = Object.freeze({
  enabled: false,
  url: "",
  injectChildEnv: true,
  probeTimeoutMs: 800,
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
    let urlToParse = trimmed;
    const hasScheme = urlToParse.includes("://");
    if (!hasScheme) {
      urlToParse = `http://${urlToParse}`;
    }
    const parsed = new URL(urlToParse);
    const protocol = parsed.protocol.replace(":", "").toLowerCase();
    const host = parsed.hostname;
    // Proxy endpoints must have an explicit port (e.g. 7890, 10808)
    if (!parsed.port) {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    if (!host || Number.isNaN(port) || port <= 0 || port > 65535) {
      return null;
    }
    return { protocol, host, port };
  } catch {
    return null;
  }
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
        url: typeof parsed.url === "string" ? parsed.url.trim() : "",
        injectChildEnv: parsed.injectChildEnv ?? true,
        probeTimeoutMs: parsed.probeTimeoutMs && parsed.probeTimeoutMs > 100 ? parsed.probeTimeoutMs : 800,
        rules: {
          direct: Array.isArray(parsed.rules?.direct) ? parsed.rules.direct : [],
          proxy: Array.isArray(parsed.rules?.proxy) ? parsed.rules.proxy : [],
        },
      };
    }
  } catch {
    // Corrupted file -> fallback to clean zero-default
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
