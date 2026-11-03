# Changelog

## 0.2.0

- 新增 i18n：内置简体中文与英文提示，`/proxy lang <zh|en|auto>` 即时切换，`auto` 跟随系统 locale。
- 新增 `/proxy port <port>`：仅替换端口，保留当前协议与主机。
- 新增状态栏指示：代理激活时显示 `● PROXY ON`，关闭或降级直连时自动清除。
- 默认配置改为 `enabled = false` + `http://127.0.0.1:7890`（默认关闭、默认 localhost、默认端口 7890）。
- 探测错误信息改为语言中立文本，由 i18n 层负责本地化。
- 宿主基线对齐 Oh My Pi 18.16.0；`peerDependencies` 仍为 `>=18.0.4 <19`。

## 0.1.0

- 首个版本：免 TUN 的 `fetch` 透明代理、失败安全自动回退、HTTP / SOCKS5 支持、规则分流、子进程代理环境变量注入。
