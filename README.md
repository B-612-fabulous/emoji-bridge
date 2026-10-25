# 表情搬运工 (EmojiBridge)

把短视频平台里**收藏的表情包**搬到聊天软件能用。

Android 原生（Java）**纯本机**应用：不依赖任何后端，登录 Cookie 只留在手机本地 WebView，
表情列表与图片全部由 App 直连来源平台获取。

> 背景：收藏表情是**动态 WebP**，聊天软件不认动画，只显示第一帧。
> 所以 App 在本机把动态 WebP 解码后重新编码成 GIF，再通过系统分享发出去，
> 用户在聊天窗口「长按图片 → 添加到表情」即可。

---

## 技术亮点

这个项目解决了几处不太常见的问题，代码都留了详细注释：

- **纯本机取登录态**：内嵌 WebView 打开官方网页登录，只读本机 Cookie，
  不经过任何自建服务器 —— 既省去后端成本，也不碰用户凭证。
- **无闪烁的登录遮罩**：登录页用一层注入的全屏遮罩盖住首页信息流，
  只留一个入口按钮；靠 `MutationObserver` 实时把官方登录弹窗「顶」到遮罩之上，
  全程看不到信息流，也不误触。详见 `assets/login_mask.js`。
- **流量自控**：首页的视频流与封面大图在 `shouldInterceptRequest` 层直接丢弃
  （单次预览可达 7~8MB），只放行登录弹窗必需的 HTML/JS/CSS/接口。
- **动态 WebP → GIF**：自己实现逐帧解码 + GIF 编码（中位切分量化 + LZW），
  在原图画质和体积之间取平衡。
- **请求签名与业务解耦**：反爬签名（`a_bogus`）抽象为 `SignatureSigner` 接口，
  真实算法**不随本仓库分发**，见下文。

## 功能

- 内嵌 WebView 登录，仅取本机 Cookie，不上传任何服务器
- 直连接口拉取「收藏表情」，自动分页，优先取 origin 原画质
- 动态 WebP → GIF 本机转换（静态图 / PNG / JPG 原样放行）
- 多选后两种出口：
  - **存相册**（`Pictures/WeChatEmoji`），带进度提示
  - **转发到聊天**（单张走 `ACTION_SEND`，多张走 `ACTION_SEND_MULTIPLE`）
- 浅色 / 深色主题切换；批量操作有实时进度，不会「像卡死」
- 底部三 tab：**首页 / 表情 / 更多**，切页不重来
- 本机缓存：原图 + 转换结果 + 表情列表，同一张二次保存/转发秒出；多选 3 路并行下载
- 一键反馈（跳系统邮件）、打赏、关于、隐私政策

## 工作原理

```
┌────────────┐   本机 Cookie    ┌──────────────┐
│  WebView   │ ───────────────▶ │  来源平台接口  │
│ (官方登录页) │                  │ (list / 原图) │
└────────────┘                  └───────┬──────┘
      ▲ 遮罩注入                          │ 动态 WebP
      │ (login_mask.js)                   ▼
┌──────────────────────────────────────────────┐
│              本机：解码 → 转 GIF → 分享          │
│   MediaStore 存相册   /   ACTION_SEND 发聊天    │
└──────────────────────────────────────────────┘
```

## 目录结构

```
app/src/main/java/com/example/emojibridge/
├── MainActivity.java          宿主页：三 tab 容器 + 首页/更多 + 主题切换
├── LoginActivity.java         WebView 登录，本机取 Cookie，遮罩隐藏信息流
├── EmojiPage.java             表情页：拉列表 → 多选 → 并行下载 → 转换 → 存相册/转发
├── EmojiAdapter.java          网格 + 多选 + 选中变化回调
├── model/EmojiItem.java
├── net/DouyinApi.java         接口直连（列表 / 下载）
├── crypto/
│   ├── SignatureSigner.java   签名接口（业务只依赖它）
│   ├── Signers.java           签名器工厂（反射加载真实实现）
│   └── SM3.java               签名用哈希
├── convert/
│   ├── StickerConverter.java       转换入口：动态 WebP → GIF，其余原样
│   ├── ExtractingWebpDecoder.java  逐帧解码（基于 awebp）
│   └── GifEncoder.java             写 GIF（中位切分 + LZW）
└── util/
    ├── AlbumSaver.java        写入 MediaStore（Pictures/WeChatEmoji）
    └── ImageStore.java        本机缓存：原图 / 转换结果 / 表情列表

app/src/main/assets/login_mask.js   登录页遮罩脚本
```

