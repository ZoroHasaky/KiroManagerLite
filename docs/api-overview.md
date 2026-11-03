# Kiro / AWS 接口清单

本应用直接与 Kiro 官方接口交互的部分都收在 `src/main` 下的几个模块里。本文按用途列出**全部**上游接口，说明每个接口做什么、在哪个文件里调用，以及踩过的坑。

所有请求头、UA、区域归并规则统一来自 `src/main/kiroEndpoints.ts`，不要在别处再写一份。

[← 返回 README](../README.md)

---

## 一、端点与区域规则

| 域名族 | 用途 |
| --- | --- |
| `oidc.{region}.amazonaws.com` | AWS SSO OIDC：客户端注册、设备码、token 交换 |
| `prod.us-east-1.auth.desktop.kiro.dev` | Kiro 自有 auth service：Google / GitHub 社交登录 |
| `q.{region}.amazonaws.com` | Amazon Q：用量、模型列表、对话、MCP 搜索 |
| `codewhisperer.{region}.amazonaws.com` | CodeWhisperer：profile 列表、对话回退 |
| `runtime.{region}.kiro.dev` | API Key（ksk_）生成面 |
| `management.{region}.kiro.dev` | API Key 控制面：模型、用量、Key 管理 |
| `app.kiro.dev` | 网页门户：用户信息、订阅、CSRF 操作 |

**区域归并**：上游只在这两个区域有部署，其余区域按地理位置就近归并（`serviceRegion()`）：

- `eu-*` → `eu-central-1`
- 其它 → `us-east-1`

**UA 约定**：`KiroIDE-<版本>-<机器码>`。服务端按 UA 里的版本号做准入，Builder ID / IdC 用旧版本会被 403。版本号与机器码只在 `kiroEndpoints.ts` 定义，升级时只改那一处。

---

## 二、认证与登录

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `POST /client/register` | 注册 OIDC 客户端。Builder ID 用官方 CLI 身份（`Amazon Q Developer for command line` + 3 个 scope），Enterprise 用应用自己的名字 | `onlineLogin.ts` |
| `POST /device_authorization` | Builder ID 设备码授权，返回 userCode 与验证地址 | `onlineLogin.ts` |
| `POST /token`（设备码） | 轮询换取 accessToken / refreshToken | `onlineLogin.ts` |
| `POST /authorize` | Enterprise 授权码流程的跳转地址（PKCE） | `onlineLogin.ts` |
| `POST /token`（authorization_code） | Enterprise 授权码换 token | `onlineLogin.ts` |
| `GET /login` | 社交登录入口（带 PKCE，`idp=Google/Github`） | `onlineLogin.ts` |
| `POST /oauth/token` | 社交登录 code 换 token | `onlineLogin.ts` |
| `POST /token`（refresh_token） | IdC / Builder ID 续期 | `kiroApi.ts` |
| `POST /refreshToken` | 社交账号续期 | `kiroApi.ts` |

### 注意事项

- **Builder ID 的客户端身份要对齐官方 CLI。** 服务端会按签发客户端决定部分接口的准入，用应用自己的名字注册的客户端在订阅接口上会回 401。注册名与 scope 见 `kiroEndpoints.ts` 的 `AMAZON_Q_CLI_*`。
- **clientId 每次注册都是新生成的随机值**，拿不到官方那个固定值；refresh token 与签发它的 clientId 绑定，跨客户端刷新会回 `invalid_grant`。
- **refresh token 不会随刷新轮换**（实测新旧一致），所以外部脚本用 refresh token 换 access token 不会把用户踢下线。

---

## 三、账号信息与用量

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `GetUserInfo`（CBOR） | 取邮箱、userId、idp、封禁状态；用于测活与导入校验 | `kiroApi.ts` |
| `GET /getUsageLimits` | 官方用量接口：积分、奖励、下次重置；主端点 403 时换区域重试 | `kiroApi.ts` |
| `GetUserUsageAndLimits`（CBOR） | 网页门户版用量接口，`settings.usageApiType` 可切换 | `kiroApi.ts` |
| `POST /ListAvailableProfiles` | 列出账号的 profile ARN，主要给 Enterprise 用 | `kiroApi.ts` |

### 注意事项

- `getUsageLimits` 与 `GetUserUsageAndLimits` 是同一份数据的两个入口。默认走 REST；门户版失败（401/403）时自动回退 REST。
- **profileArn 是必填**：不带会回 400 / 403。按账号类型取：
  - Builder ID：硬编码占位符
  - Github / Google：后端固定的 social ARN
  - Enterprise：先用 `ListAvailableProfiles` 问真实 ARN
- 调用量接口时按候选 ARN 逐个试，把真正生效的那个写回账号，下次一次命中。

---

## 四、模型与对话

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `GET /ListAvailableModels`（q 域） | 拉账号可用模型，分页，带 profileArn 候选重试 | `kiroChat.ts` |
| `POST /generateAssistantResponse`（q 域） | 对话主端点，流式返回；账号测活与反代都用 | `kiroChat.ts` / `proxyUpstream.ts` |
| `POST /generateAssistantResponse`（codewhisperer 域） | 对话回退端点 | `kiroChat.ts` / `proxyUpstream.ts` |
| `GET /List-Available-Models`（management 域） | API Key 的模型列表 | `kiroChat.ts` / `keyGateway.ts` |
| `POST /generateAssistantResponse`（runtime 域） | API Key 的对话端点 | `kiroChat.ts` / `proxyUpstream.ts` |
| `POST /mcp`（q 域） | Kiro 自带联网搜索，JSON-RPC 调 `web_search` 工具 | `kiroWebSearch.ts` |

