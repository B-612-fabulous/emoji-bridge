package com.example.emojibridge;

import android.content.Context;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;

/**
 * 抖音登录页的后台预热。
 *
 * <p>为什么需要它：抖音的二维码不是点开登录框就有的 —— 实测面板出来后还要再等
 * 8~12 秒（它先走一轮风控挑战才去请求码）。这十几秒用户是盯着屏幕干等的，
 * 而且他什么都不能做。整套登录流程里，这是唯一一段纯粹的空等。
 *
 * <p>做法：首页还把着界面的时候，就在一个看不见的 WebView 里先把抖音首页跑起来，
 * 让页面加载、登录框自动打开、风控挑战、取码全都先在后台发生。用户点「去登录」时
 * 把那个 WebView 整个搬进登录页（见 {@link #take()}），码基本已经在那儿了。
 *
 * <p>三个关键细节：
 * <ul>
 *   <li><b>容器要铺满、alpha 设 0</b>：不能用 1x1 占位。WebView 的布局视口就是它的
 *       宽度，1x1 会让抖音的 980px 桌面布局被缩成一条线，遮罩的反向缩放会算错。</li>
 *   <li><b>放在内容下层</b>：alpha=0 的 WebView 仍然会吃触摸，必须让它挂在界面
 *       内容的<b>下面</b>（布局里的第一个子节点），上面的标题栏 / 页面 / 底栏才会
 *       先拿到点击。</li>
 *   <li><b>用 ApplicationContext</b>：主题切换会重建首页，用 Activity 上下文会把
 *       已经销毁的 Activity 泄漏在静态字段里。</li>
 * </ul>
 *
 * <p>预热的页面是「不可见」的，所以 login_mask.js 在里面照常跑：自动点登录入口、
 * 自动切扫码 tab、自动打开二维码卡片。等用户真进来时，看到的就是最终状态。
 * 万一预热失败（没网、被系统杀），登录页会退回原来的冷启动路径，不会有别的影响。
 */
public final class WebViewWarmup {

    private static final String TAG = "EBWarmup";
    private static final String URL = "https://www.douyin.com/";
    /** 超过这个时间就重新预热：抖音的风控状态会过期，冷了还不如重来。 */
    private static final long TTL_MS = 4 * 60 * 1000;

    private static WebView sWeb;
    private static long sBornAt;
    private static WeakReference<ViewGroup> sHost;
    /** 预热 WebView 上绑的 JS 桥（activity 为 null，登录页 take 后 attach 补上）。 */
    private static QrBridge sBridge;

    private WebViewWarmup() {
    }

    /**
     * 首页调：确保有一个预热中的 WebView，并且挂在给定的容器上。
     *
     * @param host 一个铺满屏幕、alpha=0、位于内容下层的容器（见类注释）
     */
    public static void prepare(Context context, ViewGroup host) {
        if (host == null) {
            return;
        }
        sHost = new WeakReference<>(host);
        if (sWeb != null) {
            if (System.currentTimeMillis() - sBornAt > TTL_MS) {
                release();          // 太旧了，风控状态大概已经过期
            } else {
                attach(host);
                return;
            }
        }
        try {
            WebView v = new WebView(context.getApplicationContext());
            config(v);
            // 关键：预热阶段就把 JS 桥绑上（activity 先传 null 占位）。
            // addJavascriptInterface 只对「之后新创建的页面上下文」生效 ——
            // 若等到登录页 take() 之后再绑，预热的页面已经加载完，页面里
            // window.EBQr 会是 undefined，「发到另一台手机」就发不出去。
            // 桥里的 activity 等登录页 take() 后再 attach 补上真实 Activity。
            QrBridge bridge = new QrBridge(null, v);
            v.addJavascriptInterface(bridge, "EBQr");
            sBridge = bridge;
            v.setWebViewClient(new Client());
            v.loadUrl(URL);
            sWeb = v;
            sBornAt = System.currentTimeMillis();
            attach(host);
            android.util.Log.i(TAG, "抖音登录页开始后台预热");
        } catch (Throwable t) {
            android.util.Log.w(TAG, "预热失败（不影响登录，只是不省那十几秒）", t);
            release();
        }
    }

