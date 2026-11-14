# pi-cpa-usage

通用的 CPA / CLIProxyAPI OAuth 5 小时（5h）与每周（Weekly）额度查看扩展，支持 `/usage` 交互式浮层与可选的状态栏紧凑摘要联动。

## 特性

- **按需实时刷新**：每次执行 `/usage` 打开面板都会绕过缓存强制向 CPA 服务器发起实时额度查询。
- **零耦合状态栏联动（默认关闭）**：通过 `ctx.ui.setStatus("cpa-usage", ...)` 推送状态，配合 `statusline-pi` 自动显示；默认关闭，随时可用 `/usage statusline on|off` 或在面板中按 `p` 灵活开关。关闭状态下无任何后台轮询请求。
- **通用多服务器 / 多 OAuth**：
  - 仅依赖 CPA 标准管理接口 `GET /v0/management/auth-files` 与 `POST /v0/management/api-call`，同时兼容 **CPAMP** 与原生 **CLIProxyAPI**。
  - 每次查询自动枚举服务器上的全部 OAuth 凭据（`claude`、`antigravity`、`codex`、`kimi`、被动 `quota.signals` 兜底），新增或增删 OAuth 账号无需修改本地配置。
  - 支持在 `~/.pi/agent/cpa-usage.json` 中维护多个 CPA 服务器档案，使用 `/usage server` 快速切换。
- **Antigravity 全分组显示**：在 `/usage` 面板与状态栏紧凑模式下均完整展示 Antigravity 的所有分组（如 Gemini 与 3p）。

## 命令

| 命令 | 说明 |
|---|---|
| `/usage` | 打开实时额度面板（每次打开自动刷新） |
| `/usage refresh` | 同 `/usage` |
| `/usage text` | 强制刷新并输出纯文本报告 |
| `/usage statusline on\|off\|toggle` | 开启/关闭状态栏紧凑摘要 |
| `/usage server [name]` | 查看或切换 CPA 服务器配置 |
| `/usage config` | 交互式配置服务器地址、密钥和开关 |
| `/usage on\|off` | 总开关启用/停用本扩展 |

## 配置文件

默认路径 `~/.pi/agent/cpa-usage.json`（权限 `0600`）：

```json
{
  "enabled": true,
  "statusline": {
    "enabled": false,
    "refreshIntervalSec": 180,
    "showDisabled": false
  },
  "activeServer": "newsyou-cpamp",
  "servers": {
    "newsyou-cpamp": {
      "baseUrl": "https://cpamp.orey.one",
      "managementKey": "<ADMIN_KEY_OR_env:VAR>"
    }
  },
  "cacheTtlSec": 30,
  "requestTimeoutMs": 12000
}
```
