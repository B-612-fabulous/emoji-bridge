package com.example.emojibridge.net;

import com.example.emojibridge.crypto.Signers;
import com.example.emojibridge.model.EmojiItem;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 抖音 Web 接口直连。整个过程在手机本机完成：
 * Cookie 只用于本机请求，不经过任何第三方服务器。
 */
public final class DouyinApi {

    private static final String STICKER_URL =
            "https://www.douyin.com/aweme/v1/web/im/resource/list/aggregation";

    /** 与 a_bogus 的 ua_code 绑定，必须一致。 */
    public static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/90.0.4430.212 Safari/537.36";

    private final OkHttpClient client;
    private final String cookie;

    public DouyinApi(String cookie) {
        this.cookie = cookie;
        this.client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .followRedirects(true)
                .build();
    }

    /** 拉取全部收藏表情（自动分页）。 */
    public List<EmojiItem> fetchAll() throws IOException {
        List<EmojiItem> all = new ArrayList<>();
        long cursor = 0;

        for (int page = 0; page < 20; page++) {
            String query = buildQuery(cursor);
            String aBogus = Signers.get().sign(query, "GET");
            String url = STICKER_URL + "?" + query + "&a_bogus=" + aBogus;

            Request request = baseRequest(url).build();

            try (Response response = client.newCall(request).execute()) {
                String body = bodyString(response);
                if (response.code() == 403) {
                    throw new IOException("抖音返回 403：签名或登录校验未通过");
                }
                if (!response.isSuccessful()) {
                    throw new IOException("接口返回 HTTP " + response.code());
                }

                JSONObject root;
                try {
                    root = new JSONObject(body);
                } catch (org.json.JSONException e) {
                    throw new IOException("抖音返回了非 JSON 内容", e);
                }
                if (root.optInt("status_code", -1) != 0) {
                    throw new IOException("抖音接口拒绝："
                            + root.optString("status_msg", "status_code=" + root.opt("status_code")));
                }

                JSONObject stickerPage = root.optJSONObject("custom_sticker_page_list");
                if (stickerPage == null) {
                    break;
                }

                JSONArray resources = stickerPage.optJSONArray("resources");
                if (resources != null) {
                    for (int i = 0; i < resources.length(); i++) {
                        JSONObject res = resources.optJSONObject(i);
                        if (res == null) {
                            continue;
                        }
                        JSONArray stickers = res.optJSONArray("stickers");
                        if (stickers == null) {
                            continue;
                        }
                        for (int j = 0; j < stickers.length(); j++) {
                            JSONObject sticker = stickers.optJSONObject(j);
                            if (sticker == null) {
                                continue;
                            }
                            String best = pickUrl(sticker.optJSONObject("animate_url"));
                            if (best == null) {
                                best = pickUrl(sticker.optJSONObject("static_url"));
                            }
                            if (best != null) {
                                all.add(new EmojiItem(sticker.optString("id_str", "unknown"), best));
                            }
                        }
                    }
                }

                if (!stickerPage.optBoolean("has_more", false)) {
                    break;
                }
                long next = stickerPage.optLong("next_cursor", cursor);
                if (next == cursor) {
                    break;
                }
                cursor = next;
            }
        }
        return all;
    }

    /** 下载表情原图，返回字节与 MIME。 */
    public Downloaded download(String url) throws IOException {
        Request request = new Request.Builder()
                .url(url)
                .header("User-Agent", UA)
                .header("Referer", "https://www.douyin.com/")
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("下载失败 HTTP " + response.code());
            }
            ResponseBody body = response.body();
            if (body == null) {
                throw new IOException("下载内容为空");
            }
            String mime = body.contentType() == null ? "image/webp" : body.contentType().toString();
            return new Downloaded(body.bytes(), mime);
        }
    }

    public static final class Downloaded {
        public final byte[] data;
        public final String mimeType;

        Downloaded(byte[] data, String mimeType) {
            this.data = data;
            this.mimeType = mimeType;
        }
    }

    // ---------------------------------------------------------------

    private Request.Builder baseRequest(String url) {
        return new Request.Builder()
                .url(url)
                .header("User-Agent", UA)
                .header("Referer", "https://www.douyin.com/")
                .header("Accept", "application/json, text/plain, */*")
                .header("Accept-Language", "zh-CN,zh;q=0.9")
                .header("Cookie", cookie);
    }

    /**
     * 按 Python urlencode 的顺序构建查询串，最后补 msToken=。
     * 参数顺序、键名必须与开源项目一致，签名才有效。
     */
    private static String buildQuery(long cursor) {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("device_platform", "webapp");
        params.put("aid", "1128");
        params.put("channel", "channel_pc_web");
        params.put("scenes", "CUSTOM_STICKER_PAGE");
        params.put("custom_cursor", String.valueOf(cursor));
        params.put("custom_page_size", "100");
        params.put("version_code", "170400");
        params.put("version_name", "17.4.0");
        params.put("cookie_enabled", "true");
        params.put("screen_width", "1536");
        params.put("screen_height", "864");
        params.put("browser_language", "zh-CN");
        params.put("browser_platform", "Win32");
        params.put("browser_name", "Chrome");
        params.put("browser_version", "90.0.4430.212");
        params.put("browser_online", "true");
        params.put("engine_name", "Blink");
        params.put("engine_version", "90.0.4430.212");
        params.put("os_name", "Windows");
        params.put("os_version", "10");
        params.put("cpu_core_num", "12");
        params.put("device_memory", "8");
        params.put("platform", "PC");
        params.put("msToken", "");

        StringBuilder sb = new StringBuilder(256);
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(e.getKey()).append('=').append(formEncode(e.getValue()));
        }
        return sb.toString();
    }

    /** Python quote_plus 子集：这些固定值实际全是未保留字符。 */
    private static String formEncode(String value) {
        StringBuilder sb = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9')
                    || c == '_' || c == '-' || c == '.' || c == '~') {
                sb.append(c);
            } else if (c == ' ') {
                sb.append('+');
            } else {
                for (byte b : String.valueOf(c).getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
                    sb.append('%');
                    sb.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xf, 16)));
                    sb.append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
                }
            }
        }
        return sb.toString();
    }

    private static String pickUrl(JSONObject urlInfo) {
        if (urlInfo == null) {
            return null;
        }
        JSONArray list = urlInfo.optJSONArray("url_list");
        if (list == null || list.length() == 0) {
            return null;
        }
        String best = list.optString(0, null);
        for (int i = 0; i < list.length(); i++) {
            String u = list.optString(i, "");
            if (u.toLowerCase().contains("origin")) {
                best = u;
                break;
            }
        }
        return best;
    }

    private static String bodyString(Response response) throws IOException {
        ResponseBody rb = response.body();
        return rb == null ? "" : rb.string();
    }
}
