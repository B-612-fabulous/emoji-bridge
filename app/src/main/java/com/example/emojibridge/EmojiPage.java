package com.example.emojibridge;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.example.emojibridge.convert.StickerConverter;
import com.example.emojibridge.model.EmojiItem;
import com.example.emojibridge.net.DouyinApi;
import com.example.emojibridge.util.AlbumSaver;
import com.example.emojibridge.util.ImageStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 「表情」页的全部逻辑（宿主是 MainActivity 的一个页面视图）。
 *
 * <p>速度上的两处改动：
 * <ul>
 *   <li>原图 / 转换后的 GIF 都落本机缓存：第二次保存或转发不再走网络，直接秒出；</li>
 *   <li>选多张时用 3 路并行下载 + 转换，不再是串行一张一张等。</li>
 * </ul>
 */
class EmojiPage {

    private static final String DOUYIN_URL = "https://www.douyin.com/";
    /** 微信包名：指定它就能跳过系统的「选择应用」面板，直达微信的「发送给朋友」。 */
    private static final String WECHAT_PACKAGE = "com.tencent.mm";
    /** 并行下载路数。 */
    private static final int PARALLEL = 3;

    private final AppCompatActivity activity;
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final ExecutorService pool = Executors.newFixedThreadPool(PARALLEL);
    private final Handler ui = new Handler(Looper.getMainLooper());

    private final TextView statusView;
    private final TextView cacheTimeView;
    private final ProgressBar progressBar;
    private final Button selectAllBtn;
    private final Button albumBtn;
    private final Button sendBtn;
    private final Button refreshBtn;
    private final EmojiAdapter adapter;
    private final List<EmojiItem> items = new ArrayList<>();
    private final RecyclerView recycler;

    private boolean busy;    // 正在保存/转发
    private boolean loading; // 正在拉列表
    private String cookie = "";
    /** 当前列表来自缓存时的时间戳；0 表示刚拉的实时数据。 */
    private long cacheTime;

    EmojiPage(AppCompatActivity activity, View root) {
        this.activity = activity;

        statusView = root.findViewById(R.id.status);
        cacheTimeView = root.findViewById(R.id.cache_time);
        progressBar = root.findViewById(R.id.progress);
        selectAllBtn = root.findViewById(R.id.btn_select_all);
        albumBtn = root.findViewById(R.id.btn_album);
        sendBtn = root.findViewById(R.id.btn_send);
        refreshBtn = root.findViewById(R.id.btn_refresh);
        recycler = root.findViewById(R.id.recycler);

        recycler.setLayoutManager(new GridLayoutManager(activity, 3));
        adapter = new EmojiAdapter(items);
        adapter.setOnSelectionChangedListener(this::onSelectionChanged);
        recycler.setAdapter(adapter);

        selectAllBtn.setOnClickListener(v -> toggleSelectAll());
        albumBtn.setOnClickListener(v -> downloadAll(false));
        sendBtn.setOnClickListener(v -> downloadAll(true));
        refreshBtn.setOnClickListener(v -> refresh());

        updateActionStates();
    }

    void destroy() {
        net.shutdownNow();
        pool.shutdownNow();
    }

    // ---------------------------------------------------------------
    // 重建（切主题）后的状态接续
    // ---------------------------------------------------------------

    List<EmojiItem> getItems() {
        return items;
    }

    long getCacheTime() {
        return cacheTime;
    }

    /** 网格第一张可见表情的位置，用来复原滚动位置。 */
    int getScrollPosition() {
        RecyclerView.LayoutManager lm = recycler.getLayoutManager();
        if (lm instanceof GridLayoutManager) {
            return ((GridLayoutManager) lm).findFirstVisibleItemPosition();
        }
        return 0;
    }

    /**
     * 把重建前的列表、选中态、滚动位置摆回来。
     * 这样切主题只是「换个配色」，不会像刚进页面那样重新拉一遍网络。
     */
    void restore(List<EmojiItem> restored, int scrollPos, long cacheTime) {
        if (restored == null || restored.isEmpty()) {
            return;
        }
        showItems(restored, cacheTime);
        if (scrollPos > 0) {
            recycler.scrollToPosition(scrollPos);
        }
        // 让状态栏文案和按钮可用性跟选中态一致（比如选了多张时要提示只能转发一张）
        adapter.notifySelectionChanged();
    }

    // ---------------------------------------------------------------
    // 拉列表
    // ---------------------------------------------------------------

    /** 切到表情页时调用：已有数据不重复拉；开了缓存开关则先用缓存秒开。 */
    void onShown() {
        if (busy || loading || !items.isEmpty()) {
            return;
        }
        if (!ensureCookie()) {
            showNeedLogin();
            return;
        }
        if (cacheEnabled()) {
            ImageStore.CachedList cached = ImageStore.readList(activity);
            if (cached != null) {
                showItems(cached.items, cached.timeMillis);
                return;
            }
        }
        fetch();
    }

    /** 刷新按钮：无论缓存开关是否打开，都强制重新拉取。 */
    void refresh() {
        if (busy || loading) {
            return;
        }
        if (!ensureCookie()) {
            showNeedLogin();
            return;
        }
        fetch();
    }