    /** 登录页调：把预热好的 WebView 取走。取走就由登录页全权负责它的生命周期。 */
    public static WebView take() {
        WebView v = sWeb;
        if (v != null) {
            ViewGroup p = (ViewGroup) v.getParent();
            if (p != null) {
                p.removeView(v);
            }
        }
        sWeb = null;
        return v;
    }

    /** 预热 WebView 上绑的桥。登录页 take() 后用它 attach 真实 Activity。 */
    public static QrBridge bridge() {
        return sBridge;
    }

    /** 登录页退出时还回来：用户退出登录再进来，又是热的。 */
    public static void recycle(WebView v) {
        if (v == null) {
            return;
        }
        // 保下这个 WebView 上挂着的桥：release() 会把 sBridge 清掉，
        // 但 v 本身还活着、桥还在它上面，下次 take 还要用同一个桥 attach。
        QrBridge keep = sBridge;
        release();
        sWeb = v;
        sBridge = keep;
        sBornAt = System.currentTimeMillis();
        ViewGroup host = sHost == null ? null : sHost.get();
        if (host != null) {
            attach(host);
        }
    }

    /** 从容器上摘下来（首页销毁时调）：WebView 本身留着，下次再挂上去。 */
    public static void detach() {
        if (sWeb == null) {
            return;
        }
        ViewGroup p = (ViewGroup) sWeb.getParent();
        if (p != null) {
            p.removeView(sWeb);
        }
    }

    public static boolean hasWarm() {
        return sWeb != null;
    }

    /** 彻底销毁：进程要退出、或者预热失败时用。 */
    public static void release() {
        if (sWeb == null) {
            return;
        }
        ViewGroup p = (ViewGroup) sWeb.getParent();
        if (p != null) {
            p.removeView(sWeb);
        }
        try {
            sWeb.loadUrl("about:blank");
            sWeb.stopLoading();
            sWeb.destroy();
        } catch (Throwable ignored) {
        }
        sWeb = null;
        sBridge = null;
    }

    private static void attach(ViewGroup host) {
        if (sWeb == null) {
            return;
        }
        ViewGroup p = (ViewGroup) sWeb.getParent();
        if (p == host) {
            return;
        }
        if (p != null) {
            p.removeView(sWeb);
        }
        try {
            host.removeAllViews();
            host.addView(sWeb, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } catch (Throwable t) {
            android.util.Log.w(TAG, "挂载预热 WebView 失败", t);
        }
    }

    /** 和 LoginActivity 用同一套设置 —— 否则搬过去之后视口 / UA 会变，页面要重排。 */
    private static void config(WebView v) {
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 桌面版 UA：移动 UA 下抖音只给「下载抖音看更多」，没有任何登录入口（实测）
        s.setUserAgentString(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                        + "Chrome/122.0.0.0 Safari/537.36");
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(v, true);
    }

    /**
     * 预热自己的 WebViewClient：只负责把遮罩脚本注入进去。
     * 登录页取走这个 WebView 后会换上它自己的 client（多一个资源拦截），
     * 注入逻辑两边是同一份代码，重复注入也有早退分支，不会叠加。
     */
    private static final class Client extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // 视频 / 埋点照旧丢掉：后台渲染同样在费流量
            String u = request.getUrl().toString().toLowerCase();
            if (u.contains("douyinvod") || u.contains("mon.zijieapi.com")
                    || u.contains("mcs.zijieapi.com") || u.contains("log.snssdk.com")
                    || u.contains("mon.snssdk.com")) {
                return new WebResourceResponse("text/plain", "utf-8",
                        new ByteArrayInputStream(new byte[0]));
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            inject(view);
        }

        private void inject(WebView view) {
            try {
                String js = readAsset(view.getContext(), "login_mask.js");
                if (js == null) {
                    return;
                }
                view.evaluateJavascript("window.__ebDark=false;", null);
                view.evaluateJavascript(js, null);
            } catch (Throwable t) {
                android.util.Log.w(TAG, "预热注入遮罩失败", t);
            }
        }
    }

    private static String readAsset(Context ctx, String name) {
        try (InputStream in = ctx.getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }
}
