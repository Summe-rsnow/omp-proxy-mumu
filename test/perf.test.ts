import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ProxyInterceptor } from "../src/interceptor.js";
import {
  clearRouteCache,
  getRouteCacheSize,
  shouldProxyHost,
} from "../src/tunnel.js";
import type { ProxyRules } from "../src/types.js";

const FETCH_URL = "https://api.example.com/v1/models";

/** Median of a sample; robust against GC pauses and scheduler noise. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function measurePerCall(
  call: () => Promise<unknown>,
  iterations: number,
  rounds: number,
): Promise<number> {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await call();
    }
    samples.push((performance.now() - start) / iterations);
  }
  return median(samples);
}

describe("Fast-path performance", () => {
  test("inactive fetch hook adds < 0.05ms per call", async () => {
    const nativeFetch = globalThis.fetch;
    let lastPromise: Promise<Response> = Promise.resolve(new Response("ok"));
    const fakeFetch = ((_input: string | URL | Request, _init?: RequestInit) => {
      lastPromise = Promise.resolve(new Response("ok"));
      return lastPromise;
    }) as typeof fetch;

    globalThis.fetch = fakeFetch;
    const interceptor = new ProxyInterceptor({ ...DEFAULT_CONFIG, rules: { direct: [], proxy: [] } });
    interceptor.install();
    try {
      expect(interceptor.isProxyActive()).toBe(false);

      // The hook must return the native promise untouched: no wrapper allocation.
      const returned = globalThis.fetch(FETCH_URL);
      expect(returned).toBe(lastPromise);
      await returned;

      // Warm up the JIT so neither measurement absorbs compilation cost.
      for (let i = 0; i < 2000; i++) {
        await globalThis.fetch(FETCH_URL);
      }

      const iterations = 20_000;
      const rounds = 7;
      const baselineMs = await measurePerCall(() => fakeFetch(FETCH_URL), iterations, rounds);
      const hookedMs = await measurePerCall(() => globalThis.fetch(FETCH_URL), iterations, rounds);

      const overheadMs = hookedMs - baselineMs;
      // Measured per-call overhead must stay under 0.05ms (50µs).
      expect(overheadMs).toBeLessThan(0.05);
      // Guard against a meaningless measurement, e.g. a no-op fake fetch.
      expect(baselineMs).toBeGreaterThan(0);
    } finally {
      interceptor.uninstall();
      globalThis.fetch = nativeFetch;
    }
  });

  test("unconfigured interceptor never routes through a proxy", async () => {
    const nativeFetch = globalThis.fetch;
    const seen: (RequestInit & { proxy?: string })[] = [];
    const fakeFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      seen.push((init ?? {}) as RequestInit & { proxy?: string });
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    globalThis.fetch = fakeFetch;
    // enabled but zero url / zero rules: the gate must keep it OFF.
    const interceptor = new ProxyInterceptor({ ...DEFAULT_CONFIG, enabled: true, url: "" });
    interceptor.install();
    try {
      await interceptor.updateConfigAndApply({ ...DEFAULT_CONFIG, enabled: true, url: "" });
      expect(interceptor.isProxyActive()).toBe(false);

      await globalThis.fetch(FETCH_URL);
      await globalThis.fetch(new URL(FETCH_URL));
      expect(seen.length).toBe(2);
      for (const init of seen) {
        expect(init.proxy).toBeUndefined();
      }
    } finally {
      interceptor.uninstall();
      globalThis.fetch = nativeFetch;
    }
  });
});

describe("Route decision cache", () => {
  function countingRules(): { rules: ProxyRules; reads: () => number } {
    let reads = 0;
    const rules = {
      get direct() {
        reads++;
        return [] as string[];
      },
      get proxy() {
        reads++;
        return [] as string[];
      },
    } as unknown as ProxyRules;
    return { rules, reads: () => reads };
  }

  test("caches decisions in O(1) and reuses them without touching rules", () => {
    clearRouteCache();
    expect(getRouteCacheSize()).toBe(0);

    const { rules, reads } = countingRules();
    const first = shouldProxyHost("cache-probe.example.com", rules);
    const readsAfterFirst = reads();
    expect(first).toBe(true);
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(getRouteCacheSize()).toBe(1);

    // Cache hit: no rule evaluation at all, same answer.
    for (let i = 0; i < 1000; i++) {
      expect(shouldProxyHost("cache-probe.example.com", rules)).toBe(first);
    }
    expect(reads()).toBe(readsAfterFirst);
    expect(getRouteCacheSize()).toBe(1);
  });

  test("caches direct decisions too and keeps loopback out of the cache", () => {
    clearRouteCache();
    const rules: ProxyRules = { direct: ["*.internal.example.com"], proxy: [] };

    expect(shouldProxyHost("svc.internal.example.com", rules)).toBe(false);
    expect(getRouteCacheSize()).toBe(1);
    for (let i = 0; i < 100; i++) {
      expect(shouldProxyHost("svc.internal.example.com", rules)).toBe(false);
    }
    expect(getRouteCacheSize()).toBe(1);

    expect(shouldProxyHost("localhost", rules)).toBe(false);
    expect(shouldProxyHost("127.0.0.1", rules)).toBe(false);
    expect(getRouteCacheSize()).toBe(1);
  });

  test("explicit proxy list narrows routing to matching hosts", () => {
    clearRouteCache();
    const rules: ProxyRules = { direct: [], proxy: ["*.openai.com"] };
    expect(shouldProxyHost("api.openai.com", rules)).toBe(true);
    expect(shouldProxyHost("example.org", rules)).toBe(false);
    clearRouteCache();
    expect(getRouteCacheSize()).toBe(0);
  });

  test("cache stays bounded under host churn", () => {
    clearRouteCache();
    const rules: ProxyRules = { direct: [], proxy: [] };
    for (let i = 0; i < 500; i++) {
      shouldProxyHost(`host-${i}.example.net`, rules);
    }
    expect(getRouteCacheSize()).toBeGreaterThan(0);
    expect(getRouteCacheSize()).toBeLessThanOrEqual(128);
    clearRouteCache();
  });

  test("cached lookup averaging well under 0.01ms per decision", () => {
    clearRouteCache();
    const rules: ProxyRules = { direct: [], proxy: [] };
    expect(shouldProxyHost("hot.example.com", rules)).toBe(true);

    const iterations = 100_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      shouldProxyHost("hot.example.com", rules);
    }
    const perCallMs = (performance.now() - start) / iterations;
    expect(perCallMs).toBeLessThan(0.01);
    clearRouteCache();
  });
});
