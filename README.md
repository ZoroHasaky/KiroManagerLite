<p align="center">
  <img src="docs/logo.png" width="128" height="128" alt="Kiro Manager Lite Logo">
</p>

<h1 align="center">Kiro Manager Lite</h1>

<p align="center">
  <strong>Kiro 多账号管理器轻量版</strong>
</p>

<p align="center">
  多账号集中管理 · 账号阶段自动推导 · 密钥与用量分批刷新 · 订阅开通与账单管理 · 支付链接与二维码 · 流式测活 · 导入导出 · 内置私密浏览器 · 托盘常驻
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.2.6-6c5ce7" alt="version">
  <img src="https://img.shields.io/badge/updated-2026--11--23-2f9e44" alt="updated">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Vue-3-42b883" alt="vue">
  <img src="https://img.shields.io/badge/Electron-44-47848f" alt="electron">
</p>

---

## ✨ 功能特性

### 🔐 多账号管理

**添加与列表**

- 五种添加方式：Google / GitHub 社交登录、AWS Builder ID 设备码、Enterprise IAM Identity Center SSO、OIDC 凭证、读取本机已登录的 Kiro 凭证
- 搜索、按状态 / 订阅 / 登录方式 / 积分占比 / 导入时间范围（精确到时分秒）筛选、排序、多选与批量操作；上千账号用虚拟列表保持流畅
- 自定义分组：新建 / 改名 / 删除、长按拖动排序，按分组（含「未分组」）多选筛选，可批量把选中账号移入或移出分组，卡片上直接显示分组标签
- 卡片显示邮箱、昵称、备注、订阅档位、积分占比与 Token 剩余时间；备注可自己填，用于标记用途或来源
- 三种展示形态可切换并记住选择：卡片、卡片紧凑（收起额度明细）、列表（一排一个的横向长条，一屏能看几十个）
- 详情抽屉展开订阅档位、积分构成、超额费率、Token 有效期与完整凭证，支持一键复制

**刷新与检测**

- 批量刷新 Token / 用量与积分，支持定时自动检测
- 检测与刷新分成两条时间线：定时任务只判断「谁该刷」并把账号放进待刷新池，另一个任务按固定节奏从池里取几个真正去刷。
  同一出口 IP 短时间集中请求会被上游限流，把请求摊开是最直接的规避手段；密钥池与用量池各有独立的间隔与每批数量
- 账号阶段（未使用 / 待支付 / 已订阅 / 已出售 / 已闲置）由订阅、支付链接与用量自动推导，不需要手工维护
- 真实流式对话测活（卡片「信息」弹窗里的「测活」按钮）：实时看输出、随时中止。只有 runtime 面的真实对话才能暴露封禁账号；响应区可「查看完整响应」，列出发给官方的每次请求与原始返回（成功、失败、中止都能看）
- 测活的模型改为可搜索的级联选择，二级是该模型自己的推理档位（Claude 系 low / medium / high / xhigh / max，GPT 系另有 none，没有这一层的模型不显示二级）；只选主模型时自动补上它的默认档位

**订阅管理**

- 点卡片上的订阅标签即进订阅管理，弹窗内先查状态再分流：已订阅的账号直接用内置浏览器打开 Stripe 账单页（改套餐、退订都在那边做），未订阅的账号列出官方可开通的档位
- 档位卡片显示名称、价格、计费周期与特性，并标出当前套餐；每个档位两个动作 —— 生成支付链接并用内置浏览器打开，或只把链接复制到剪贴板（想换个地方付款、先存下来都不用打开浏览器）
- 查询前按需为该账号续期 Token：门户的订阅接口认的是 cookie 里的 AccessToken，而 IDE 只续它自己在用的那个账号
- 查询失败就地显示原始报错并附「关闭 / 重试」，不必关掉重开
- **批量生成订阅链接**：勾选多个账号后在「批量操作」里选一个订阅档位（用勾选的第一个账号向官方查询可开通档位），为每个账号逐个生成 Stripe 订阅链接；
  已有订阅的账号判为失败，单个失败不影响后续，可中止与重试失败项。生成后每行可用内置浏览器打开或复制，也可下载 txt（`邮箱----订阅链接`）
- **切换 Free**：勾选账号后批量把订阅降到 Kiro Free。默认只列出「非 Free 且没有待生效切换」的账号；
  勾选「强制」则全部账号都进列表，每个号向门户实查一次，适合本地记录与门户状态对不上时纠偏

**前往官网**