### 注意事项

- **对话请求体**：`conversationState` + 可选 `profileArn`。推理档位放在**根级** `additionalModelRequestFields`，放在 `userInputMessage` 等位置会被静默忽略。
- **`auto` 模型不能带 modelId**：带字面量 `"auto"` 会 400。
- **API Key 路径绝不能带 profileArn**，带了会被 403。
- **不要加 `TokenType: EXTERNAL_IDP` 头**：实测 Enterprise 账号加上后模型列表与对话都 403。
- **MCP 搜索**：非 API Key 账号必须带 `x-amzn-kiro-profile-arn` 头，否则 403。返回结果套在 `result.content[0].text` 里，还要再解一层 JSON。

---

## 五、订阅与计费

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `GetAvailableSubscriptionPlans`（CBOR） | 列出可开通档位；订阅弹窗与批量订阅都用 | `kiroSubscription.ts` |
| `GenerateSubscriptionManagementUrl`（CBOR） | 生成 Stripe 账单管理 / 结算链接 | `kiroSubscription.ts` |
| `GET /`（门户首页） | 取 CSRF token 与 UserId cookie，供上面两个接口做双提交校验 | `kiroSubscription.ts` |

### 注意事项

- 这两个 CBOR 操作与用量不同，**强制 CSRF 双提交**：必须同时带 `x-csrf-token` 头和与之配对的 UserId cookie。只给头没带 cookie 回 `401 Invalid CSRF token`，头都没给回 `400 CSRF token is required`。
- CSRF token 与 UserId 必须来自**同一次**首页响应，两者是一对。
- **部分账号调管理链接接口会稳定回 401**（`Authentication required or access denied`），而同一账号的档位列表接口是 200。这与客户端身份、token、profileArn 都无关，属于服务端对具体账号的准入判断。
- 因此界面流程是**先列档位、选中再生成链接**：不在打开弹窗时探测管理链接，避免 401 把整个查询带崩。
- 未订阅账号调管理链接接口回 `400 BadRequestException`，这是「没有可管理的订阅」的正常信号，不是故障。

---

## 六、API Key（ksk_）管理

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `POST /` + `x-amz-target: CreateApiKey` | 为账号生成 API Key，只在创建时返回完整明文 | `kiroApiKey.ts` |
| `POST /` + `x-amz-target: ListApiKeys` | 列出账号已创建的 Key（只有前缀） | `kiroApiKey.ts` |
| `POST /` + `x-amz-target: DeleteApiKey` | 删除指定 Key | `kiroApiKey.ts` |
| `GET /Get-Usage-Limits` | Key 的用量；`isEmailRequired=true` 时带绑定邮箱 | `keyGateway.ts` |

### 注意事项

- 这三个控制面操作走 `management.{region}.kiro.dev` 的**根路径**，操作名放在 `x-amz-target` 头里，参数走 JSON body，是 AWS 的 `x-amz-target` 风格而非普通 REST。
- **控制面把 profileArn 当必填**，Builder ID 也要带占位符。
- `CreateApiKey` 的响应里 `keyPrefix` 与完整 Key 都以 `ksk_` 开头，必须校验长度，不能把前缀当结果交给用户。

---

## 七、网页门户

| 接口 | 作用 | 调用位置 |
| --- | --- | --- |
| `https://app.kiro.dev`（外部 Chrome 无痕窗口） | 以账号身份打开官网后台 | `externalPortal.ts` |
| 任意 http(s) 链接（内置浏览器） | 打开 Stripe 账单页、支付页 | `kiroPortal.ts` |

打开官网时注入四个 cookie：`Idp`、`AccessToken`、`RefreshToken`、`ProfileArn`。缺 `ProfileArn` 时 Enterprise 账号会停在登录页（`user-status: stale`）。cookie 的组装规则在 `portalAuth.ts`，找不到 Chrome 时的内置浏览器兜底与外部 Chrome 共用同一份。

---

## 八、本地转发链路

这两条不是 Kiro 接口，但会向上游转发请求，排查问题时容易混淆：

| 组件 | 作用 | 位置 |
| --- | --- | --- |
| 本地反代 | 把 Anthropic / OpenAI 格式转成 Kiro 的 `generateAssistantResponse`；自动模式先 q 域后 codewhisperer 域 | `proxyUpstream.ts` |
| Key 网关 | 把 IDE 的 OAuth 请求替换成 `ksk_` API Key，转发到 runtime / management，并剥离 `profileArn` | `keyGateway.ts` |

---

## 附：快速对照

| 场景 | 需要 CSRF | 需要 profileArn | 认证方式 |
| --- | --- | --- | --- |
| 用量 / 模型列表 | 否 | 是 | Bearer |
| 对话 | 否 | 是（API Key 路径除外） | Bearer |
| 订阅档位 / 管理链接 | **是** | 否 | Cookie + CSRF |
| API Key 管理 | 否 | 是 | Bearer + `x-amz-target` |
| MCP 搜索 | 否 | 是（API Key 除外） | Bearer |