## 速度

- 原图与转换后的 GIF 都落在应用私有缓存：**同一张表情第二次保存或转发不再走网络，直接秒出**。
- 多选时按 3 路并行下载 + 转换，不再是串行一张张等。
- 「更多」页可打开**表情列表缓存**开关（默认关闭）：开启后再进表情页用本地 JSON 秒开，顶部标注缓存时间；表情页的「刷新」按钮两种模式下都常驻，点了就强制重拉并更新缓存。

## 本机私有配置（不会进 Git）

仓库里刻意留空、只有你本机才有的三样东西，全部写在 `.gitignore` 里：

| 内容 | 放哪 | 公开仓库里没有时会怎样 |
|---|---|---|
| 反爬签名 `a_bogus` | `app/src/main/java/.../crypto/ABogus.java` | 编译照过，调用接口时明确报错 |
| 支付宝收款链接 | `local.properties` 里的 `donate.alipay.qr=…` | 打赏弹窗里「支付宝」按钮不显示 |
| 微信收款码图片 | `app/src/main/res/drawable/ic_donate_wechat.png` | 打赏弹窗里「微信」按钮不显示 |

`local.properties` 补一行即可（这个文件本来就是本机配置，已忽略）：

```properties
sdk.dir=/Users/you/Library/Android/sdk
donate.alipay.qr=https://qr.alipay.com/你的收款码
```

这个值由 `app/build.gradle` 读出来，注入成 `BuildConfig.DONATE_ALIPAY_QR`，
运行期用 `alipays://` scheme 直接拉起支付宝的收款页，界面上不出现二维码图片。
微信没法用 scheme 打开个人收款码，只能展示图片，所以图放在 drawable，
调用处用 `getIdentifier` 按名字查，文件不在就自动隐藏入口。

> 想让打赏入口彻底不出现在公开版本里，删掉本地这两项配置即可，不用改代码。

## 构建

```bash
./gradlew :app:assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

需要 JDK 17、Android SDK（compileSdk 35）。直接克隆本仓库即可编译；
只有「实际调用接口拉取列表」这一条链路需要自行提供签名实现（见下）。

## 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | 本机直连来源平台接口 |
| `ACCESS_NETWORK_STATE` | 网络状态判断 |
| `WRITE_EXTERNAL_STORAGE`（≤ Android 9） | 保存图片到相册 |

Android 10+ 通过 `MediaStore` 写相册，无需存储权限。

## 隐私

- 不采集个人身份信息、设备标识或位置数据
- 登录 Cookie 仅存于本机 WebView，仅用于向来源平台官方接口发起请求
- 不含任何后端服务，不向任何第三方服务器上传数据

## 关于签名算法

本仓库**不包含** `a_bogus` 反爬签名的实现（`crypto/ABogus.java` 已被 `.gitignore` 排除）。
`crypto/Signers.java` 通过反射按需加载：

- 本地存在 `ABogus` 实现 → 正常签名、正常使用；
- 公开仓库缺少该实现 → 调用接口时明确报错，但**工程仍可正常编译、阅读**。

如需自行实现，实现 `SignatureSigner` 接口即可。

## 已知限制 / TODO

- 签名算法可能随平台更新而失效，届时需同步跟进
- 多选转发受聊天软件限制：一次只能转发一张 GIF
- 待办：release 签名、隐私政策可访问页面、接口失效时的降级提示

## License

待定（TBD）。