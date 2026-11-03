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
});