    /** 退出登录后清空这一页的状态。 */
    void reset() {
        showNeedLogin();
    }

    private void fetch() {
        loading = true;
        final String c = cookie;
        final DouyinApi api = new DouyinApi(c);

        cacheTimeView.setVisibility(View.GONE);
        progressBar.setIndeterminate(true);
        progressBar.setVisibility(View.VISIBLE);
        statusView.setText(R.string.status_refreshing);

        net.execute(() -> {
            try {
                List<EmojiItem> result = api.fetchAll();
                // 每次都写缓存：这样打开缓存开关时能秒开
                ImageStore.writeList(activity, result);
                ui.post(() -> {
                    loading = false;
                    showItems(result, 0L);
                });
            } catch (Exception e) {
                final String message = e.getMessage() == null
                        ? e.getClass().getSimpleName() : e.getMessage();
                ui.post(() -> {
                    loading = false;
                    progressBar.setIndeterminate(false);
                    progressBar.setVisibility(View.GONE);
                    statusView.setText(activity.getString(R.string.status_error, message));
                    toast(activity.getString(R.string.status_error, message));
                });
            }
        });
    }

    private void showItems(List<EmojiItem> result, long cacheTime) {
        this.cacheTime = cacheTime;
        items.clear();
        items.addAll(result);
        adapter.notifyDataSetChanged();

        progressBar.setIndeterminate(false);
        progressBar.setVisibility(View.GONE);

        if (result.isEmpty()) {
            statusView.setText(R.string.status_empty);
        } else {
            statusView.setText(activity.getString(R.string.status_loaded, result.size()));
        }
        if (cacheTime > 0) {
            cacheTimeView.setText(activity.getString(R.string.cache_time, formatTime(cacheTime)));
            cacheTimeView.setVisibility(View.VISIBLE);
        } else {
            cacheTimeView.setVisibility(View.GONE);
        }
        updateActionStates();
    }

    private void showNeedLogin() {
        cacheTime = 0;
        items.clear();
        adapter.notifyDataSetChanged();
        progressBar.setIndeterminate(false);
        progressBar.setVisibility(View.GONE);
        cacheTimeView.setVisibility(View.GONE);
        statusView.setText(R.string.status_need_login);
        updateActionStates();
    }

    // ---------------------------------------------------------------
    // 保存 / 转发（并行）
    // ---------------------------------------------------------------

    private void downloadAll(boolean forward) {
        final List<EmojiItem> selected = new ArrayList<>();
        for (EmojiItem item : items) {
            if (item.selected) {
                selected.add(item);
            }
        }
        if (selected.isEmpty()) {
            toast(activity.getString(R.string.toast_none_selected));
            return;
        }
        if (!ensureCookie()) {
            showNeedLogin();
            return;
        }

        busy = true;
        updateActionStates();

        final int total = selected.size();
        progressBar.setIndeterminate(false);
        progressBar.setMax(total);
        progressBar.setProgress(0);
        progressBar.setVisibility(View.VISIBLE);
        // 立即反馈，避免用户以为点空了
        statusView.setText(activity.getString(
                forward ? R.string.status_downloading : R.string.status_saving, 0, total));

        final DouyinApi api = new DouyinApi(cookie);
        final AtomicInteger done = new AtomicInteger();
        final AtomicInteger ok = new AtomicInteger();
        final List<Uri> uris = Collections.synchronizedList(new ArrayList<Uri>());

        for (final EmojiItem item : selected) {
            pool.execute(() -> {
                try {
                    byte[] out = loadForExport(api, item);
                    String mime = ImageStore.mimeOf(out);
                    if (forward) {
                        uris.add(writeSharedFile(item.id, out, mime));
                    } else {
                        AlbumSaver.save(activity, out,
                                "douyin_" + item.id + "." + extensionOf(mime), mime);
                    }
                    ok.incrementAndGet();
                } catch (Exception e) {
                    final String message = e.getMessage() == null ? "" : e.getMessage();
                    ui.post(() -> toast(activity.getString(R.string.toast_one_failed, message)));
                }

                final int p = done.incrementAndGet();
                ui.post(() -> {
                    progressBar.setProgress(p);
                    statusView.setText(activity.getString(
                            forward ? R.string.status_downloading : R.string.status_saving, p, total));
                    if (p == total) {
                        finishDownload(forward, uris, ok.get());
                    }
                });
            });
        }
    }

    private void finishDownload(boolean forward, List<Uri> uris, int successCount) {
        progressBar.setVisibility(View.GONE);
        busy = false;
        updateActionStates();

        if (forward) {
            if (uris.isEmpty()) {
                toast(activity.getString(R.string.toast_all_failed));
            } else {
                statusView.setText(R.string.status_sharing);
                forwardToWeChat(new ArrayList<>(uris));
            }
        } else {
            statusView.setText(activity.getString(R.string.status_loaded, items.size()));
            toast(activity.getString(R.string.toast_saved_count, successCount));
        }
    }

