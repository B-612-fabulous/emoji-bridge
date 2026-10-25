package com.example.emojibridge;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;

import com.example.emojibridge.model.EmojiItem;
import com.google.android.material.bottomnavigation.BottomNavigationView;

import java.util.ArrayList;
import java.util.List;

/**
 * 宿主页：顶部标题栏 + 中间内容区 + 底部三个 tab（首页 / 表情 / 更多）。
 *
 * <p>三个页面用「同一个 Activity 内隐藏/显示」实现，不走 Fragment，
 * 切换更快、也不会因为生命周期重来一遍而重复拉数据。
 *
 * <p><b>关于重建</b>：切换主题会调用 {@code setDefaultNightMode}，系统因此重建整个 Activity。
 * 重建时底部导航栏会自行恢复选中项，但页面内容是 onCreate 里手动 inflate 的、不会恢复，
 * 所以必须自己把「当前 tab」记下来再复原，否则会出现「高亮在表情、内容却是首页」的错位。
 */
public class MainActivity extends AppCompatActivity {

    private static final String DOUYIN_URL = "https://www.douyin.com/";
    /** Activity 重建（切主题）时用来恢复当前 tab。 */
    private static final String KEY_TAB = "state_tab";

    private View pageHome;
    private View pageEmoji;
    private View pageMore;
    private BottomNavigationView bottomNav;
    private EmojiPage emojiPage;

    // 首页
    private TextView statusIcon;
    private TextView statusText;
    private TextView statusHint;
    private TextView titleAppName;
    private Button btnPrimary;
    private Button btnLogout;
    private ImageButton btnTheme;

    private boolean loggedIn;
    private boolean darkMode;
    private boolean firstResume = true;
    /** 后台预热抖音登录页用的容器（铺满、透明、位于内容下层，见 activity_main.xml）。 */
    private ViewGroup warmupHost;
    /** 当前所在的 tab，默认首页；切主题重建后按它复原。 */
    private int currentTab = R.id.nav_home;

    /**
     * 主题切换会重建 Activity，表情页已经拉到的列表没必要重来一遍。
     * 这里只保留纯数据（不含 Activity / View 引用），重建后直接塞回新页面。
     */
    private static final class RetainedEmoji {
        final List<EmojiItem> items;
        final int scrollPos;
        final long cacheTime;

        RetainedEmoji(List<EmojiItem> items, int scrollPos, long cacheTime) {
            this.items = items;
            this.scrollPos = scrollPos;
            this.cacheTime = cacheTime;
        }
    }

    private RetainedEmoji retained;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences ui = getSharedPreferences("ui", MODE_PRIVATE);
        darkMode = ui.getBoolean(getString(R.string.theme_pref), false);
        AppCompatDelegate.setDefaultNightMode(darkMode
                ? AppCompatDelegate.MODE_NIGHT_YES : AppCompatDelegate.MODE_NIGHT_NO);

        setContentView(R.layout.activity_main);

        titleAppName = findViewById(R.id.title_app_name);
        btnTheme = findViewById(R.id.btn_theme);
        titleAppName.setText(getString(R.string.title_bar_version,
                getString(R.string.app_name),
                BuildConfig.VERSION_NAME));
        updateThemeIcon();
        btnTheme.setOnClickListener(v -> toggleTheme());

        // 三个页面一次性 inflate 进容器，之后只切换可见性
        ViewGroup container = findViewById(R.id.page_container);
        pageHome = getLayoutInflater().inflate(R.layout.page_home, container, false);
        pageEmoji = getLayoutInflater().inflate(R.layout.page_emoji, container, false);
        pageMore = getLayoutInflater().inflate(R.layout.page_more, container, false);
        container.addView(pageHome);
        container.addView(pageEmoji);
        container.addView(pageMore);

        // 抖音登录页后台预热：二维码要点开登录框之后再等 8~12 秒才出来
        // （抖音先跑一轮风控挑战）。那段时间用户什么都做不了，纯干等。
        // 趁他还在首页的时候先把页面跑热，点「去登录」时码已经好了。
        // 已经登录的不用预热 —— 他不会再去登录页。
        warmupHost = findViewById(R.id.warmup_host);
        String cookie0 = CookieManager.getInstance().getCookie("https://www.douyin.com/");
        boolean alreadyLoggedIn = cookie0 != null && cookie0.contains("sessionid");
        if (!alreadyLoggedIn) {
            WebViewWarmup.prepare(this, warmupHost);
        }