- 用该账号凭证在系统 Chrome（或 Edge）的无痕窗口直接进 Kiro 官网后台，省去先切号再手动登录
- 每次都是全新的临时 profile：不读也不写你自己浏览器里的登录身份与历史记录，关窗即删；不会出现显示上一个账号的情况
- 官网跑在原生 Chrome 里（指纹、扩展、证书链都是浏览器自己的），比内置窗口顺畅
- 找不到 Chrome / Edge 时自动退回内置浏览器，同样注入该账号的 cookie，功能不中断
- 地区跟着设置的「浏览器地区」走：`--lang` 同时决定页面语言与 `Accept-Language`
- Stripe 账单 / 结算页仍在应用内的私密窗口打开，不涉及账号身份，这部分保持不变

**打开订阅门户（无痕）**

- 动作区的钱包图标用该账号凭证现场换一条 Stripe 管理门户链接，交给系统浏览器的无痕窗口打开；
  取消订阅、改支付方式、下载发票这类只能在门户里手动做的事，从卡片上一步就能进
- 链接是短时效凭证，每次点击都重新换取，不缓存；账号未订阅或已是 Free 时按「没有可管理的订阅」提示
- 这条入口只负责打开门户，不替代「切换 Free」——后者仍是纯 HTTP 直接改订阅，不启浏览器

### 📈 用量与历史

- 每次刷新账号都会记录积分变化，支持平滑趋势曲线、明细表、清空与 Excel 导出
- 历史曲线采用不过冲的单调平滑插值，时间轴末端标签完整显示
- 删除账号时同步清理关联历史与备份残留，避免孤儿数据继续占用存储

### 📦 导入与导出

- 账号支持卡密、精简 JSON、完整备份 JSON、CSV 和 TXT，可粘贴内容或一次选择多个文件导入
- 导出范围只有一条规则：**勾选了就导勾选的，没勾选就导全部**，不需要在弹窗里再选一次
- 选中多个账号时可「导出为压缩包」或「逐个分割导出」：后者每个账号一个独立文件、外加一个整批的 `all` 文件，一起打成压缩包，文件名与单个导出一致，取出即可回导
- 导出可保存到文件或复制到剪贴板，账号导出可选择是否包含敏感凭证
- 导出成功后自动打开所在文件夹并选中该文件，也可在设置里关掉
- 账号的大批量校验 / 刷新并发数可配置

### 🧰 常用工具

- **网络检测**：查看当前出口 IP 的国家、地区、运营商与时区，一键测试 GitHub、Google、YouTube、Kiro、Amazon 的连通性与延迟；走设置里的代理，看到的就是 Kiro 请求实际经过的出口
- 出口信息可直接复制，测试结果按站点分组展示，失败时给出原始错误

### 🧾 系统日志

- 主进程与渲染进程日志汇入同一时间线，支持关键字、时间、分类和级别筛选
- 内存环形缓冲保留最近 5 万条，磁盘分片落盘并自动清理，虚拟滚动可承载数万行
- 支持跟随最新日志、导出筛选结果、打开日志目录和一键清空；向上查看历史时不会被新日志强制拉回底部

### ⚙️ 个性化设置

- 主题风格（自动 / 浅色 / 深色）、主题色（7 种预设，默认紫罗兰）、布局风格（左右布局 / 上下布局，上下布局把导航放到窗口顶部）、控件尺寸（默认 / 大尺寸，两个列表页的工具栏那一排跟着一起变）、积分精度与删除前确认
- **隐私打码**：一键遮住邮箱与备注，截图或录屏前很有用。
  邮箱的遮罩串由 md5 前缀生成，同一账号每次结果一致，打码状态下仍能横向比对是不是同一个号
- **内置浏览器**：指定应用内打开的网页使用哪个地区，50 个常用地区可搜索选择，也可自定义 BCP 47 标签。
  只影响应用内的网页，不改界面语言、也不影响账号所属的 AWS 区域
- 密钥与用量的检测间隔、两个待刷新池的刷新间隔与每批数量、批量并发与导入并发数
- **数据管理**：账号与积分变化记录导出为明文 `.json`（带导出时间与版本），导入时只替换文件里带的部分；
  「初始化」清掉全部数据，和初次安装一样；备份计划默认开启，每 30 分钟静默备份一次、保留最新 3 份，周期与份数可改
- REST / CBOR 用量接口、HTTP 代理，以及数据、备份和日志目录快捷打开

### 🖥️ 桌面端体验

- 系统托盘常驻，可查看账号汇总（正常 / 异常 / 封禁 / 即将到期）、刷新全部用量、显示窗口；关闭行为支持最小化到托盘 / 退出 / 每次询问
- macOS 中文菜单栏、自定义协议 `kiro-manager-lite://` / `kml://` 和单实例唤起
- 管理页详情、图表和各类模态框按用户操作实时挂载，页面切换不再等待退出动画，减少大数据量下的白屏感
- 关于页手动检查更新会立即显示加载态；GitHub API 失败时自动重试并通过 Releases 页面兜底，失败后可重试或手动更新

