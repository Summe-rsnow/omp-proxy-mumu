import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, isConfigured, parseProxyUrl, saveConfig, updateUrlPort } from "./config.js";
import { resolveLanguage, t } from "./i18n.js";
import { probeProxy } from "./probe.js";
import type { ProxyInterceptor } from "./interceptor.js";

export function registerProxyCommand(pi: ExtensionAPI, interceptor: ProxyInterceptor): void {
  pi.registerCommand("proxy", {
    description: "管理与配置免 TUN 代理 (状态/开关/地址/端口/测试/重置/语言)",
    getArgumentCompletions: (prefix: string) => {
      const lang = resolveLanguage(interceptor.getConfig().lang);
      const subcommands = [
        { value: "status", label: "status", description: t(lang, "subStatusDesc") },
        { value: "on", label: "on", description: t(lang, "subOnDesc") },
        { value: "off", label: "off", description: t(lang, "subOffDesc") },
        { value: "set ", label: "set <url>", description: t(lang, "subSetDesc") },
        { value: "port ", label: "port <port>", description: t(lang, "subPortDesc") },
        { value: "test", label: "test", description: t(lang, "subTestDesc") },
        { value: "reset", label: "reset", description: t(lang, "subResetDesc") },
        { value: "lang ", label: "lang <zh|en|auto>", description: t(lang, "subLangDesc") },
      ];
      const p = prefix.trim().toLowerCase();
      if (!p) return subcommands;
      return subcommands.filter((cmd) => cmd.value.toLowerCase().startsWith(p));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || "status").toLowerCase();
      const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
        ctx.ui?.notify(msg, level);
      };

      const lang = resolveLanguage(interceptor.getConfig().lang);

      if (sub === "status" || sub === "") {
        const status = interceptor.getStatus();
        const cfg = interceptor.getConfig();
        const configured = isConfigured(cfg);

        let stateText = t(lang, "stateDisabled");
        if (status.state === "active") {
          stateText = `${t(lang, "stateActive")} (${status.lastCheck?.latencyMs ?? 0}ms)`;
        } else if (status.state === "unconfigured") {
          stateText = t(lang, "stateUnconfigured");
        } else if (status.state === "unreachable") {
          stateText = `${t(lang, "stateUnreachable")} (${status.lastCheck?.error ?? "failed"})`;
        } else if (status.state === "degraded") {
          stateText = t(lang, "stateDegraded");
        }

        const lines = [
          `━━━━━━━━━━━━━━━ [${t(lang, "statusTitle")}] ━━━━━━━━━━━━━━━`,
          `• ${t(lang, "statusState")}: ${stateText}`,
          ...(status.state === "degraded" && status.lastError
            ? [`• ${t(lang, "statusLastError")}: ${status.lastError}`]
            : []),
          `• ${t(lang, "statusTarget")}: ${configured ? cfg.url : "http://127.0.0.1:7890"}`,
          `• ${t(lang, "statusChildEnv")}: ${cfg.injectChildEnv ? t(lang, "enabledText") : t(lang, "disabledText")}`,
          `• ${t(lang, "statusDirectRules")}: ${cfg.rules.direct.length} ${t(lang, "itemCount")}`,
          `• ${t(lang, "statusProxyRules")}: ${cfg.rules.proxy.length} ${t(lang, "itemCount")}`,
          `• ${t(lang, "statusDirectFallback")}: ${cfg.directFallback ? t(lang, "enabledText") : t(lang, "disabledText")}`,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "• /proxy on | /proxy off | /proxy port <port> | /proxy set <url> | /proxy test",
        ];

        notify(lines.join("\n"), status.state === "active" ? "info" : "warning");
        return;
      }

      if (sub === "on") {
        const currentCfg = interceptor.getConfig();
        currentCfg.enabled = true;
        saveConfig(currentCfg);
        await interceptor.updateConfigAndApply(currentCfg, notify);
        return;
      }

      if (sub === "off") {
        const currentCfg = interceptor.getConfig();
        currentCfg.enabled = false;
        saveConfig(currentCfg);
        await interceptor.updateConfigAndApply(currentCfg);
        notify(`[omp-proxy-mumu] ${t(lang, "offSuccess")}`, "info");
        return;
      }

      if (sub === "set") {
        const rawTarget = parts.slice(1).join(" ").trim();
        if (!rawTarget) {
          notify(`[omp-proxy-mumu] ${t(lang, "setInvalid")}`, "error");
          return;
        }

        const parsed = parseProxyUrl(rawTarget);
        if (!parsed) {
          notify(`[omp-proxy-mumu] ${t(lang, "setInvalid")}`, "error");
          return;
        }

        const normalizedUrl = `${parsed.protocol}//${parsed.host}:${parsed.port}`;
        const newCfg = interceptor.getConfig();
        newCfg.url = normalizedUrl;
        newCfg.enabled = true;

        saveConfig(newCfg);
        await interceptor.updateConfigAndApply(newCfg, notify);
        return;
      }

      if (sub === "port") {
        const portStr = parts[1];
        if (!portStr) {
          notify(`[omp-proxy-mumu] ${t(lang, "portMissing")}`, "error");
          return;
        }

        const portNum = Number.parseInt(portStr, 10);
        if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
          notify(`[omp-proxy-mumu] ${t(lang, "portInvalid")}`, "error");
          return;
        }

        const newCfg = interceptor.getConfig();
        newCfg.url = updateUrlPort(newCfg.url, portNum);
        newCfg.enabled = true;

        saveConfig(newCfg);
        await interceptor.updateConfigAndApply(newCfg, notify);
        return;
      }

      if (sub === "test") {
        const cfg = interceptor.getConfig();
        if (!cfg.url) {
          notify(`[omp-proxy-mumu] ${t(lang, "onUnconfigured")}`, "warning");
          return;
        }

        notify(`[omp-proxy-mumu] ${t(lang, "testStart", { url: cfg.url })}`, "info");
        const res = await probeProxy(cfg.url, cfg.probeTimeoutMs, true);
        if (res.ok) {
          notify(`[omp-proxy-mumu] ${t(lang, "testSuccess", { url: cfg.url, latency: res.latencyMs })}`, "info");
        } else {
          notify(`[omp-proxy-mumu] ${t(lang, "testFailed", { url: cfg.url, error: res.error || "failed" })}`, "error");
        }
        return;
      }

      if (sub === "reset") {
        const resetCfg = {
          ...DEFAULT_CONFIG,
          rules: { direct: [], proxy: [] },
        };
        saveConfig(resetCfg);
        await interceptor.updateConfigAndApply(resetCfg);
        notify(`[omp-proxy-mumu] ${t(lang, "resetSuccess")}`, "info");
        return;
      }

      if (sub === "lang") {
        const targetLang = parts[1]?.toLowerCase();
        if (targetLang !== "zh" && targetLang !== "en" && targetLang !== "auto") {
          notify(`[omp-proxy-mumu] ${t(lang, "langInvalid")}`, "error");
          return;
        }

        const cfg = interceptor.getConfig();
        cfg.lang = targetLang;
        saveConfig(cfg);
        await interceptor.updateConfigAndApply(cfg);
        const resolved = resolveLanguage(targetLang);
        notify(`[omp-proxy-mumu] ${t(resolved, "langSuccess", { lang: targetLang })}`, "info");
        return;
      }

      notify(
        `${t(lang, "helpTitle")}\n` +
          `${t(lang, "helpStatus")}\n` +
          `${t(lang, "helpOn")}\n` +
          `${t(lang, "helpOff")}\n` +
          `${t(lang, "helpSet")}\n` +
          `${t(lang, "helpPort")}\n` +
          `${t(lang, "helpTest")}\n` +
          `${t(lang, "helpReset")}\n` +
          `${t(lang, "helpLang")}`,
        "warning",
      );
    },
  });
}
