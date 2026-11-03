# 支付页加载慢：实测归因

结论先行：**不是应用启动慢，也不是 CDP 慢，而是 Stripe 静态资源每次都要从零下载。**
实测分段耗时里 Chrome 启动 + CDP 连接稳定在 420–460ms，而「表单可填」在 1.5s 到 46s 之间波动。

## 实测数据

用 `scripts/pay-timing.mjs` 对真实结算链接跑多轮，分段计时：

| 环节 | 耗时 |
| --- | --- |
| 进程 spawn → DevToolsActivePort | 316–333ms |
| 端口 → /json/version 就绪 | 74–115ms |
| WebSocket + attach | 415–459ms |
| **表单可填（关键）** | **1.5s – 46.7s** |

前三个环节每轮几乎不变，波动全部来自最后一段。

## 排除掉的假设

- **Chrome 启动慢**：稳定 330ms，与波动无关。
- **CDP 握手慢**：稳定约 100ms。
- **DNS 慢**：mihomo 对 stripe 域名返回 fake-IP（198.18.x.x），解析 0–3ms；
  从没访问过的主机首次解析也在 1.4s 内完成。
- **`--disable-background-networking`**：之前已移除，移除后仍会慢，不是本次原因。
- **`--disable-quic`**：A/B 实测更差（平均 23.8s vs 8.1s），**不要加**。
- **代理整体带宽**：同一时刻用 curl 走同一条代理拉同一个文件，
  8 轮全部 2.2–2.9s，Chrome 甚至更快（0.8–2.5s）。带宽不是瓶颈。

## 真正的原因

Stripe 的静态资源响应头是：

```
Cache-Control: max-age=31536000
```

（`checkout-app-init`、`vendor`、`stripe`、`sentry` 等几个文件合计约 3.7MB 未压缩）

而支付浏览器每次都用 `mkdtempSync` 新建临时 profile，退出时整个目录删除——
**磁盘缓存也跟着没了**。于是每次打开支付窗口都是纯冷缓存，必须重新下载全部静态资源。

网络状况好时 1–2 秒下完，网络抖动时这些大文件在并发下载中排到长尾，
就变成 10–46 秒。这正好解释了「有时候很快有时候很慢」。

## 修复

`launchBrowser` 新增 `cacheDir` 选项，把磁盘缓存指向应用数据目录下的固定位置：

```ts
// src/main/payment/session.ts
function paymentCacheDir(): string {
  return join(app.getPath('userData'), 'payment-cache')
}
```

Chrome 参数相应加上：

```
--disk-cache-dir=<userData>/payment-cache
--disk-cache-size=268435456
```

**cookie 与登录态仍然隔离**：`--user-data-dir` 还是每次新建的临时目录，
只有 HTTP 缓存跨会话复用。

## 修复效果

连续 3 次全新 profile + 同一个缓存目录：

| 轮次 | 表单可填 | 缓存命中 |
| --- | --- | --- |
| 第 1 次（冷） | 46652ms | 3/32 |
| 第 2 次 | **1068ms** | 19/52 |
| 第 3 次 | **1324ms** | 35/44 |

三次的 profile 目录互不相同（已断言），缓存目录写入了 69 个文件。

用 `--cache` 模式再跑 4 轮：4309 / 1879 / 2588 / 1494ms。

## 复现方法

```bash
# 纯冷启动（复现慢的情况）
node scripts/pay-timing.mjs '<结算链接>' 4

# 共享缓存（复现生产行为）
node scripts/pay-timing.mjs '<结算链接>' 4 --cache
```

注意：结算链接的 `#fragment` 是会话凭据，**必须完整保留**，
只截取 `https://checkout.stripe.com/c/pay/cs_live_...` 会得到一个空壳页面（0 个 input）。

## 另一个已确认但不在应用侧的因素

本机 Clash Verge 配置里有一条优先级最高的规则：

```yaml
- DOMAIN-KEYWORD,stripe,DIRECT
```

所有 stripe 流量因此绕过代理节点直连。实测并发拉取 Stripe 大文件时：

- 命中 DIRECT 规则：最大文件 10.9–23.7 秒
- 同一文件走代理节点：2.5–3.9 秒

如果希望进一步稳定，可以在代理配置里去掉这条规则，让 stripe 跟随代理节点。
这是网络出口策略，属于用户侧配置，应用不强行覆盖（`chrome.ts` 仍不传任何代理参数）。
