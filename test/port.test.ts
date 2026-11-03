import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, updateUrlPort } from "../src/config.js";
import { ProxyInterceptor } from "../src/interceptor.js";

describe("Port Configuration & State Listeners", () => {
  test("updateUrlPort changes only port", () => {
    expect(updateUrlPort("http://127.0.0.1:7890", 10808)).toBe("http://127.0.0.1:10808");
    expect(updateUrlPort("socks5://127.0.0.1:7890", 9090)).toBe("socks5://127.0.0.1:9090");
    expect(updateUrlPort("http://localhost:8000", 7890)).toBe("http://localhost:7890");
  });

  test("onStatusChange notifies subscribers when proxy state changes", async () => {
    const interceptor = new ProxyInterceptor(DEFAULT_CONFIG);
    const states: string[] = [];

    const unsubscribe = interceptor.onStatusChange((status) => {
      states.push(status.state);
    });

    await interceptor.updateConfigAndApply({
      ...DEFAULT_CONFIG,
      enabled: false,
    });
    expect(states).toContain("disabled");

    await interceptor.updateConfigAndApply({
      ...DEFAULT_CONFIG,
      enabled: true,
      url: "",
    });
    expect(states).toContain("unconfigured");

    unsubscribe();
  });
});