---

## 📥 下载

<p align="center">
  <a href="https://github.com/ZoroHasaky/KiroManagerLite/releases/latest">
    <img src="https://img.shields.io/badge/⬇%20下载最新版-v1.2.6-6c5ce7?style=for-the-badge" alt="下载最新版">
  </a>
  <a href="https://github.com/ZoroHasaky/KiroManagerLite/releases">
    <img src="https://img.shields.io/badge/全部版本-Releases-24292f?style=for-the-badge&logo=github" alt="全部版本">
  </a>
</p>

**最新版本：v1.2.6**（2026-11-23） · 变更详情见 [CHANGELOG.md](CHANGELOG.md)

### 选择对应的安装包

| 平台 | 文件 | 适用设备 |
| --- | --- | --- |
| macOS (Apple Silicon) | `*-mac-arm64.dmg` | Apple M 系列芯片 |
| macOS (Intel) | `*-mac-x64.dmg` | Intel 芯片 |
| Windows | `*-win-x64-setup.exe` | 64 位 Windows |
| Linux | `*-linux-x86_64.AppImage` | 64 位 x86 Linux |

不确定 Mac 是哪种芯片：**苹果菜单 → 关于本机**，看「芯片」一栏。

`.zip`、`.blockmap` 与 `latest*.yml` 是自动更新用的，手动安装不需要下载。

### 系统要求

| 平台 | 最低版本 | 架构 |
| --- | --- | --- |
| macOS | 13 Ventura | arm64 / x64 |
| Windows | Windows 10 | 仅 x64 |
| Linux | 主流发行版（Ubuntu / Debian / Fedora 等仍在维护的版本） | 仅 x64 |

