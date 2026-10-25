package com.example.emojibridge;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;

import java.io.ByteArrayInputStream;

/**
 * 登录页：内嵌 WebView 打开抖音官网，用户在抖音官方页面登录。
 * Cookie 只留在手机本地 WebView，不上传任何服务器。登录完点返回即回到首页状态页。
 *
 * <p>为了不让用户看到抖音首页信息流、也不白白消耗流量：
 * 只加载登录弹窗需要的 HTML/JS/CSS/接口，视频流与封面大图全部在拦截层丢弃
 * （抖音首页视频预览会自动播放，单次可达 7~8MB）。
 */
public class LoginActivity extends AppCompatActivity {

    private static final String DOUYIN_URL = "https://www.douyin.com/";
    /** 诊断开关：为 true 时把页面 DOM 结构定时打到 logcat，用于定位遮罩/弹窗问题。 */
    private static final boolean DEBUG_DOM = false;
    private static final String TAG = "LoginDump";
    /** 超过这个时间还没走到登录遮罩，就判定加载失败，给用户一个重试入口。 */
    private static final long LOAD_TIMEOUT_MS = 15000;

    private WebView webView;
    private android.view.View loadingView;
    private android.widget.TextView loadingText;
    private android.widget.Button retryBtn;
    /** login_mask.js 只读一次：注入会被调用四五次，没必要每次都做一次主线程 IO。 */
    private String maskJs;
    private boolean revealed;        // 封面是否已揭开
    private boolean revealScheduled;  // 是否已有一条「确认遮罩后揭开」的轮询链在跑
    private int maskConfirmTries;     // 连续确认到遮罩的次数（稳定后才揭开）
    private boolean darkMode;
    private int dumpTick;
    /** Cookie 只落盘一次，别让每秒的登录巡检反复写磁盘。 */
    private boolean cookieFlushed;
    /** 申请系统相机权限的请求码。 */
    private static final int REQ_CAMERA = 1001;
    /**
     * 等系统权限弹窗回来之后、再补授权给页面的那个请求。
     * 抖音的扫脸 / 扫码辅助会在页面里要摄像头，WebView 默认一律拒绝，
     * 于是用户点了「开始验证」之后什么都不发生——在用户眼里就是「这步走不通」。
     */
    private PermissionRequest pendingPermission;
    private final android.os.Handler handler =
            new android.os.Handler(android.os.Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);

        darkMode = getSharedPreferences("ui", MODE_PRIVATE)
                .getBoolean(getString(R.string.theme_pref), false);

        // 允许 chrome://inspect / adb forward 连上真实 DOM 调试（仅调试包开启，
        // release 包关掉：既是安全考虑，也避免调试通道带来的额外开销）
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        ViewGroup host = findViewById(R.id.webview_host);
        loadingView = findViewById(R.id.loading);
        loadingText = findViewById(R.id.loading_text);
        retryBtn = findViewById(R.id.btn_retry);
        retryBtn.setOnClickListener(v -> reload());

        // 优先用首页预热好的那个 WebView：抖音出码前要跑 8~12 秒风控挑战，
        // 那段时间用户在首页闲着也是闲着，让它先跑完，进来时码已经好了。
        webView = WebViewWarmup.take();
        boolean warmed = webView != null;
        if (warmed) {
            android.util.Log.i(TAG, "复用预热的 WebView，跳过冷启动");
        } else {
            webView = new WebView(this);
        }
        host.addView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // 必须用**桌面版 UA**，这一条是抖音的产品策略决定的，不是我们的偏好。
        // 实测（headless Chrome 抓图）：移动 UA 打开 www.douyin.com 和 sso.douyin.com，
        // 渲染出来都是一张「下载抖音看更多」的引导宣传页，**没有任何网页登录入口**；
        // 两种 UA 拿到的 HTML 完全相同（72914 字节），说明是前端 SPA 自己判断 UA
        // 决定渲染哪一版。移动版既没有登录入口，快捷模式也就无从代点。
        // 桌面 UA 才有完整的登录弹窗（扫码 / 短信 / 密码）。
        settings.setUserAgentString(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                        + "Chrome/122.0.0.0 Safari/537.36");
        // 桌面版页面固定按 ~980px 排版，手机屏只有 360dp，只能整体缩小到装得下。
        // 不缩（overview=false）会只看到页面左上角一小块，遮罩中心跑到屏幕外。
        // 所以这里必须 true；缩小导致的「字偏小」由 login_mask.js 里的
        // 视觉补偿（反向 scale）单独处理——只放大我们自己画的遮罩，不动抖音页面。
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 禁止双指缩放和缩放控件：一能缩放，页面就能被拖动、被放大，
        // 而遮罩是 position:fixed 跟着「布局视口」走的，一旦缩放只盖住一部分，
        // 表现就是「遮罩不在正中、还能拖着跑」。固定成 1:1 最稳。
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // 把二维码存相册 / 发到另一台手机（页面 → 原生）。页面里 window.EBQr.share()/save()。
        // 预热复用的 WebView 在首页阶段就已经绑好了桥（activity 为 null 占位），
        // 这里只需把真实 Activity 补进去；冷启动新建的 WebView 则在这里首次绑桥。
        // 绝不能再 new 一个桥去覆盖 —— addJavascriptInterface 对已加载的页面无效，
        // 覆盖后预热的页面里拿到的还是旧桥（activity=null），分享照样发不出去。
        if (warmed) {
            QrBridge bridge = WebViewWarmup.bridge();
            if (bridge != null) {
                bridge.attach(this);
            } else {
                // 兜底：拿不到预热桥（理论上不该发生），退而求其次重新绑一个
                webView.addJavascriptInterface(new QrBridge(this, webView), "EBQr");
            }
        } else {
            webView.addJavascriptInterface(new QrBridge(this, webView), "EBQr");
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // 首页的视频流、封面大图全部丢掉：用户看不到，却最耗流量
                if (isHeavyMedia(request.getUrl().toString())) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }

