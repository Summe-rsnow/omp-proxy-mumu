import net from "node:net";
import { parseProxyUrl } from "./config.js";
import type { HealthCheckResult } from "./types.js";

interface CachedProbe {
  url: string;
  result: HealthCheckResult;
  timestamp: number;
}

let lastProbeCache: CachedProbe | null = null;
const PROBE_CACHE_TTL_MS = 3000;

/**
 * Fast health check probe for the configured proxy endpoint.
 * Connects via TCP to host:port within timeoutMs.
 * Features an in-memory 3-second cache to avoid redundant socket allocations on bursts.
 */
export async function probeProxy(
  rawUrl: string,
  timeoutMs: number = 800,
  force: boolean = false,
): Promise<HealthCheckResult> {
  const now = Date.now();
  if (!force && lastProbeCache && lastProbeCache.url === rawUrl && now - lastProbeCache.timestamp < PROBE_CACHE_TTL_MS) {
    return lastProbeCache.result;
  }

  const parsed = parseProxyUrl(rawUrl);
  if (!parsed) {
    const res: HealthCheckResult = {
      ok: false,
      latencyMs: 0,
      error: "invalid proxy url (expected http://host:port or socks5://host:port)",
    };
    lastProbeCache = { url: rawUrl, result: res, timestamp: now };
    return res;
  }

  const { host, port } = parsed;
  const startTime = now;
  const { promise, resolve } = Promise.withResolvers<HealthCheckResult>();

  let finished = false;
  const finish = (ok: boolean, errMsg?: string) => {
    if (finished) return;
    finished = true;
    const latencyMs = Date.now() - startTime;
    socket.destroy();

    const result: HealthCheckResult = { ok, latencyMs };
    if (errMsg) {
      result.error = errMsg;
    }

    lastProbeCache = { url: rawUrl, result, timestamp: Date.now() };
    resolve(result);
  };

  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeoutMs);

  socket.on("connect", () => {
    finish(true);
  });

  socket.on("timeout", () => {
    finish(false, `timeout after ${timeoutMs}ms`);
  });

  socket.on("error", (err: Error) => {
    finish(false, err.message);
  });

  return promise;
}
