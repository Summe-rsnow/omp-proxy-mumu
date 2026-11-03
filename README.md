# omp-proxy-mumu

为 [Oh My Pi](https://github.com/can1357/oh-my-pi) 提供**免 TUN 的透明 AI 网络代理**。插件直接在 OMP 宿主进程内接管网络请求，不改系统代理、不注入 DLL、不需要管理员权限；代理未配置或目标不可达时自动回退原生直连。

- 当前版本：`0.2.0`
- 宿主兼容：Oh My Pi `>=18.0.4 <19`（当前验证 `18.16.0`）
- 运行时：Bun `>=1.3.0`
- 默认状态：**关闭（off）、`http://127.0.0.1:7890`、零规则**
- 开源许可：GPL-3.0

## 核心特性

| 特性 | 说明 |
| --- | --- |
| **开箱可用，默认关闭** | 默认地址 `http://127.0.0.1:7890`，但不写任何分流规则；`enabled = false` 时永远不会代理流量。 |
| **失败安全自动回退** | 开关已打开但地址无效，或 TCP 探测失败时，状态标记为 `unconfigured` / `unreachable`，流量自动走原生直连（OFF）。 |
| **HTTP 与 SOCKS5** | 支持 `http://` 代理直通，也支持 `socks5://`；SOCKS5 由内置的本地 HTTP CONNECT 桥按需转换。 |
| **极致性能** | 关闭状态下仅一次布尔判断即返回原生 `fetch`；路由决策 O(1) 缓存；SOCKS5 桥懒启动；探测结果短 TTL 缓存。 |
| **规则分流** | 支持直连白名单与强制代理列表，支持 `*.example.com` 通配；loopback 永不代理。 |
| **子进程代理注入** | 激活时向工具派生的子进程注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写形式），关闭时同步清理。 |
| **多语言** | 内置简体中文与英文两套提示；支持 `/proxy lang zh|en|auto` 即时切换，`auto` 跟随系统 locale。 |
| **状态栏指示** | 代理激活时在 OMP 状态栏显示 `● PROXY ON`，关闭或降级直连时自动清除。 |
| **无遥测** | 除代理转发与本地 TCP 探测外，不发起额外网络请求，不上报任何配置或使用数据。 |

## 工作原理

```text
/proxy set <url>
        │
        ▼
  配置持久化 ──► TCP 连通性探测 ──┬── 失败 ──► OFF：全部原生直连
        │                        └── 成功 ──► ACTIVE
        ▼
globalThis.fetch(input, init)
        │
        ├─ 代理未激活 ──────────────────► 原生 fetch（零额外开销）
        │
        └─ 提取 hostname
                ├─ loopback / 直连规则 ─► 原生 fetch
                └─ 需要代理
                        ├─ http://  ──► 直接作为 fetch proxy
                        └─ socks5:// ─► 懒启动本地 CONNECT 桥
                        │
                        ▼
                代理请求失败 ─────────► 自动重试原生直连
```

插件只影响当前 Oh My Pi 进程内的 `fetch` 调用，以及通过工具派生的子进程环境变量；它不创建虚拟网卡，也不接管操作系统或其他应用的流量。

## 安装

### 方式一：写入插件依赖（推荐，与 `omp-settings-zh-mumu` 一致）

编辑 `~/.omp/plugins/package.json`（Windows 为 `C:\Users\<用户名>\.omp\plugins\package.json`），加入依赖：

```json
{
  "name": "omp-plugins",
  "private": true,
  "dependencies": {
    "omp-proxy-mumu": "github:Summe-rsnow/omp-proxy-mumu"
  }
}
```

在插件目录安装依赖：

```sh
cd ~/.omp/plugins
bun install
```

### 方式二：使用 OMP 插件命令

```sh
omp plugin install github:Summe-rsnow/omp-proxy-mumu
```

该命令会自动写入依赖并完成安装。

### 启用插件

1. 完全退出并重新启动 Oh My Pi。
2. 运行 `omp plugin list`，确认列表中出现 `omp-proxy-mumu`。
3. 在 OMP 会话中输入 `/proxy status`，确认插件已加载。

插件通过 `package.json` 中的 `omp.extensions` 字段加载 `./src/index.ts`，无需预先编译。

## `/proxy` 命令

| 命令 | 作用 |
| --- | --- |
| `/proxy` 或 `/proxy status` | 查看开关、代理目标、运行状态、子进程注入状态与规则数量。 |
| `/proxy set <url>` | 设置并规范化代理地址，写入配置，自动开启并立即探测。 |
| `/proxy port <port>` | 仅替换端口，保留当前协议与主机，例如 `/proxy port 10808`。 |
| `/proxy on` | 打开开关；若未配置或探测失败，仍保持直连并给出警告。 |
| `/proxy off` | 关闭代理，恢复完全原生直连，并清理子进程代理变量。 |
| `/proxy test` | 对当前代理端点做 TCP 连通性与延迟测试。 |
| `/proxy reset` | 恢复默认配置：`http://127.0.0.1:7890`，`enabled = false`，规则清空。 |
| `/proxy lang <zh\|en\|auto>` | 切换提示语言；`auto` 按环境 locale 自动判定。 |

地址必须包含显式端口；省略协议时按 `http://` 处理。

常见示例：

```text
/proxy port 7890
/proxy set http://127.0.0.1:7890
/proxy set socks5://127.0.0.1:10808
/proxy test
/proxy status
```

> 默认端口为 `7890`（Clash 常用），只作为初始值存在；插件不会主动探测或猜测本机代理软件。

### 状态说明

| 状态 | 触发条件 | 实际流量 |
| --- | --- | --- |
| `active` | 已开启 + 地址有效 + 探测成功 | 经配置的代理转发 |
| `disabled` | `enabled = false` | 原生直连 |
| `unconfigured` | 已开启，但地址为空或缺少有效 host/port | 自动直连 |
| `unreachable` | 已开启且地址有效，但 TCP 探测失败 | 自动直连 |

## 配置文件

配置保存在：

```text
~/.omp/agent/proxy-config.json
```

完整结构：

```json
{
  "enabled": false,
  "url": "http://127.0.0.1:7890",
  "injectChildEnv": true,
  "probeTimeoutMs": 800,
  "lang": "auto",
  "rules": {
    "direct": [],
    "proxy": []
  }
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。开启不等于生效，仍需地址有效且探测成功。 |
| `url` | `"http://127.0.0.1:7890"` | 代理地址，例如 `http://127.0.0.1:7890`、`socks5://127.0.0.1:10808`。 |
| `injectChildEnv` | `true` | 激活时是否向子进程注入代理环境变量。 |
| `probeTimeoutMs` | `800` | TCP 探测超时，单位毫秒。 |
| `lang` | `"auto"` | 提示语言：`"zh"`、`"en"` 或 `"auto"`（跟随系统 locale）。 |
| `rules.direct` | `[]` | 直连白名单。命中后即使位于代理列表也不代理。 |
| `rules.proxy` | `[]` | 强制代理列表。非空时，未命中的域名改为直连。 |

规则匹配支持精确域名与 `*.` 通配：

```json
{
  "rules": {
    "direct": ["*.internal.example.com"],
    "proxy": ["api.openai.com", "*.anthropic.com"]
  }
}
```

规则优先级：

1. `localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0` 永远直连。
2. `direct` 命中 → 直连。
3. `proxy` 非空时，只有命中项才代理；为空时，其余所有公网域名都代理。
4. 决策结果写入 O(1) 路由缓存，配置变更时清空。

配置文件在插件初始化时读取；手工修改后需要重启 OMP 才能生效。

## 性能设计

- **关闭即零成本**：Hook 不是 `async` 包装器；未激活时直接返回原生 `fetch` 的 Promise，不产生额外 Promise、微任务或分配。
- **O(1) 路由决策**：主机名到“代理/直连”的结果缓存在有界 `Map` 中（上限 128 条），配置变更时整体清空。
- **避免无谓分配**：主机名提取不使用正则；仅当字符串包含大写字母时才执行 `toLowerCase()`。
- **懒启动 SOCKS5 桥**：只有首次真正通过 SOCKS5 代理时才绑定本地端口；同一 endpoint 复用，关闭代理或卸载时停止。
- **探测节流**：普通探测结果缓存 3 秒；状态切换时强制重新探测，避免把过期结果当成健康状态。
- **流式转发**：SOCKS5 桥使用 `pipe` 双向转发，依赖原生背压，不做整包缓冲。

## 适用边界

- 仅接管 Oh My Pi 进程内的 `fetch`，以及其派生子进程的代理环境变量；不是系统级 VPN/代理。
- 不修改 Windows / macOS / Linux 的系统代理设置。
- 不进行 TLS 中间人解密；HTTPS 通过 `CONNECT` 隧道透传。
- 目前面向**无认证**的本地代理端点。SOCKS5 桥使用 no-auth 握手；带用户名密码的 URL 不会被保留，请使用本地免认证监听端口。
- 代理 URL 必须带端口，且只支持 `http://` 与 `socks5://` 语义。
- 规则只能通过配置文件维护，`/proxy` 命令暂不提供规则编辑子命令。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `/proxy status` 显示 `unconfigured` | 执行 `/proxy set <url>`，确认地址包含 host 与端口。 |
| 显示 `unreachable` | 确认本地代理软件已启动并监听对应端口；用 `/proxy test` 复测。 |
| 开启后仍直连 | 检查目标域名是否命中 `direct`，或 `proxy` 列表是否遗漏；loopback 始终直连。 |
| 插件未出现在 `omp plugin list` | 检查 `~/.omp/plugins/package.json` 依赖是否写入，重新执行 `bun install`，然后重启 OMP。 |
| 配置异常或想恢复初始状态 | 执行 `/proxy reset`，或删除 `~/.omp/agent/proxy-config.json` 后重启。 |

## 开发

```sh
# 安装依赖（首次）
bun install

# 运行单元测试
bun test

# 类型检查 + 测试
bun run check
```

测试覆盖默认配置与门禁、URL 解析、端口改写、i18n 文案、失败回退与 TCP 探测。目录结构：

```text
src/
├── index.ts        # Extension 入口、状态栏指示、会话生命周期
├── config.ts       # 默认配置、持久化、URL 解析、端口改写
├── types.ts        # 配置、状态与探测结果类型
├── i18n.ts         # 简体中文 / 英文文案与语言解析
├── probe.ts        # TCP 连通性探测
├── interceptor.ts  # fetch Hook、状态机、失败回退、环境变量注入
├── tunnel.ts       # 路由决策缓存与 HTTP→SOCKS5 桥
└── command.ts      # /proxy 斜杠命令
test/
├── config.test.ts
├── port.test.ts
├── i18n.test.ts
├── fallback.test.ts
├── probe.test.ts
└── perf.test.ts
```

## 许可证与致谢

本项目以 **GPL-3.0** 分发。

代理思路与行为参考自 [hcllmsx/proxy-aiapp](https://github.com/hcllmsx/proxy-aiapp)（Proxy-AiApp，GPL-3.0）；上游源码以只读快照保存在仓库外的 `../upstream/`，同步方式与许可证义务见其中的 `UPSTREAM.md`。

上游本身衍生自 [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy)，一并致谢。
