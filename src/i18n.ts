import type { SupportedLang } from "./types.js";

export type ResolvedLang = "zh" | "en";

export function resolveLanguage(preferred?: SupportedLang): ResolvedLang {
  if (preferred === "zh") return "zh";
  if (preferred === "en") return "en";

  // Auto-detection based on environment variables and system locale
  const envLang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  if (envLang.toLowerCase().includes("zh")) {
    return "zh";
  }

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.startsWith("zh")) {
      return "zh";
    }
  } catch {
    // fallback
  }

  return "zh"; // Default to Chinese in this environment if unresolved
}

const MESSAGES = {
  zh: {
    cmdDescription: "管理与配置免 TUN 代理 (状态/开关/地址/端口/测试/重置/语言)",
    subStatusDesc: "查看代理运行状态",
    subOnDesc: "开启代理",
    subOffDesc: "关闭代理并恢复直连",
    subSetDesc: "设置代理完整地址 (http://... 或 socks5://...)",
    subPortDesc: "单独修改代理端口 (保持当前地址/协议)",
    subTestDesc: "测试代理端点连通性与延迟",
    subResetDesc: "重置为默认配置 (127.0.0.1:7890, off)",
    subLangDesc: "切换提示语言 (zh / en / auto)",

    statusTitle: "omp-proxy-mumu 运行状态",
    statusState: "状态",
    statusTarget: "目标地址",
    statusChildEnv: "子进程环境变量注入",
    statusDirectRules: "直连白名单规则",
    statusProxyRules: "强制代理规则",
    statusLastProbe: "最近连通探测",
    statusLastError: "降级原因",
    stateActive: "已激活 (经代理转发)",
    stateDisabled: "已关闭 (原生直连)",
    stateUnconfigured: "未配置有效地址 (自动直连)",
    stateUnreachable: "目标不可达 (自动直连降级)",
    stateDegraded: "运行期降级 (代理协议不受支持，已回退原生直连)",
    probeSuccess: "正常",
    probeFailed: "失败",
    probeNever: "尚未探测",
    enabledText: "已开启",
    disabledText: "已关闭",
    itemCount: "条",

    onActive: "已开启代理，当前通过 {url} 转发流量 (延迟: {latency}ms)",
    onUnconfigured: "代理已开启，但尚未配置有效地址，自动保持原生直连",
    onUnreachable: "代理已开启，但目标 {url} 探测失败 ({error})，自动保持原生直连",
    envSanitized: "已清理无法使用的代理环境变量: {list}。Bun 内置 fetch 只支持 http/https 代理，socks 或格式错误的地址会让所有请求报 UnsupportedProxyProtocol。如需 socks 代理，请执行 /proxy set socks5://host:port 由插件内置桥接。",
    degradeProtocol: "代理被运行时拒绝 ({error})，已降级为原生直连。请改用 http(s) 代理端口，或执行 /proxy set socks5://host:port 让插件自动桥接。",
    degradeBridge: "SOCKS5 桥接启动失败 ({error})，已降级为原生直连。请执行 /proxy test 检查代理端点。",
    proxyFallback: "经代理 {url} 的请求失败 ({error})，已自动回退原生直连。请执行 /proxy test 检查代理。",
    bridgeFailure: "SOCKS5 桥接失败 (HTTP {status})",
    proxyAndDirectFailed: "代理 {url} 请求失败 ({error})，回退原生直连也失败 ({directError})。请检查代理软件与网络连接。",
    proxyBodyNotReplayable: "经代理 {url} 的请求失败 ({error})，该请求体不可重放，已直接报错以避免重复提交。",

    offSuccess: "已关闭代理，恢复原生直连，并已清理子进程代理环境变量",

    setSuccessActive: "已设置代理为 {url} 并成功连接 (延迟: {latency}ms)",
    setSuccessUnreachable: "已设置代理为 {url}，但目标不可达 ({error})，已自动降级为原生直连",
    setInvalid: "无效的代理地址。必须包含协议与端口，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:10808",

    portMissing: "请提供端口号，例如 /proxy port 7890",
    portInvalid: "无效的端口号。端口必须为 1-65535 之间的整数",
    portSuccessActive: "已设置代理端口为 {port} ({url}) 并成功连接 (延迟: {latency}ms)",
    portSuccessUnreachable: "已设置代理端口为 {port} ({url})，但目标不可达 ({error})，已自动降级为原生直连",

    testStart: "正在测试代理端点 {url} 连通性...",
    testSuccess: "代理端点 {url} 连通正常，TCP 往返延迟: {latency}ms",
    testFailed: "代理端点 {url} 无法连接: {error}",

    resetSuccess: "已重置代理配置为默认值 (http://127.0.0.1:7890, off)",

    langSuccess: "语言已切换为: {lang}",
    langInvalid: "无效的语言选项。可用选项: zh, en, auto",

    helpTitle: "[omp-proxy-mumu] 可用指令:",
    helpStatus: "• /proxy status       - 查看运行状态与分流规则",
    helpOn: "• /proxy on           - 开启代理",
    helpOff: "• /proxy off          - 关闭代理",
    helpSet: "• /proxy set <url>    - 设置完整代理地址",
    helpPort: "• /proxy port <port>  - 单独设置代理端口",
    helpTest: "• /proxy test         - 测试当前代理连通性",
    helpReset: "• /proxy reset        - 恢复默认配置 (127.0.0.1:7890, off)",
    helpLang: "• /proxy lang <zh|en|auto> - 切换语言",
  },
  en: {
    cmdDescription: "Manage zero-TUN transparent proxy (status/on/off/set/port/test/reset/lang)",
    subStatusDesc: "Show proxy runtime status",
    subOnDesc: "Enable proxy",
    subOffDesc: "Disable proxy and bypass",
    subSetDesc: "Set full proxy URL (http://... or socks5://...)",
    subPortDesc: "Set proxy port only (keeps current host/protocol)",
    subTestDesc: "Test proxy endpoint connectivity and latency",
    subResetDesc: "Reset to defaults (127.0.0.1:7890, off)",
    subLangDesc: "Switch language (zh / en / auto)",

    statusTitle: "omp-proxy-mumu Runtime Status",
    statusState: "State",
    statusTarget: "Target Endpoint",
    statusChildEnv: "Child Process Env Injection",
    statusDirectRules: "Direct Rules (Bypass)",
    statusProxyRules: "Force Proxy Rules",
    statusLastProbe: "Last Probe",
    statusLastError: "Downgrade Reason",
    stateActive: "ACTIVE (Routed via Proxy)",
    stateDisabled: "DISABLED (Native Direct)",
    stateUnconfigured: "UNCONFIGURED (Native Direct)",
    stateUnreachable: "UNREACHABLE (Native Direct Fallback)",
    stateDegraded: "DEGRADED (Proxy Protocol Unsupported, Native Direct)",
    probeSuccess: "OK",
    probeFailed: "FAILED",
    probeNever: "Not probed yet",
    enabledText: "Enabled",
    disabledText: "Disabled",
    itemCount: "rules",

    onActive: "Proxy enabled. Traffic routed via {url} (latency: {latency}ms)",
    onUnconfigured: "Proxy enabled but not configured with valid address; staying on native direct connection",
    onUnreachable: "Proxy enabled but probe to {url} failed ({error}); falling back to native direct connection",
    envSanitized: "Removed unusable proxy environment values: {list}. Bun's built-in fetch only supports http/https proxies; socks or malformed values make every request fail with UnsupportedProxyProtocol. For socks, run /proxy set socks5://host:port so the plugin bridges it.",
    degradeProtocol: "Runtime rejected the proxy ({error}); downgraded to native direct. Use an http(s) proxy port, or /proxy set socks5://host:port to let the plugin bridge socks.",
    degradeBridge: "SOCKS5 bridge failed to start ({error}); downgraded to native direct. Run /proxy test to check the endpoint.",
    proxyFallback: "Request via proxy {url} failed ({error}); fell back to native direct. Run /proxy test to check the proxy.",
    bridgeFailure: "SOCKS5 bridge failure (HTTP {status})",
    proxyAndDirectFailed: "Proxy {url} failed ({error}) and the native direct retry failed too ({directError}). Check the proxy app and the network.",
    proxyBodyNotReplayable: "Request via proxy {url} failed ({error}); the body is not replayable, so it was not retried to avoid duplicate submission.",

    offSuccess: "Proxy disabled. Native direct connection restored and child process env cleared.",

    setSuccessActive: "Proxy set to {url} and connected successfully (latency: {latency}ms)",
    setSuccessUnreachable: "Proxy set to {url}, but target is unreachable ({error}); direct connection active",
    setInvalid: "Invalid proxy URL. Must include scheme and port, e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:10808",

    portMissing: "Please specify a port number, e.g. /proxy port 7890",
    portInvalid: "Invalid port number. Port must be an integer between 1 and 65535",
    portSuccessActive: "Proxy port set to {port} ({url}) and connected successfully (latency: {latency}ms)",
    portSuccessUnreachable: "Proxy port set to {port} ({url}), but target is unreachable ({error}); direct connection active",

    testStart: "Testing connectivity to proxy endpoint {url}...",
    testSuccess: "Proxy endpoint {url} connected. TCP round-trip latency: {latency}ms",
    testFailed: "Proxy endpoint {url} failed to connect: {error}",

    resetSuccess: "Proxy configuration reset to defaults (http://127.0.0.1:7890, off)",

    langSuccess: "Language switched to: {lang}",
    langInvalid: "Invalid language. Available options: zh, en, auto",

    helpTitle: "[omp-proxy-mumu] Available commands:",
    helpStatus: "• /proxy status       - Show runtime status & routing rules",
    helpOn: "• /proxy on           - Enable proxy",
    helpOff: "• /proxy off          - Disable proxy",
    helpSet: "• /proxy set <url>    - Set full proxy URL",
    helpPort: "• /proxy port <port>  - Set proxy port only",
    helpTest: "• /proxy test         - Test endpoint connectivity",
    helpReset: "• /proxy reset        - Reset configuration to defaults (127.0.0.1:7890, off)",
    helpLang: "• /proxy lang <zh|en|auto> - Switch language",
  },
} as const;

export type TranslationKey = keyof typeof MESSAGES.zh;

export function t(lang: ResolvedLang, key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = MESSAGES[lang] || MESSAGES.zh;
  let text: string = dict[key] || MESSAGES.zh[key] || String(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
