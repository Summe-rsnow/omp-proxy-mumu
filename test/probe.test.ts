import { describe, expect, test } from "bun:test";
import net from "node:net";
import { probeProxy } from "../src/probe.js";

describe("Proxy Health Probe", () => {
  test("probeProxy returns false when proxy port is closed", async () => {
    // Port 49151 is typically unused / closed
    const result = await probeProxy("http://127.0.0.1:49151", 200);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("probeProxy returns true when proxy port is open and listening", async () => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve(port);
    });

    const port = await promise;
    try {
      const result = await probeProxy(`http://127.0.0.1:${port}`, 500);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  test("probeProxy fails immediately on invalid url", async () => {
    const result = await probeProxy("", 200);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未配置");
  });
});
