import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, isConfigured, parseProxyUrl, saveConfig } from "./config.js";
import { probeProxy } from "./probe.js";
import type { ProxyInterceptor } from "./interceptor.js";

export function registerProxyCommand(pi: ExtensionAPI, interceptor: ProxyInterceptor): void {
  pi.registerCommand("proxy", {
    description: "管理与配置免 TUN 代理 (状态/开关/地址/测试/重置)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { value: "status", label: "status", description: "查看当前代理状态与连通性" },
        { value: "on", label: "on", description: "开启代理 (若未配置或连不通则自动保持直连)" },
        { value: "off", label: "off", description: "关闭代理 (完全原生直连)" },
        { value: "set ", label: "set <url>", description: "设置代理地址 (如 http://127.0.0.1:7890 或 socks5://127.0.0.1:10808)" },
        { value: "test", label: "test", description: "测试当前代理连通性与响应延迟" },
        { value: "reset", label: "reset", description: "重置为纯净无预设状态 (清空配置)" },
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

      if (sub === "status" || sub === "") {
        const status = interceptor.getStatus();
        const cfg = interceptor.getConfig();
        const configured = isConfigured(cfg);

        let stateText = "未知";
        if (status.state === "active") {
          stateText = `已启用 (Active) - 延迟: ${status.lastCheck?.latencyMs ?? 0}ms`;
        } else if (status.state === "unconfigured") {
          stateText = "未配置 (Unconfigured) - 自动走直连 OFF 路径";
        } else if (status.state === "unreachable") {
          stateText = `不可达 (Unreachable) - 自动走直连 OFF 路径 (${status.lastCheck?.error ?? "连接失败"})`;
        } else {
          stateText = "已停用 (Disabled) - 直连";
        }

        const lines = [
          "━━━━━━━━━━━━━━━ [omp-proxy 状态] ━━━━━━━━━━━━━━━",
          `• 开关状态: ${cfg.enabled ? "ON (开)" : "OFF (关)"}`,
          `• 代理目标: ${configured ? cfg.url : "(未配置，纯净状态)"}`,
          `• 运行模式: ${stateText}`,
          `• 终端子进程注入: ${cfg.injectChildEnv ? "已启用" : "未启用"}`,
          `• 直连规则数: ${cfg.rules.direct.length}，强制代理规则数: ${cfg.rules.proxy.length}`,
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "常用指令: /proxy set <url> | /proxy on | /proxy off | /proxy test | /proxy reset",
        ];

        notify(lines.join("\n"), status.state === "active" ? "info" : "warning");
        return;
      }

      if (sub === "on") {
        const currentCfg = interceptor.getConfig();
        currentCfg.enabled = true;
        saveConfig(currentCfg);

        const newStatus = await interceptor.updateConfigAndApply(currentCfg, notify);
        if (newStatus.state !== "active") {
          notify("[omp-proxy] 代理已标记为开启，但由于未配置或连通失败，已自动保持直连 (OFF) 模式。", "warning");
        }
        return;
      }

      if (sub === "off") {
        const currentCfg = interceptor.getConfig();
        currentCfg.enabled = false;
        saveConfig(currentCfg);

        await interceptor.updateConfigAndApply(currentCfg, notify);
        notify("[omp-proxy] 代理已关闭，已切入完全原生直连模式。", "info");
        return;
      }

      if (sub === "set") {
        const rawUrl = parts.slice(1).join(" ").trim();
        if (!rawUrl) {
          notify("[omp-proxy] 请提供代理地址，示例: /proxy set http://127.0.0.1:7890 或 /proxy set socks5://127.0.0.1:10808", "warning");
          return;
        }

        const parsed = parseProxyUrl(rawUrl);
        if (!parsed) {
          notify(`[omp-proxy] 无效的代理格式: "${rawUrl}"。请提供协议和端口，如 http://127.0.0.1:7890`, "error");
          return;
        }

        const currentCfg = interceptor.getConfig();
        currentCfg.url = `${parsed.protocol}://${parsed.host}:${parsed.port}`;
        currentCfg.enabled = true;
        saveConfig(currentCfg);

        notify(`[omp-proxy] 代理地址已更新为 ${currentCfg.url}，正在测试连通性...`, "info");
        await interceptor.updateConfigAndApply(currentCfg, notify);
        return;
      }

      if (sub === "test") {
        const currentCfg = interceptor.getConfig();
        if (!isConfigured(currentCfg)) {
          notify("[omp-proxy] 当前未配置代理地址，无法测试。请先使用 /proxy set <url> 设置。", "warning");
          return;
        }

        notify(`[omp-proxy] 正在探测目标代理 ${currentCfg.url} ...`, "info");
        const res = await probeProxy(currentCfg.url, currentCfg.probeTimeoutMs);
        if (res.ok) {
          notify(`[omp-proxy] 探测成功！响应延迟: ${res.latencyMs}ms。代理工作正常。`, "info");
        } else {
          notify(`[omp-proxy] 探测失败！错误: ${res.error}。系统将继续走直连 (OFF) 路径。`, "error");
        }
        return;
      }

      if (sub === "reset") {
        const cleanConfig = { ...DEFAULT_CONFIG, rules: { direct: [], proxy: [] } };
        saveConfig(cleanConfig);
        await interceptor.updateConfigAndApply(cleanConfig, notify);
        notify("[omp-proxy] 配置已清空重置为初始纯净状态 (留白未配置，自动直连)。", "info");
        return;
      }

      notify(
        "[omp-proxy] 未知子指令。可用指令:\n" +
          "• /proxy status  - 查看状态\n" +
          "• /proxy on      - 开启代理\n" +
          "• /proxy off     - 关闭代理\n" +
          "• /proxy set <url> - 设置代理地址\n" +
          "• /proxy test    - 测试连通性\n" +
          "• /proxy reset   - 重置清空配置",
        "warning",
      );
    },
  });
}
