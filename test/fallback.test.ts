import { describe, expect, test } from "bun:test";
import { ProxyInterceptor } from "../src/interceptor.js";
import { DEFAULT_CONFIG } from "../src/config.js";

describe("Fail-Safe Automatic Fallback to OFF", () => {
  test("unconfigured state falls back to OFF path", async () => {
    const interceptor = new ProxyInterceptor(DEFAULT_CONFIG);
    const notifications: string[] = [];

    const status = await interceptor.updateConfigAndApply(
      { ...DEFAULT_CONFIG, enabled: true, url: "" },
      (msg) => notifications.push(msg),
    );

    expect(status.state).toBe("unconfigured");
    expect(notifications.some((n) => n.includes("尚未配置有效地址") || n.includes("not configured"))).toBe(true);
  });

  test("unreachable proxy falls back to OFF path automatically", async () => {
    const interceptor = new ProxyInterceptor(DEFAULT_CONFIG);
    const notifications: string[] = [];

    const status = await interceptor.updateConfigAndApply(
      { ...DEFAULT_CONFIG, enabled: true, url: "http://127.0.0.1:49150", probeTimeoutMs: 200 },
      (msg) => notifications.push(msg),
    );

    expect(status.state).toBe("unreachable");
    expect(notifications.some((n) => n.includes("自动保持原生直连") || n.includes("falling back"))).toBe(true);
  });

  test("directFallback: false throws error without direct fallback", async () => {
    const nativeFetch = globalThis.fetch;
    let directCalled = false;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit & { proxy?: string | false }) => {
      if (init?.proxy === false) {
        directCalled = true;
        return new Response("direct");
      }
      throw new Error("connection refused");
    }) as typeof fetch;

    const interceptor = new ProxyInterceptor({
      ...DEFAULT_CONFIG,
      directFallback: false,
      rules: { direct: [], proxy: [] },
    });
    interceptor.install();

    try {
      const harness = interceptor as unknown as { isActive: boolean; config: typeof DEFAULT_CONFIG };
      harness.isActive = true;
      harness.config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        url: "http://127.0.0.1:7890",
        directFallback: false,
      };

      await expect(
        globalThis.fetch("https://api.openai.com/v1/models"),
      ).rejects.toThrow("connection refused");

      expect(directCalled).toBe(false);
    } finally {
      interceptor.uninstall();
      globalThis.fetch = nativeFetch;
    }
  });

  test("directFallback: true retries with directInit", async () => {
    const nativeFetch = globalThis.fetch;
    let directCalled = false;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit & { proxy?: string | false }) => {
      if (init?.proxy === false) {
        directCalled = true;
        return new Response("direct ok");
      }
      throw new Error("proxy error");
    }) as typeof fetch;

    const interceptor = new ProxyInterceptor({
      ...DEFAULT_CONFIG,
      directFallback: true,
      rules: { direct: [], proxy: [] },
    });
    interceptor.install();

    try {
      const harness = interceptor as unknown as { isActive: boolean; config: typeof DEFAULT_CONFIG };
      harness.isActive = true;
      harness.config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        url: "http://127.0.0.1:7890",
        directFallback: true,
      };

      const res = await globalThis.fetch("https://api.openai.com/v1/models");
      expect(await res.text()).toBe("direct ok");
      expect(directCalled).toBe(true);
    } finally {
      interceptor.uninstall();
      globalThis.fetch = nativeFetch;
    }
  });

  test("aborted signal rethrows without attempting direct fallback even if directFallback is true", async () => {
    const nativeFetch = globalThis.fetch;
    let directCalled = false;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit & { proxy?: string | false }) => {
      if (init?.proxy === false) {
        directCalled = true;
        return new Response("direct ok");
      }
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;

    const interceptor = new ProxyInterceptor({
      ...DEFAULT_CONFIG,
      directFallback: true,
      rules: { direct: [], proxy: [] },
    });
    interceptor.install();

    try {
      const harness = interceptor as unknown as { isActive: boolean; config: typeof DEFAULT_CONFIG };
      harness.isActive = true;
      harness.config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        url: "http://127.0.0.1:7890",
        directFallback: true,
      };

      const controller = new AbortController();
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

      await expect(
        globalThis.fetch("https://api.openai.com/v1/models", { signal: controller.signal }),
      ).rejects.toThrow("The operation timed out.");

      expect(directCalled).toBe(false);
    } finally {
      interceptor.uninstall();
      globalThis.fetch = nativeFetch;
    }
  });
});
