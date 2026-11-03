import { describe, expect, test } from "bun:test";
import { resolveLanguage, t } from "../src/i18n.js";

describe("i18n Module", () => {
  test("resolveLanguage respects explicit preference", () => {
    expect(resolveLanguage("zh")).toBe("zh");
    expect(resolveLanguage("en")).toBe("en");
  });

  test("t returns correct translation for zh and en", () => {
    expect(t("zh", "stateActive")).toContain("已激活");
    expect(t("en", "stateActive")).toContain("ACTIVE");

    expect(t("zh", "offSuccess")).toContain("已关闭代理");
    expect(t("en", "offSuccess")).toContain("Proxy disabled");
  });

  test("t formats parameters properly", () => {
    const zhMsg = t("zh", "onActive", { url: "http://127.0.0.1:7890", latency: 5 });
    expect(zhMsg).toContain("http://127.0.0.1:7890");
    expect(zhMsg).toContain("5ms");

    const enMsg = t("en", "portSuccessActive", { port: 8080, url: "http://127.0.0.1:8080", latency: 12 });
    expect(enMsg).toContain("8080");
    expect(enMsg).toContain("http://127.0.0.1:8080");
    expect(enMsg).toContain("12ms");
  });
});