    /**
     * 取导出用的字节，三级取用顺序：
     * 转换结果缓存 → 原图缓存 → 网络下载后再转换（并把结果写缓存）。
     */
    private byte[] loadForExport(DouyinApi api, EmojiItem item) throws IOException {
        File gif = ImageStore.gifFile(activity, item.id);
        if (gif.isFile() && gif.length() > 0) {
            return ImageStore.readAll(gif);
        }

        byte[] raw = ImageStore.readRaw(activity, item.url);
        if (raw == null) {
            raw = api.download(item.url).data;
            try {
                ImageStore.writeRaw(activity, item.url, raw);
            } catch (IOException ignore) {
                // 缓存写失败不影响这次导出
            }
        }

        StickerConverter.Result out = StickerConverter.convertIfNeeded(raw, ImageStore.mimeOf(raw));
        if ("image/gif".equals(out.mimeType)) {
            try {
                ImageStore.writeGif(activity, item.id, out.data);
            } catch (IOException ignore) {
                // 同上
            }
        }
        return out.data;
    }

    private Uri writeSharedFile(String id, byte[] data, String mime) throws IOException {
        File dir = new File(activity.getCacheDir(), "shared");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建缓存目录");
        }
        String safeId = id.replaceAll("[^0-9A-Za-z_-]", "");
        File file = new File(dir, "emoji_" + safeId + "." + extensionOf(mime));
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
        return FileProvider.getUriForFile(activity,
                activity.getPackageName() + ".fileprovider", file);
    }

    private void forwardToWeChat(List<Uri> uris) {
        Intent send;
        if (uris.size() == 1) {
            // 微信的「多文件分享」通道只收照片格式、会拒收 GIF，单张必须走 ACTION_SEND
            send = new Intent(Intent.ACTION_SEND);
            send.setType("image/*");
            send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            send = new Intent(Intent.ACTION_SEND_MULTIPLE);
            send.setType("image/*");
            send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(uris));
        }
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        // 先试直达微信：跳过系统「选择应用」面板，点了就进微信的「发送给朋友」
        send.setPackage(WECHAT_PACKAGE);
        try {
            activity.startActivity(send);
            toast(activity.getString(R.string.tip_after_share));
            return;
        } catch (ActivityNotFoundException | SecurityException e) {
            // 没装微信，或者分享入口被微信分身接管 → 退回系统分享面板
            send.setPackage(null);
        }

        Intent chooser = Intent.createChooser(send, activity.getString(R.string.chooser_title));
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            activity.startActivity(chooser);
            toast(activity.getString(R.string.tip_after_share));
        } catch (ActivityNotFoundException e) {
            statusView.setText(activity.getString(R.string.status_loaded, items.size()));
            toast(activity.getString(R.string.toast_no_target));
        }
    }

    // ---------------------------------------------------------------
    // 选中状态
    // ---------------------------------------------------------------

    private void toggleSelectAll() {
        boolean allSelected = true;
        for (EmojiItem item : items) {
            if (!item.selected) {
                allSelected = false;
                break;
            }
        }
        for (EmojiItem item : items) {
            item.selected = !allSelected;
        }
        adapter.notifyDataSetChanged();
        adapter.notifySelectionChanged();
    }

    /**
     * 根据当前选中数刷新操作按钮状态。
     * 微信不支持一次转发多张图片，所以选中 >1 时把「转发到微信」置灰。
     */
    private void updateActionStates() {
        boolean ready = !items.isEmpty() && !busy;
        selectAllBtn.setEnabled(ready);
        albumBtn.setEnabled(ready);
        sendBtn.setEnabled(ready && countSelected() <= 1);
    }

    private int countSelected() {
        int count = 0;
        for (EmojiItem item : items) {
            if (item.selected) {
                count++;
            }
        }
        return count;
    }

    private void onSelectionChanged(int selectedCount) {
        updateActionStates();
        if (selectedCount > 1) {
            statusView.setText(R.string.hint_wechat_multi);
        } else if (!items.isEmpty()) {
            statusView.setText(activity.getString(R.string.status_loaded, items.size()));
        }
    }

    // ---------------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------------

    private boolean cacheEnabled() {
        return activity.getSharedPreferences("ui", AppCompatActivity.MODE_PRIVATE)
                .getBoolean(activity.getString(R.string.cache_pref), false);
    }

    private boolean ensureCookie() {
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        String c = cm.getCookie(DOUYIN_URL);
        cookie = c == null ? "" : c;
        return cookie.contains("sessionid");
    }

    private void toast(String message) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
    }

    private static String formatTime(long millis) {
        return new SimpleDateFormat("M月d日 HH:mm", Locale.CHINA).format(new Date(millis));
    }

    private static String extensionOf(String mime) {
        if (mime == null) {
            return "webp";
        }
        String m = mime.toLowerCase(Locale.ROOT);
        if (m.contains("gif")) return "gif";
        if (m.contains("png")) return "png";
        if (m.contains("jpeg") || m.contains("jpg")) return "jpg";
        if (m.contains("webp")) return "webp";
        return "img";
    }
}
