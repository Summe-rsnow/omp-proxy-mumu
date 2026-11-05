import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, isConfigured, parseProxyUrl, updateUrlPort } from "../src/config.js";

describe("Proxy Config & Gate Rules", () => {
  test("DEFAULT_CONFIG must default to off, localhost, port 7890", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CONFIG.url).toBe("http://127.0.0.1:7890");
    expect(DEFAULT_CONFIG.lang).toBe("auto");
    expect(DEFAULT_CONFIG.rules.direct.length).toBe(0);
    expect(DEFAULT_CONFIG.rules.proxy.length).toBe(0);
    expect(DEFAULT_CONFIG.probeTimeoutMs).toBe(1500);
    expect(DEFAULT_CONFIG.directFallback).toBe(false);
    expect(isConfigured(DEFAULT_CONFIG)).toBe(true);
  });

  test("isConfigured must return false for empty or invalid urls", () => {
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "" })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "   " })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "invalid" })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "http://localhost" })).toBe(false);
  });

  test("isConfigured must return true for valid HTTP or SOCKS5 URLs", () => {
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "http://127.0.0.1:7890" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "socks5://127.0.0.1:10808" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "127.0.0.1:7890" })).toBe(true);
  });

  test("parseProxyUrl parses protocols, host and port correctly", () => {
    expect(parseProxyUrl("http://127.0.0.1:7890")).toEqual({
      protocol: "http:",
      host: "127.0.0.1",
      port: 7890,
    });
    expect(parseProxyUrl("socks5://localhost:10808")).toEqual({
      protocol: "socks5:",
      host: "localhost",
      port: 10808,
    });
  });

  test("updateUrlPort modifies port while retaining protocol and host", () => {
    expect(updateUrlPort("http://127.0.0.1:7890", 10808)).toBe("http://127.0.0.1:10808");
    expect(updateUrlPort("socks5://localhost:10808", 7890)).toBe("socks5://localhost:7890");
    expect(updateUrlPort("", 7890)).toBe("http://127.0.0.1:7890");
    expect(updateUrlPort("invalid", 8080)).toBe("http://127.0.0.1:8080");
  });
});