        bindHomePage();
        bindMorePage();

        retained = (RetainedEmoji) getLastCustomNonConfigurationInstance();
        emojiPage = new EmojiPage(this, pageEmoji);
        if (retained != null) {
            // 切主题重建：把原来那一屏的表情和滚动位置直接摆回来，不再走网络
            emojiPage.restore(retained.items, retained.scrollPos, retained.cacheTime);
        }

        bottomNav = findViewById(R.id.bottom_nav);
        bottomNav.setOnItemSelectedListener(item -> {
            switchTab(item.getItemId());
            return true;
        });

        // 重建后回到原来那一页，而不是永远回首页
        int tab = savedInstanceState != null
                ? savedInstanceState.getInt(KEY_TAB, R.id.nav_home)
                : R.id.nav_home;
        switchTab(tab);
        if (bottomNav.getSelectedItemId() != tab) {
            bottomNav.setSelectedItemId(tab);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putInt(KEY_TAB, currentTab);
    }

    @Override
    public Object onRetainCustomNonConfigurationInstance() {
        if (emojiPage == null) {
            return null;
        }
        List<EmojiItem> loaded = emojiPage.getItems();
        if (loaded.isEmpty()) {
            return null;
        }
        return new RetainedEmoji(new ArrayList<>(loaded),
                emojiPage.getScrollPosition(), emojiPage.getCacheTime());
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean wasLoggedIn = loggedIn;
        refreshStatus();

        if (firstResume) {
            firstResume = false;
        } else if (loggedIn && !wasLoggedIn) {
            // 刚登录完，直接落到表情页
            bottomNav.setSelectedItemId(R.id.nav_emoji);
        }

        if (bottomNav.getSelectedItemId() == R.id.nav_emoji) {
            emojiPage.onShown();
        }
    }

    @Override
    protected void onDestroy() {
        // 预热容器跟着这个 Activity 一起没了，但那个 WebView 还要留给下一次用
        // （退出登录再进来、或者登录失败重试，都是热的）。只摘挂载，不销毁。
        WebViewWarmup.detach();
        super.onDestroy();
        if (emojiPage != null) {
            emojiPage.destroy();
        }
    }

    /**
     * 切到某个 tab。底部导航点击、重建后复原、以及登录完自动跳表情页，都走这里，
     * 保证「高亮状态」和「显示的内容」永远由同一个方法设置，不会再各走一套。
     */
    private void switchTab(int id) {
        currentTab = id;
        if (id == R.id.nav_emoji) {
            show(pageEmoji);
            emojiPage.onShown();
        } else if (id == R.id.nav_more) {
            show(pageMore);
        } else {
            show(pageHome);
        }
    }

    private void show(View page) {
        pageHome.setVisibility(page == pageHome ? View.VISIBLE : View.GONE);
        pageEmoji.setVisibility(page == pageEmoji ? View.VISIBLE : View.GONE);
        pageMore.setVisibility(page == pageMore ? View.VISIBLE : View.GONE);
    }

    // ---------------------------------------------------------------
    // 首页
    // ---------------------------------------------------------------

    private void bindHomePage() {
        statusIcon = findViewById(R.id.status_icon);
        statusText = findViewById(R.id.status_text);
        statusHint = findViewById(R.id.status_hint);
        btnPrimary = findViewById(R.id.btn_primary);
        btnLogout = findViewById(R.id.btn_logout);

        btnPrimary.setOnClickListener(v -> {
            if (loggedIn) {
                bottomNav.setSelectedItemId(R.id.nav_emoji);
            } else {
                // 立刻给反馈：登录页要初始化 WebView 再加载抖音网页，通常要几秒。
                // 按钮先变成「正在打开…」并禁掉，避免用户以为没点上而连点。
                // 从登录页回来时 onResume → refreshStatus() 会把文案恢复。
                btnPrimary.setText(R.string.btn_opening);
                btnPrimary.setEnabled(false);
                try {
                    startActivity(new Intent(this, LoginActivity.class));
                } catch (Exception e) {
                    // 极少数机型/定制系统会拒绝启动页面。这里必须自己把按钮还原：
                    // 启动失败时不会触发 onResume，按钮会永久卡在禁用态。
                    btnPrimary.setEnabled(true);
                    btnPrimary.setText(R.string.btn_go_login);
                    android.widget.Toast.makeText(this, R.string.login_open_failed,
                            android.widget.Toast.LENGTH_SHORT).show();
                }
            }
        });
        btnLogout.setOnClickListener(v -> {
            CookieManager.getInstance().removeAllCookies(null);
            loggedIn = false;
            refreshStatus();
            emojiPage.reset();
        });
    }

