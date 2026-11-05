# Changelog

## 0.2.2

- 修复：增加对 `PI_PROXY` / `pi_proxy` 环境变量的同步注入与清理。Oh My Pi 核心体系（如 Anthropic `coworkFetch` 及 `transportFetch`）仅认 `PI_PROXY`；此前漏设导致 Anthropic 强制通过原生 `https.request` 裸连直连，完全绕过代理插件。
- 修复：关闭默认失败回退直连（`directFallback: false`）。此前代理请求稍有超时即自动回退直连，导致真实国内 IP 直连 Google/OpenAI，引发 Google 400（`User location is not supported for the API use`）及双重超时。现默认失败直接报错，不向受限区域裸连。
- 修复：调用方信号已中止（`signal.aborted`，如 prewarm 或客户端提前超时）时，直接抛出异常，不再执行无意义的直连重试。
- 优化：探测默认超时时间由 800ms 调整为 1500ms，降低本地高负载时的误判不可达率。

## 0.2.1

- 修复：环境里残留 socks 或格式错误的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 会让 Bun `fetch` 对所有请求抛 `UnsupportedProxyProtocol`（“Retry failed after 1 attempts”）。插件安装 Hook 时快照并清理这类值，会话开始时告警一次，卸载或关闭时只恢复可用的原值。
- 修复：直连路径（loopback、直连规则、回退重试）改用 `proxy: false`，注入的子进程代理变量不再把直连请求也送进代理。
- 新增：`degraded` 运行状态。代理协议被 Bun 拒绝或 SOCKS5 桥无法启动时，停止代理、清理注入变量，并在 `/proxy status` 显示降级原因。
- 新增：单次代理请求失败会告警一次并立即回退原生直连；两者都失败时抛出同时包含代理与直连原因的错误。请求体不可重放（流式 body / `Request`）时不重试，避免重复提交。
- 修复：SOCKS5 桥现在同时转发 `CONNECT`（HTTPS）与明文 HTTP 绝对 URI（此前明文请求会收到 405 文本并被当作正常响应）；桥失败时返回 `x-omp-proxy-error` 标记，由插件识别并回退。
- 修复：代理地址规范化统一走 `URL` 解析，避免拼出 `http:://host:port` 这类非法值；IPv6 端点保留括号。
- 新增测试：环境变量自愈、SOCKS5 桥明文/CONNECT 转发、桥失败标记。

## 0.2.0

- 新增 i18n：内置简体中文与英文提示，`/proxy lang <zh|en|auto>` 即时切换，`auto` 跟随系统 locale。
- 新增 `/proxy port <port>`：仅替换端口，保留当前协议与主机。
- 新增状态栏指示：代理激活时显示 `● PROXY ON`，关闭或降级直连时自动清除。
- 默认配置改为 `enabled = false` + `http://127.0.0.1:7890`（默认关闭、默认 localhost、默认端口 7890）。
- 探测错误信息改为语言中立文本，由 i18n 层负责本地化。
- 宿主基线对齐 Oh My Pi 18.16.0；`peerDependencies` 仍为 `>=18.0.4 <19`。

## 0.1.0

- 首个版本：免 TUN 的 `fetch` 透明代理、失败安全自动回退、HTTP / SOCKS5 支持、规则分流、子进程代理环境变量注入。
