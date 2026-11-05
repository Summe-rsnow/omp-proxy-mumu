import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  applyProxyEnv,
  captureProxyEnv,
  PROXY_ENV_KEYS,
  resetProxyEnvState,
  restoreProxyEnv,
  sanitizeInheritedProxyEnv,
  toFetchProxyUrl,
} from "../src/env.js";
import { ProxyInterceptor } from "../src/interceptor.js";

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of PROXY_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetProxyEnvState();
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  resetProxyEnvState();
});

describe("toFetchProxyUrl", () => {
  test("canonicalizes http(s) URLs Bun's fetch accepts", () => {
    expect(toFetchProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(toFetchProxyUrl("HTTP://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890");
    expect(toFetchProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(toFetchProxyUrl("http://[::1]:7890")).toBe("http://[::1]:7890");
  });

  test("rejects socks and malformed values that make Bun throw UnsupportedProxyProtocol", () => {
    expect(toFetchProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(toFetchProxyUrl("socks4://127.0.0.1:1080")).toBeNull();
    // Real-world corruption: a scheme with a doubled colon.
    expect(toFetchProxyUrl("http:://127.0.0.1:7890")).toBeNull();
    expect(toFetchProxyUrl("http://127.0.0.1")).toBeNull();
  });
});

describe("inherited proxy env sanitation", () => {
  test("drops malformed and socks values, keeps http ones", () => {
    process.env.HTTP_PROXY = "http:://127.0.0.1:7890";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    process.env.PI_PROXY = "socks5://127.0.0.1:1080";

    const issues = sanitizeInheritedProxyEnv();

    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.ALL_PROXY).toBeUndefined();
    expect(process.env.PI_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(issues.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "ALL_PROXY", value: "socks5://127.0.0.1:1080", reason: "unsupported-scheme" },
      { key: "HTTP_PROXY", value: "http:://127.0.0.1:7890", reason: "malformed" },
      { key: "PI_PROXY", value: "socks5://127.0.0.1:1080", reason: "unsupported-scheme" },
    ]);
  });

  test("restore brings back only usable inherited values", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    captureProxyEnv();

    applyProxyEnv("http://127.0.0.1:8080");
    expect(process.env.https_proxy).toBe("http://127.0.0.1:8080");
    expect(process.env.PI_PROXY).toBe("http://127.0.0.1:8080");
    expect(process.env.pi_proxy).toBe("http://127.0.0.1:8080");

    restoreProxyEnv();
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.PI_PROXY).toBeUndefined();
    expect(process.env.ALL_PROXY).toBeUndefined();
  });

  test("install sanitizes the poisoned env and reports it", () => {
    process.env.HTTPS_PROXY = "http:://127.0.0.1:7890";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    const interceptor = new ProxyInterceptor(DEFAULT_CONFIG);

    try {
      interceptor.install();
      expect(process.env.HTTPS_PROXY).toBeUndefined();
      expect(process.env.ALL_PROXY).toBeUndefined();
      expect(interceptor.getEnvIssues().map((issue) => issue.key).sort()).toEqual([
        "ALL_PROXY",
        "HTTPS_PROXY",
      ]);
    } finally {
      interceptor.uninstall();
    }
  });

  test("disabling the proxy restores the user's own http proxy env", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const interceptor = new ProxyInterceptor(DEFAULT_CONFIG);
    interceptor.install();

    try {
      await interceptor.updateConfigAndApply({ ...DEFAULT_CONFIG, enabled: false });
      expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
      expect(process.env.ALL_PROXY).toBeUndefined();
    } finally {
      interceptor.uninstall();
    }
  });
});