            /**
             * 抖音的二次验证（「用抖音 App 扫码辅助」「去 App 确认」）会跳到自定义 scheme。
             * 不接管的话 WebView 只会报 ERR_UNKNOWN_URL_SCHEME，用户点完屏幕毫无反应，
             * 在他看来就是「这个验证走不下去、很麻烦」。这里交给系统、由抖音 App 接住。
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")
                        || url.startsWith("about:") || url.startsWith("data:")) {
                    return false;   // 正常网页，让 WebView 自己加载
                }
                return openExternal(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // 注意：这里不再注入「全局隐藏」样式。
                // 隐藏规则改为跟着遮罩一起注入（见 login_mask.js），遮罩没建出来就绝不藏内容，
                // 否则遮罩一旦注入失败，页面会被藏成一片全黑。
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // 尽早注入遮罩，避免抖音首页内容绘制出来
                showSimplifiedLogin();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                showSimplifiedLogin();
                // 抖音是 SPA，登录入口可能晚于页面加载完成才渲染，多补几次注入
                handler.postDelayed(LoginActivity.this::reinject, 1500);
                handler.postDelayed(LoginActivity.this::reinject, 4000);
                handler.postDelayed(LoginActivity.this::reinject, 8000);
            }
        });
        // 把页面里的 console 输出转到 logcat：遮罩脚本若有 JS 报错，这里能第一时间看到
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                // 让「等」变得可见：加载抖音首页时进度会一路爬到 90 多再停住，
                // 至少用户知道没卡死，而不是盯着一个不动的圈。
                if (!revealed && loadingText != null) {
                    loadingText.setText(getString(R.string.login_progress, newProgress));
                }
            }

            /**
             * WebView 默认拒绝页面要摄像头/麦克风。抖音的扫脸、扫码辅助都要摄像头，
             * 不授权用户就卡在验证那一步，页面上还什么提示都没有。
             * 页面级授权之外，系统层面的 CAMERA 权限也得先拿到。
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                String[] res = request.getResources();
                boolean needCamera = false;
                for (String r : res) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        needCamera = true;
                        break;
                    }
                }
                if (!needCamera) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(android.Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED) {
                    request.grant(res);
                    return;
                }
                // 页面这一次请求先挂起，等系统权限弹窗的结果回来再补授权
                pendingPermission = request;
                requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA);
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage msg) {
                android.util.Log.i(TAG, "console: " + msg.message()
                        + " @" + msg.sourceId() + ":" + msg.lineNumber());
                return true;
            }
        });
        if (warmed) {
            // 热启动：页面在后台已经加载过，遮罩脚本也注入了。确认一次它还在，
            // 不在就退回冷启动（抖音可能跳走了、或者预热被系统杀掉过）。
            webView.evaluateJavascript("!!document.getElementById('__eb_mask')", value -> {
                if (isFinishing() || isDestroyed() || webView == null) {
                    return;
                }
                if (!"true".equals(value)) {
                    android.util.Log.w(TAG, "预热的页面没有遮罩，退回冷启动");
                    webView.loadUrl(DOUYIN_URL);
                }
            });
            // 加载早就完成了，onPageFinished 不会再回调，手动补一次注入 + 揭开封面
            handler.postDelayed(this::reinject, 200);
        } else {
            webView.loadUrl(DOUYIN_URL);
        }

        findViewById(R.id.btn_cancel).setOnClickListener(v -> finish());
        handler.postDelayed(loginWatcher, 1000);

        if (DEBUG_DOM) {
            handler.postDelayed(dumpRunnable, 3000);
        }

        // 兜底：15 秒还没走到登录遮罩，就明确告诉用户失败了。
        // 以前这里是「把封面揭开」，结果是把人直接丢进抖音信息流——既莫名其妙又费流量，
        // 用户还以为 App 坏了。现在改成停在自己的失败页上，给他一个「重新加载」。
        if (isLoggedIn()) {
            hideCover();
        } else {
            handler.postDelayed(this::onLoadTimeout, LOAD_TIMEOUT_MS);
        }
    }

    /** 加载超时：不要再转圈，显示失败原因和重试按钮。 */
    private void onLoadTimeout() {
        if (revealed || isFinishing() || isDestroyed() || retryBtn == null) {
            return;
        }
        loadingText.setText(R.string.login_timeout);
        retryBtn.setVisibility(android.view.View.VISIBLE);
    }