版本门槛跟随 Electron 44（Chromium 152）的[平台支持范围](https://github.com/electron/electron#platform-support)。
**macOS 最低版本自 v1.0.38 起从 11 Big Sur 提高到 13 Ventura**（Chromium 已停止支持 macOS 12 及更早版本）；
仍在 macOS 11 / 12 的用户请继续使用 [v1.0.37](https://github.com/lucks-cloud/kiro-manager-lite/releases/tag/v1.0.37)。
Windows 与 Linux 暂不提供 arm64 包：原生依赖 `cbor-extract` 没有对应的预编译产物，
交叉编译在 CI 上必然失败。装机后约占 300–400 MB。

### 安装要点

- **Windows**：双击 `.exe` 安装。安装包未做代码签名，SmartScreen 可能提示「已保护你的电脑」，
  确认文件来自官方 Releases 后选「更多信息 → 仍要运行」即可，**不要为此关闭 SmartScreen 或杀毒软件**。
- **macOS**：拖入「应用程序」。安装包做了 ad-hoc 签名但未公证，首次打开会被拦截一次，
  按提示在「系统设置 → 隐私与安全性」点「仍要打开」即可；DMG 里附了「安装指南.txt」说明处理办法。
- **Linux**：AppImage 免安装，`chmod +x` 后直接运行；缺 FUSE 时用 `--appimage-extract-and-run`。
- **升级**：先完全退出应用（含托盘 / 菜单栏后台进程），再用新包覆盖安装，用户数据不受影响。
  应用内「关于」页也能检查更新。

遇到系统拦截、架构选错、升级或卸载问题，完整排查步骤见 **[安装说明与常见问题](./INSTALL.md)**。

---

## 📸 截图

### 主页

![主页](docs/screenshots/home.png)

### 账户管理

![账户管理](docs/screenshots/account.png)

### 添加账号

![添加账号](docs/screenshots/account-add.png)

### 在线登录

![在线登录](docs/screenshots/account-add-online-login.png)

### 账号测活

![账号测活](docs/screenshots/account-online-test.png)

### 常用工具

![常用工具](docs/screenshots/tool.png)

### 系统日志

![系统日志](docs/screenshots/system-log.png)

### 设置

![设置](docs/screenshots/setting.png)

### 关于

![关于](docs/screenshots/about.png)

---

## 🛠️ 技术栈

| 层 | 选型 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 桌面框架 | Electron 44 |
| 状态管理 | Pinia |
| UI 组件 | Ant Design Vue 4 |
| 构建工具 | Vite + electron-vite |
| 网络层 | undici（统一 fetch + 代理） |
| 持久化 | electron-store（加密存储 + 定时 JSON 备份） |
| 序列化 | cbor-x（Kiro 网页门户的 CBOR 接口） |

---

## 🚀 开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev

# 类型检查
npm run typecheck

# 类型检查 + 构建产物
npm run build

# 打安装包（win / linux 同理）
npm run build:mac
```

本应用直接调用的 Kiro / AWS 接口（端点、认证方式、各接口作用与已知坑）见 **[Kiro / AWS 接口清单](docs/api-overview.md)**。

---

## 📂 目录结构

```
src/
  shared/                主进程与渲染进程共享的单一真源
    types.ts             共享类型与默认设置
    errors.ts            错误归一与「是否确定性失败」判定
    refreshPolicy.ts     刷新跳过策略（手动 / 自动共用一份）
    regions.ts           AWS 区域列表与分组
    portalLocale.ts      内置浏览器地区：预设、归一化、Accept-Language
    subscription.ts      订阅档位归一
    modelSchema.ts       从模型 schema 解析推理档位并拼请求字段
  main/
    index.ts             应用生命周期与窗口
    ipc.ts               IPC 注册与运行时设置下发
    appMenu.ts           macOS 中文菜单栏
    appProtocol.ts       自定义协议注册与唤起
    ── 账号
    accountService.ts    校验 / 刷新 / 状态检查
    onlineLogin.ts       在线登录：设备码、社交登录、Enterprise SSO
    ── Kiro 接口与本体
    kiroApi.ts           Token 刷新、用户信息、用量与积分
    kiroSubscription.ts  订阅：可开通档位与 Stripe 账单 / 结算链接（门户 CSRF 双提交）
    kiroAuth.ts          profileArn 决策与「读取本机已登录凭证」（只读）
    kiroChat.ts          测活：模型列表与流式对话
    kiroEndpoints.ts     端点、区域映射、Kiro 版本号与客户端 UA 的唯一定义（服务端按版本号准入）
    kiroPortal.ts        内置浏览器：私密窗口、工具条、看门狗重试与地区（含官网兜底）
    portalAuth.ts        门户会话身份：cookie 组装与 profileArn 补齐（两个浏览器通道共用）
    externalPortal.ts    前往官网：外部 Chrome 无痕窗口 + CDP 注入账号 cookie
    subscriptionPortal.ts 打开订阅门户：取 Stripe 管理链接并交系统浏览器无痕打开
    ── 基础设施
    legacyCleanup.ts     升级时还原旧版本写进用户机器上的外部配置
    net.ts               统一 fetch 与代理
    networkCheck.ts      出口 IP 查询与网站连通性测试
    store.ts             加密持久化
    usageHistory.ts      积分历史（防抖落盘）
    logger.ts            内存环形缓冲、分片落盘、接管 console
    tray.ts              系统托盘
    updater.ts           版本检查
    browser.ts           系统浏览器唤起
    xlsxWriter.ts        Excel 导出
  preload/               contextBridge 暴露的 API 白名单
    index.ts             主窗口用
    portalBar.ts         内置浏览器工具条用，与主窗口完全隔离
  renderer/src/
    stores/              Pinia：accounts / settings / subscriptionLinks / update
    views/               Home / Accounts / Keys / Proxy / Tools / Logs / Settings / About
    components/          layout、accounts、keys、proxy、tools、common
    utils/               格式化、打码、导入导出、图表、托盘桥接
```

---

## 🔒 安全说明

- 账号凭证保存在本机 electron-store 加密文件里，不会上传到任何第三方服务
- 渲染进程开启 contextIsolation、关闭 nodeIntegration，所有系统调用走 preload 白名单
- 导出内容包含可直接登录的凭证，请勿放到公开位置；导出时可关闭「包含凭证」
- Google / GitHub 在线登录期间会临时把 `kiro://` 协议注册到本应用（Kiro 授权服务只接受这个固定回调地址），登录结束或应用退出时立即注销，不会长期抢占其它程序的协议
- Enterprise SSO 的回调服务器只监听 `127.0.0.1` 的随机端口，授权完成即关闭，state 与 PKCE 全程校验
- 「前往官网」用的是不持久化的内存会话分区，退出即清；每次打开前先清空 cookie，不会串号，也不会写入你自己浏览器的登录态
- 本应用不向任何外部程序写配置：账号凭证只存在自己的加密库里。旧版本（≤1.2.5）改写过的 Kiro IDE 端点、
  桌面客户端配置与 `KIRO_API_KEY`，升级后会在一启动时一次性还原
---

## 🔖 更新日志

各版本变更记录见 [CHANGELOG.md](CHANGELOG.md)，当前版本 v1.2.6，最后更新于 2026-11-23。

---

## 💬 交流群

<p align="center">
  <img src="docs/qq-group.png" width="260" alt="QQ 交流群">
</p>

---

## 🙏 致谢与许可

本项目以 AGPL-3.0 许可开源。感谢以下开源项目的先行探索，本项目在它们的基础上学习、借鉴与重新实现：

- [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)：Kiro 多账号管理器，本项目账户管理接口实现的来源（AGPL-3.0）
