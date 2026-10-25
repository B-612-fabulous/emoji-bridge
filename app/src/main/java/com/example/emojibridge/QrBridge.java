package com.example.emojibridge;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import com.example.emojibridge.util.AlbumSaver;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 把登录页里的抖音二维码存进系统相册 / 发到另一台手机。
 *
 * <p>为什么需要它：验证码登录在陌生设备上会被抖音判为高风险，要求人脸或扫码。
 * 而「扫码登录」本身是抖音为桌面网页设计的通道——用已登录的抖音 App 扫码，
 * 等于用本人设备证明身份，不会再走验证。
 *
 * <p>2026-10-20 真机实测的正确流程（用户定的）：
 * 把二维码**发到另一台手机**（微信 / QQ / 系统分享）→ 那台手机打开图片 →
 * 用**本机抖音**扫那块屏幕。另一台手机只是显示器，不用装抖音、不用登录。
 * 反过来「存进相册再在抖音里选图」会被抖音明确拒绝（要求必须来自摄像头），
 * 所以 {@link #share(String)} 才是主路径，{@link #save(String)} 只作兜底。
 *
 * <p>WebView 里没法直接触发下载（data: URL 不行、跨域图存不了），所以走 JS 桥：
 * 页面把二维码的 data URL 或 http 地址传过来，这里负责解码或带 cookie 下载。
 */
public final class QrBridge {

    private static final String TAG = "EBQrBridge";
    /** 二维码图不会超过这个量级，超了直接拒，避免被塞垃圾数据。 */
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    /**
     * 分享出去的图至少这么大。抖音给的码常常只有 200~300px，
     * 微信/QQ 转发会再压一道，到另一台手机上糊成一团就扫不动了。
     * 用最近邻放大（filter=false）把像素块放大，边缘仍然锐利，反而更好扫。
     */
    private static final int MIN_SHARE_SIDE = 900;
    /** 分享出去的文件名（用户能在系统分享面板 / 微信 / QQ 上直接看到）。 */
    private static final String SHARE_NAME = "抖音登录二维码";

    /**
     * 宿主 Activity。预热阶段没有 Activity（WebView 用 ApplicationContext 创建），
     * 所以这里是可空、可更新的：预热时传 null 占位，登录页 {@code take()} 之后再
     * 用 {@link #attach(Activity)} 补上真实 Activity。share/openApp/save 这三个方法
     * 只会在用户真正进入登录页后才会被页面调用，那时 activity 一定已经补上了。
     */
    private volatile Activity activity;
    private final WebView webView;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    public QrBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** 登录页复用预热 WebView 后调用，把真实 Activity 补进来（预热时是 null）。 */
    public void attach(Activity activity) {
        this.activity = activity;
    }

    /**
     * 保存二维码。payload 两种形式：
     * <ul>
     *   <li>{@code data:image/png;base64,...} —— 页面已经画好位图</li>
     *   <li>{@code https://...} —— 跨域图片，页面读不了像素，交给我们带着 cookie 下</li>
     * </ul>
     */
    @JavascriptInterface
    public void save(final String payload) {
        if (payload == null || payload.isEmpty()) {
            callback(false, "没有拿到二维码");
            return;
        }
        final Activity host = activity;
        if (host == null) {
            callback(false, "保存功能还没就绪");
            return;
        }
        pool.execute(() -> {
            try {
                byte[] png = load(payload);
                if (png == null || png.length < 64) {
                    callback(false, "二维码下载失败");
                    return;
                }
                if (png.length > MAX_BYTES) {
                    callback(false, "二维码图片过大");
                    return;
                }
                String name = "douyin_qr_" + System.currentTimeMillis() + ".png";
                // 单独放 Pictures/抖音二维码：用户去相册找「刚存的那张」时好认
                Uri uri = AlbumSaver.save(host, png, name, "image/png", "抖音二维码");
                if (uri == null) {
                    callback(false, "写入相册失败");
                } else {
                    Log.i(TAG, "二维码已存相册: " + uri);
                    callback(true, "已保存到相册");
                }
            } catch (Exception e) {
                Log.w(TAG, "保存二维码失败", e);
                callback(false, e.getMessage() == null ? "保存失败" : e.getMessage());
            }
        });
    }

    /**
     * 把二维码发到另一台手机：写进 cache/shared，再用系统分享面板发出去。
     *
     * <p>用 FileProvider 而不是直接 file:// —— targetSdk 24+ 传 file:// 会抛
     * FileUriExposedException，分享面板直接弹不出来。FileProvider 已经把
     * cache/shared 授权好了（见 res/xml/file_paths.xml）。
     */
    @JavascriptInterface
    public void share(final String payload) {
        if (payload == null || payload.isEmpty()) {
            shareCallback(false, "没有拿到二维码");
            return;
        }
        final Activity host = activity;
        if (host == null) {
            shareCallback(false, "分享功能还没就绪");
            return;
        }
        pool.execute(() -> {
            try {
                byte[] png = load(payload);
                if (png == null || png.length < 64) {
                    shareCallback(false, "二维码下载失败");
                    return;
                }
                if (png.length > MAX_BYTES) {
                    shareCallback(false, "二维码图片过大");
                    return;
                }
                png = upscale(png);

                File dir = new File(host.getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) {
                    shareCallback(false, "创建临时目录失败");
                    return;
                }
                // 上一轮的码已经过期了，留着只会把缓存越堆越大
                File[] olds = dir.listFiles((d, n) -> n.startsWith(SHARE_NAME));
                if (olds != null) {
                    for (File f : olds) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
                // 文件名会直接显示在系统分享面板 / 微信 / QQ 的文件标题上。
                // 以前叫 eb_qr_1759xxxx.png，用户点完「发到另一台手机」看到的就是这串乱码，
                // 根本不知道发出去的是什么。改成中文名，一眼就懂。
                File out = new File(dir, SHARE_NAME + ".png");
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(png);
                }
                Uri uri = FileProvider.getUriForFile(host,
                        BuildConfig.APPLICATION_ID + ".fileprovider", out);

                final String hint = "抖音登录二维码：在另一台手机上打开这张图，"
                        + "再用本机抖音「扫一扫」扫那块屏幕";
                host.runOnUiThread(() -> {
                    if (host.isFinishing() || host.isDestroyed()) {
                        return;
                    }
                    try {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType("image/png");
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.putExtra(Intent.EXTRA_TEXT, hint);
                        // ClipData 也要给：部分国产 ROM 只读 EXTRA_STREAM 拿不到授权
                        send.setClipData(ClipData.newRawUri("qr", uri));
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                        Intent chooser = Intent.createChooser(send, "发到另一台手机");
                        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        host.startActivity(chooser);
                        Log.i(TAG, "二维码已交给系统分享: " + uri);
                        shareCallback(true, "已发出");
                    } catch (Exception e) {
                        Log.w(TAG, "系统分享失败", e);
                        shareCallback(false, "没有可用的分享方式");
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "分享二维码失败", e);
                shareCallback(false, e.getMessage() == null ? "分享失败" : e.getMessage());
            }
        });
    }

    /**
     * 直接拉起抖音 App。
     *
     * <p>为什么值得单独一个按钮：扫码的最后三步（退到桌面 → 找抖音图标 →
     * 点右上角「扫一扫」）全在手机系统层，用户每多一步就多一分流失。
     * 这里一步到位，他只需要在抖音里点「扫一扫」。
     *
     * <p>Android 11+ 的包可见性：没有在 manifest 里声明 {@code <queries>} 的话，
     * 系统会告诉我们「没有这个应用」，哪怕用户装着抖音。
     * 这条 0.7.8 补 WebView 二次验证时已经加过了。
     */
    @JavascriptInterface
    public void openApp() {
        final Activity host = activity;
        if (host == null) {
            appCallback(false, "还没就绪");
            return;
        }
        host.runOnUiThread(() -> {
            if (host.isFinishing() || host.isDestroyed()) {
                return;
            }
            try {
                Intent intent = host.getPackageManager()
                        .getLaunchIntentForPackage("com.ss.android.ugc.aweme");
                if (intent == null) {
                    Log.w(TAG, "找不到抖音 App");
                    appCallback(false, "没安装抖音");
                    return;
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                host.startActivity(intent);
                Log.i(TAG, "已拉起抖音");
                appCallback(true, null);
            } catch (Exception e) {
                Log.w(TAG, "拉起抖音失败", e);
                appCallback(false, e.getMessage() == null ? "打不开" : e.getMessage());
            }
        });
    }

    /** 小于 {@link #MIN_SHARE_SIDE} 的码按整数倍放大（最近邻，保持锐利）。失败就原样返回。 */
    private static byte[] upscale(byte[] png) {
        try {
            Bitmap src = BitmapFactory.decodeByteArray(png, 0, png.length);
            if (src == null) {
                return png;
            }
            int w = src.getWidth();
            if (w <= 0 || w >= MIN_SHARE_SIDE) {
                src.recycle();
                return png;
            }
            int times = (int) Math.ceil((double) MIN_SHARE_SIDE / w);
            if (times > 6) {
                times = 6;      // 300px 的码放大 3 倍就够，再大只是浪费流量
            }
            Bitmap big = Bitmap.createScaledBitmap(
                    src, src.getWidth() * times, src.getHeight() * times, false);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            big.compress(Bitmap.CompressFormat.PNG, 100, out);
            if (big != src) {
                big.recycle();
            }
            src.recycle();
            byte[] result = out.toByteArray();
            return result.length > 0 && result.length <= MAX_BYTES ? result : png;
        } catch (Throwable e) {
            Log.w(TAG, "放大二维码失败，用原图", e);
            return png;
        }
    }

    private byte[] load(String payload) throws Exception {
        if (payload.startsWith("data:")) {
            int comma = payload.indexOf(',');
            if (comma < 0) {
                return null;
            }
            String head = payload.substring(0, comma);
            String body = payload.substring(comma + 1);
            if (head.indexOf("base64") >= 0) {
                return Base64.decode(body, Base64.DEFAULT);
            }
            // 非 base64 的 data URL：URL 编码的字节流（二维码不会走这条，兜底而已）
            return body.getBytes("UTF-8");
        }
        if (!payload.startsWith("http://") && !payload.startsWith("https://")) {
            return null;
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(payload).openConnection();
        try {
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            // 带上 WebView 的 cookie：二维码接口有时要求登录态
            String cookie = CookieManager.getInstance().getCookie(payload);
            if (cookie != null && !cookie.isEmpty()) {
                conn.setRequestProperty("Cookie", cookie);
            }
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                            + "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
            try (InputStream in = conn.getInputStream();
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_BYTES) {
                        return null;
                    }
                }
                return out.toByteArray();
            }
        } finally {
            conn.disconnect();
        }
    }

    private void callback(final boolean ok, final String message) {
        evaluate("window.__ebQrResult&&window.__ebQrResult(" + ok + "," + quote(message) + ")");
    }

    private void shareCallback(final boolean ok, final String message) {
        evaluate("window.__ebQrShareResult&&window.__ebQrShareResult("
                + ok + "," + quote(message) + ")");
    }

    private void appCallback(final boolean ok, final String message) {
        evaluate("window.__ebOpenAppResult&&window.__ebOpenAppResult("
                + ok + "," + quote(message) + ")");
    }

    private void evaluate(final String js) {
        if (webView == null) {
            return;
        }
        webView.post(() -> {
            if (activity != null && (activity.isFinishing() || activity.isDestroyed())) {
                return;
            }
            webView.evaluateJavascript(js, null);
        });
    }

    private static String quote(String s) {
        if (s == null) {
            return "''";
        }
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'")
                .replace("\n", " ").replace("\r", " ") + "'";
    }
}