    /**
     * 退出登录页：把 WebView 还给预热池。
     *
     * <p>用户登完、或者中途放弃退出，这个 WebView 里的抖音页面和登录态都还有用 ——
     * 下次再进登录页直接就是热的。不还的话每次都要重新等那 8~12 秒风控挑战。
     * 已经在登录成功路上的不用管：CookieManager 是进程级的，登录态早就落盘了。
     */
    @Override
    protected void onDestroy() {
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            WebViewWarmup.recycle(webView);
            webView = null;
        }
        super.onDestroy();
    }

    /** 重新加载抖音首页：状态复位后重新走一遍，超时计时也重新开始。 */
    private void reload() {
        if (webView == null) {
            return;
        }
        revealed = false;
        revealScheduled = false;
        maskConfirmTries = 0;
        retryBtn.setVisibility(android.view.View.GONE);
        loadingText.setText(R.string.login_loading);
        webView.loadUrl(DOUYIN_URL);
        handler.postDelayed(this::onLoadTimeout, LOAD_TIMEOUT_MS);
    }

    /** 读取 assets 下的文本文件（UTF-8），失败返回 null。 */
    private String readAsset(String name) {
        try (java.io.InputStream in = getAssets().open(name);
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        } catch (Exception e) {
            android.util.Log.e(TAG, "readAsset(" + name + ") 失败", e);
            return null;
        }
    }

    /**
     * WebView 一直可见、在封面下正常渲染；这里只在「遮罩确认已稳定绘制」后揭开封面。
     * 关键：不能只判断 #__eb_mask 节点是否存在就揭开 —— 节点存在 ≠ 已绘制，
     * 那中间的一帧/一段时间会把抖音首页露出来（闪帧）。
     */
    private void scheduleReveal() {
        if (revealed || revealScheduled) {
            return;
        }
        revealScheduled = true;
        confirmMaskThenReveal();
    }

    private void confirmMaskThenReveal() {
        if (revealed || isFinishing() || isDestroyed() || webView == null) {
            return;
        }
        webView.evaluateJavascript("!!document.getElementById('__eb_mask')", value -> {
            if (revealed || isFinishing() || isDestroyed()) {
                return;
            }
            if ("true".equals(value)) {
                maskConfirmTries++;
                // 连续两次确认（间隔 300ms）说明遮罩已稳定在 DOM 里，可以揭开
                if (maskConfirmTries >= 2) {
                    hideCover();
                    return;
                }
            } else {
                maskConfirmTries = 0;
            }
            if (maskConfirmTries < 60) {
                handler.postDelayed(this::confirmMaskThenReveal, 300);
            } else {
                android.util.Log.w("LoginMask", "确认遮罩超时，兜底揭开封面");
                hideCover();
            }
        });
    }

    /** 揭开不透明封面，露出底下的遮罩。 */
    private void hideCover() {
        if (revealed || isFinishing() || webView == null) {
            return;
        }
        revealed = true;
        loadingView.setVisibility(android.view.View.GONE);
    }

    // 页面内的「快捷登录 / 网页登录」切换已在 0.8.4 整套删除，登录流程完全由
    // assets/login_mask.js 自己控制（盖遮罩 → 代点登录 → 顶起弹窗 → 自动出码）。
    // Java 侧不需要 JS 桥，也不重载页面。

    private void reinject() {
        if (!isFinishing() && webView != null) {
            showSimplifiedLogin();
        }
    }

    /** 是否已经拿到抖音登录态。 */
    private boolean isLoggedIn() {
        String cookie = CookieManager.getInstance().getCookie(DOUYIN_URL);
        if (cookie == null || !cookie.contains("sessionid")) {
            return false;
        }
        // 命中登录态就立刻落盘。
        // WebView 的 Cookie 是懒写盘的，进程被系统回收时可能还没写下去，
        // 下次进 App 就成了「未登录」——用户又得重新过一遍抖音的安全验证
        // （短信 / APP 辅助 / 扫脸）。这是「明明登录过又要重登」的常见原因。
        if (!cookieFlushed) {
            cookieFlushed = true;
            CookieManager.getInstance().flush();
        }
        return true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 离开页面也补一次：用户登完直接按 Home / 返回，未必走 isLoggedIn 那条路。
        if (webView != null) {
            CookieManager.getInstance().flush();
        }
    }

    /**
     * 判断是否为「只用于展示首页信息流」的大流量资源。
     *
     * 只拦视频，不拦图片：
     *  - 视频是流量大头（单条几 MB），登录弹窗完全不需要它；
     *  - 图片必须放行。网页登录模式的二维码就在 douyinpic 上，拦掉就是一页空白；
     *    而且「快捷 / 网页」两个模式现在是原地切换、不重载页面，
     *    被丢弃的图片不会因为切了个模式就自己回来。
     * 代价是遮罩期间会多下一些信息流封面图，用这点流量换「切换零等待」是划算的。
     */
    private boolean isHeavyMedia(String url) {
        String u = url.toLowerCase();
        // 埋点 / 监控上报：和登录毫无关系，但数量很多，丢掉能明显减少请求数
        if (u.contains("mon.zijieapi.com") || u.contains("mcs.zijieapi.com")
                || u.contains("log.snssdk.com") || u.contains("mon.snssdk.com")) {
            return true;
        }
        // 视频 CDN 与视频后缀
        if (u.contains("douyinvod")) {
            return true;
        }
        String[] exts = {".mp4", ".m3u8", ".ts", ".webm", ".flv"};
        for (String ext : exts) {
            int at = u.indexOf(ext);
            if (at >= 0) {
                int after = at + ext.length();
                if (after == u.length() || u.charAt(after) == '?' || u.charAt(after) == '#') {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 在抖音网页上盖一层简洁的登录遮罩：隐藏首页所有视频内容（防误触），只留一个大按钮。
     * 点按钮时代为点击抖音自己的「登录」入口，官方登录弹窗（短信/密码）弹出后
     * 会被顶到遮罩之上正常操作；遮罩本身始终保留，视频不会露出来。已登录则不注入。
     */
    private void showSimplifiedLogin() {
        if (isLoggedIn()) {
            return;
        }

        // 能走到这里说明页面正常，把可能出现的「超时重试」状态收回去
        if (retryBtn != null) {
            retryBtn.setVisibility(android.view.View.GONE);
        }

        // 脚本放在 assets/login_mask.js：拼字符串曾导致静默 SyntaxError（整个遮罩不执行、页面全黑），
        // 独立成文件后可以用 `node --check` 校验语法。
        // 缓存到字段：onPageCommitVisible / onPageFinished / 三次补注入都会走到这里，
        // 每次都读一遍 assets 是主线程 IO，全部堆在页面加载的关键路径上。
        if (maskJs == null) {
            maskJs = readAsset("login_mask.js");
        }
        String js = maskJs;
        if (js == null) {
            android.util.Log.e(TAG, "assets/login_mask.js 读取失败");
            return;
        }
        webView.evaluateJavascript("window.__ebDark=" + (darkMode ? "true" : "false") + ";", null);
        webView.evaluateJavascript(js, null);
        // 遮罩确认稳定绘制后再揭开封面，用户全程看不到抖音首页
        scheduleReveal();
    }

    /**
     * 把 intent:// / snssdk1128:// / aweme:// 这类自定义 scheme 交给系统处理，
     * 由抖音 App 接住（常见于「去 App 确认」「用抖音扫码辅助」这类二次验证）。
     *
     * <p>接管之前，WebView 遇到这些 scheme 只会抛 ERR_UNKNOWN_URL_SCHEME 并停在那里，
     * 用户看到的就是「点了没反应」。接管之后即使没装抖音，至少会明确提示一句，
     * 而不是让人对着一个白屏猜。
     */
    private boolean openExternal(String url) {
        try {
            Intent intent;
            if (url.startsWith("intent://")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            }
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            startActivity(intent);
            return true;
        } catch (Exception e) {
            android.util.Log.w(TAG, "跳转外部 App 失败: " + url, e);
            android.widget.Toast.makeText(this, "这一步需要抖音 App 才能完成，请先安装抖音",
                    android.widget.Toast.LENGTH_LONG).show();
            return true;
        }
    }

    /** 系统相机权限的结果回来了：把挂起的页面请求补上授权或拒绝。 */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        PermissionRequest pr = pendingPermission;
        pendingPermission = null;
        if (pr == null) {
            return;
        }
        try {
            if (granted) {
                pr.grant(pr.getResources());
            } else {
                pr.deny();
                android.widget.Toast.makeText(this, "没有相机权限，抖音的验证没法完成",
                        android.widget.Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            android.util.Log.w(TAG, "页面权限授权失败", e);
        }
    }

    /**
     * 诊断探针：把当前页面的关键 DOM 信息打到 logcat（tag=LoginDump），
     * 用于定位「点登录后整页全黑」的根因。
     * 重点看 hit= 命中的是谁、#__eb_mask 还在不在、body 直接子节点的可见性与层叠。
     */
    private final Runnable dumpRunnable = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed() || webView == null) {
                return;
            }
            dumpTick++;
            webView.evaluateJavascript(JS_DUMP, value -> {
                if (value == null || "null".equals(value)) {
                    android.util.Log.i(TAG, "===== #" + dumpTick + " <no value> =====");
                    return;
                }
                String s = value;
                try {
                    // evaluateJavascript 回调给的是 JSON 字符串字面量，这里还原成原始文本
                    s = new org.json.JSONArray("[" + value + "]").getString(0);
                } catch (Exception ignored) {
                }
                android.util.Log.i(TAG, "===== #" + dumpTick + " =====");
                for (String line : s.split("\n")) {
                    android.util.Log.i(TAG, line);
                }
            });
            if (dumpTick < 60) {
                handler.postDelayed(this, 2000);
            }
        }
    };

    private static final String JS_DUMP =
            "(function(){try{var o=[];"
                    + "o.push('url='+location.href.slice(0,80));"
                    + "var m=document.getElementById('__eb_mask');"
                    + "o.push('nodes mask='+!!m+' style='+!!document.getElementById('__eb_style')"
                    + "+' hide='+!!document.getElementById('__eb_hide'));"
                    + "if(m){var ms=getComputedStyle(m);var mr=m.getBoundingClientRect();"
                    + "o.push('mask vis='+ms.visibility+' z='+ms.zIndex+' op='+ms.opacity"
                    + "+' pe='+ms.pointerEvents"
                    + "+' rect='+Math.round(mr.width)+'x'+Math.round(mr.height)"
                    + "+' kids='+m.childElementCount);}"
                    + "o.push('bodyBg='+getComputedStyle(document.body).backgroundColor);"
                    + "function hit(x,y){var e=document.elementFromPoint(x,y);if(!e)return 'null';"
                    + "return e.tagName+'#'+(e.id||'-')+'.'+String(e.className||'').slice(0,28);}"
                    + "var w=innerWidth,h=innerHeight;"
                    + "o.push('hit center='+hit(w/2,h/2));"
                    + "o.push('hit top='+hit(w/2,h*0.10));"
                    + "o.push('hit upper='+hit(w/2,h*0.34));"
                    + "o.push('hit lower='+hit(w/2,h*0.78));"
                    + "var ks=document.body.children;"
                    + "o.push('bodyChildren='+ks.length);"
                    + "for(var i=0;i<ks.length&&i<20;i++){var k=ks[i];var st=getComputedStyle(k);"
                    + "var r=k.getBoundingClientRect();"
                    + "o.push(i+' <'+k.tagName+'> id='+k.id+' cls='+String(k.className||'').slice(0,36)"
                    + "+' pos='+st.position+' z='+st.zIndex+' vis='+st.visibility+' op='+st.opacity"
                    + "+' dsp='+st.display+' wh='+Math.round(r.width)+'x'+Math.round(r.height)"
                    + "+' kids='+k.childElementCount"
                    + "+' txt='+String(k.textContent||'').replace(/\\s+/g,' ').slice(0,42));}"
                    + "return o.join('\\n');}catch(e){return 'ERR '+e.message;}})();";

    /** 每秒查一次 Cookie，检测到登录态就自动返回首页。 */
    private final Runnable loginWatcher = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) {
                return;
            }
            if (isLoggedIn()) {
                finish();
                return;
            }
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
