# 变更记录 (CHANGELOG)

> 版本号唯一来源：`app/build.gradle` 的 `versionCode` / `versionName`。
> 界面展示一律走 `BuildConfig.VERSION_NAME`，禁止在 `strings.xml` 硬编码。

---

## v0.8.9（versionCode 47）

### 修复：预热复用路径下分享按钮失效（`window.EBQr === undefined`）

**现象**：从首页预热 WebView 复用时，进入登录页点「发到另一台手机」分享二维码，
`window.EBQr` 为 `undefined`，分享桥没生效，走兜底逻辑。

**根因**：`addJavascriptInterface` 只对调用之后**新创建的页面 JS 上下文**生效。
预热 WebView 在首页阶段就已把登录页加载完，`LoginActivity.take()` 之后才绑定桥，
此时页面没有重新导航，旧的 JS 上下文永远拿不到 `EBQr` 桥。

**修复方案（三个文件）**：

| 文件 | 改动 |
|---|---|
| `QrBridge.java` | `activity` 字段改为 `volatile`、可空可更新；新增 `attach(Activity)` 方法；`save` / `share` / `openApp` / `evaluate` 加空判断，lambda 用 `final Activity host` 捕获 |
| `WebViewWarmup.java` | `prepare()` 阶段即 `addJavascriptInterface(new QrBridge(null, v), "EBQr")`（activity 传 null 占位）；新增静态 `sBridge` 字段 + `bridge()` 方法；`recycle()` 保留桥引用不再清空 |
| `LoginActivity.java` | 复用预热时 `WebViewWarmup.bridge().attach(this)` 补真实 Activity；冷启动仍走 `new` 桥 |

**关键铁律**：预热阶段（`prepare`）就必须绑桥，登录页 `take()` 后只 `attach()` 补 Activity，
**绝不能再次 `new` 桥去覆盖**（覆盖对已加载页面无效，会复现 bug）。

**测试**：真机全自动回归 100/100 通过；USB 真机验证完整链路
（打开 App → 点「去登录抖音」→ 复用预热 → 6 秒出码弹卡片 → 点「发到另一台手机」
→ 系统分享面板弹出，日志「二维码已交给系统分享」，文件名「抖音登录二维码.png」）。

**未验证项**（需另一台手机真扫）：
- 真实扫码登录后回首页 → 表情列表加载闭环
- 「打开抖音」按钮真机行为
- 退出登录后再进登录页的 cookie 残留
