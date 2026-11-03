import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, isConfigured, parseProxyUrl } from "../src/config.js";

describe("Proxy Config & Gate Rules", () => {
  test("DEFAULT_CONFIG must be zero-default and unconfigured", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CONFIG.url).toBe("");
    expect(DEFAULT_CONFIG.rules.direct.length).toBe(0);
    expect(DEFAULT_CONFIG.rules.proxy.length).toBe(0);
  });

  test("isConfigured must return false for empty or unconfigured urls", () => {
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, enabled: true, url: "" })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, enabled: true, url: "   " })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, enabled: true, url: "invalid" })).toBe(false);
  });

  test("isConfigured must return true for valid HTTP or SOCKS5 URLs", () => {
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "http://127.0.0.1:7890" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "socks5://127.0.0.1:10808" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_CONFIG, url: "127.0.0.1:7890" })).toBe(true);
  });

  test("parseProxyUrl parses protocols, host and port correctly", () => {
    expect(parseProxyUrl("http://127.0.0.1:7890")).toEqual({
      protocol: "http",
      host: "127.0.0.1",
      port: 7890,
    });
    expect(parseProxyUrl("socks5://localhost:10808")).toEqual({
      protocol: "socks5",
      host: "localhost",
      port: 10808,
    });
  });
});