    private void refreshStatus() {
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);

        String cookie = cm.getCookie(DOUYIN_URL);
        loggedIn = cookie != null && cookie.contains("sessionid");

        if (loggedIn) {
            statusIcon.setText(R.string.icon_logged_in);
            statusText.setText(R.string.status_logged_in);
            statusHint.setText(R.string.hint_logged_in);
            btnPrimary.setText(R.string.btn_view_emoji);
            btnLogout.setVisibility(View.VISIBLE);
        } else {
            statusIcon.setText(R.string.icon_not_logged_in);
            statusText.setText(R.string.status_not_logged_in);
            statusHint.setText(R.string.hint_not_logged_in);
            btnPrimary.setText(R.string.btn_go_login);
            btnLogout.setVisibility(View.GONE);
        }

        // 关键：禁用状态必须在这里一起复位。
        // 点「去登录抖音」时会 setEnabled(false) 防止连点，如果只在这里改文案不改 enabled，
        // 用户从登录页点「取消」返回后，按钮文字虽然变回「去登录抖音」，但其实是禁用的
        // —— 看起来正常、点下去毫无反应，只能杀掉 App 重开。
        btnPrimary.setEnabled(true);
    }

    // ---------------------------------------------------------------
    // 主题
    // ---------------------------------------------------------------

    private void toggleTheme() {
        darkMode = !darkMode;
        getSharedPreferences("ui", MODE_PRIVATE)
                .edit().putBoolean(getString(R.string.theme_pref), darkMode).apply();
        AppCompatDelegate.setDefaultNightMode(darkMode
                ? AppCompatDelegate.MODE_NIGHT_YES : AppCompatDelegate.MODE_NIGHT_NO);
    }

    private void updateThemeIcon() {
        btnTheme.setImageResource(darkMode
                ? R.drawable.ic_dark_mode : R.drawable.ic_light_mode);
    }

    // ---------------------------------------------------------------
    // 更多
    // ---------------------------------------------------------------

    private void bindMorePage() {
        ((LinearLayout) findViewById(R.id.btn_feedback)).setOnClickListener(v -> sendFeedback());
        ((LinearLayout) findViewById(R.id.btn_donate)).setOnClickListener(v -> showDonateDialog());
        ((LinearLayout) findViewById(R.id.btn_about)).setOnClickListener(v -> showAboutDialog());
        ((LinearLayout) findViewById(R.id.btn_privacy)).setOnClickListener(v -> showPrivacyDialog());

        SwitchCompat cacheSwitch = findViewById(R.id.switch_cache);
        cacheSwitch.setChecked(getSharedPreferences("ui", MODE_PRIVATE)
                .getBoolean(getString(R.string.cache_pref), false));
        cacheSwitch.setOnCheckedChangeListener((button, checked) ->
                getSharedPreferences("ui", MODE_PRIVATE)
                        .edit().putBoolean(getString(R.string.cache_pref), checked).apply());
    }

    /** 一键反馈：跳系统邮件客户端。 */
    private void sendFeedback() {
        String email = getString(R.string.feedback_email);
        Intent intent = new Intent(Intent.ACTION_SENDTO);
        intent.setData(Uri.parse("mailto:" + email));
        intent.putExtra(Intent.EXTRA_SUBJECT, getString(R.string.feedback_subject));
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, getString(R.string.feedback_fail, email), Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 打赏弹窗：先讲清楚（学生、未成年别打赏），再给「离开 / 微信 / 支付宝」。
     * 没配置好的收款通道直接不显示，避免点进去才发现打不开。
     */
    private void showDonateDialog() {
        View view = getLayoutInflater().inflate(R.layout.dialog_donate, null);
        TextView btnDismiss = view.findViewById(R.id.dialog_btn_dismiss);
        TextView btnWechat = view.findViewById(R.id.dialog_btn_wechat);
        TextView btnAlipay = view.findViewById(R.id.dialog_btn_alipay);

        btnAlipay.setVisibility(alipayReady() ? View.VISIBLE : View.GONE);
        btnWechat.setVisibility(wechatReady() ? View.VISIBLE : View.GONE);

        AlertDialog dialog = new AlertDialog.Builder(this).setView(view).create();
        Window window = dialog.getWindow();
        if (window != null) {
            // 去掉系统默认的白底/深底，用我们自己的圆角卡片
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        }

        btnDismiss.setOnClickListener(v -> dialog.dismiss());
        btnWechat.setOnClickListener(v -> {
            dialog.dismiss();
            showWeChatDonate();
        });
        btnAlipay.setOnClickListener(v -> {
            dialog.dismiss();
            openAlipayDonate();
        });
        dialog.show();
    }

    /** 支付宝通道是否可点：只有本机 local.properties 里填了收款链接才算。 */
    private boolean alipayReady() {
        return BuildConfig.DONATE_ALIPAY_QR.trim().startsWith("http");
    }

    /** 微信通道是否可点：需要 res/drawable/ic_donate_wechat.png 存在。 */
    private boolean wechatReady() {
        return getResources().getIdentifier("ic_donate_wechat", "drawable", getPackageName()) != 0;
    }

    /**
     * 支付宝打赏：不展示二维码图片，直接把收款链接交给支付宝打开，
     * 点一下就是「向 XX 付款」页，输金额付款即可。
     *
     * <p>链接存在 local.properties（不入库）；公开仓库里没有这一项，
     * 所以按钮会在弹窗里直接隐藏，也不会出现「点不动 / 跳到错误页」的情况。
     */
    private void openAlipayDonate() {
        String qr = BuildConfig.DONATE_ALIPAY_QR.trim();
        if (!qr.startsWith("http")) {
            Toast.makeText(this,
                    getString(R.string.donate_alipay_unset, getString(R.string.feedback_email)),
                    Toast.LENGTH_LONG).show();
            return;
        }

        String scheme = "alipays://platformapi/startapp?appId=20000067&url=" + Uri.encode(qr);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(scheme)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.donate_alipay_no_app, Toast.LENGTH_LONG).show();
            // 没装支付宝：https 链接丢给浏览器，同样能付款
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(qr)));
            } catch (ActivityNotFoundException ignore) {
                // 连浏览器都没有，提示已经给过了
            }
        }
    }

    /**
     * 微信没有公开的"打开收款码" scheme。
     * 做法：展示一张微信收款码图片，提示用户在微信里"扫一扫 → 从相册选择"。
     * 把你的微信收款码 PNG 放到 res/drawable/ic_donate_wechat.png 即可自动显示。
     */
    private void showWeChatDonate() {
        int resId = getResources().getIdentifier("ic_donate_wechat", "drawable", getPackageName());
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(R.string.donate_wechat);
        if (resId != 0) {
            android.widget.ImageView iv = new android.widget.ImageView(this);
            iv.setImageResource(resId);
            int pad = (int) (24 * getResources().getDisplayMetrics().density);
            iv.setPadding(pad, pad, pad, pad);
            builder.setView(iv)
                    .setMessage(R.string.donate_wechat_tip);
        } else {
            builder.setMessage(getString(R.string.donate_wechat_placeholder) + "\n\n"
                    + getString(R.string.donate_wechat_tip));
        }
        builder.setPositiveButton("好的", null).show();
    }

    private void showAboutDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.dialog_about_title)
                .setMessage(getString(R.string.dialog_about_msg, BuildConfig.VERSION_NAME))
                .setPositiveButton("好的", null)
                .show();
    }

    private void showPrivacyDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.dialog_privacy_title)
                .setMessage(getString(R.string.dialog_privacy_msg, getString(R.string.feedback_email)))
                .setPositiveButton("好的", null)
                .show();
    }
}
