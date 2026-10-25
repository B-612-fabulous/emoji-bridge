package com.example.emojibridge.util;

import android.content.Context;

import com.example.emojibridge.model.EmojiItem;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * 本机磁盘缓存，三样东西：
 *  1) 表情原图（按 url 的 md5 存）——第二次保存/转发不用再走网络；
 *  2) 转换后的 GIF（按表情 id 存）——动态 WebP 只转一次；
 *  3) 表情列表 JSON（带时间戳）——打开开关时秒开。
 * 全部在应用私有目录，不对外发送。
 */
public final class ImageStore {

    private ImageStore() {
    }

    // ---------------------------------------------------------------
    // 图片类型识别（不额外存 MIME，用文件头判断）
    // ---------------------------------------------------------------

    public static String mimeOf(byte[] data) {
        if (data == null || data.length < 12) {
            return "image/webp";
        }
        if (data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
                && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P') {
            return "image/webp";
        }
        if (data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46) {
            return "image/gif"; // GIF87a / GIF89a
        }
        if (data[0] == (byte) 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47) {
            return "image/png";
        }
        if (data[0] == (byte) 0xFF && data[1] == (byte) 0xD8) {
            return "image/jpeg";
        }
        return "image/webp";
    }

    // ---------------------------------------------------------------
    // 原图缓存
    // ---------------------------------------------------------------

    /** 读原图缓存；没有则返回 null。 */
    public static byte[] readRaw(Context ctx, String url) {
        return readOrNull(rawFile(ctx, url));
    }

    public static void writeRaw(Context ctx, String url, byte[] data) throws IOException {
        writeAll(rawFile(ctx, url), data);
    }

    private static File rawFile(Context ctx, String url) {
        return new File(dir(ctx, "images"), md5(url));
    }

    // ---------------------------------------------------------------
    // 转换结果（GIF）缓存
    // ---------------------------------------------------------------

    public static File gifFile(Context ctx, String id) {
        return new File(dir(ctx, "converted"), safeId(id) + ".gif");
    }

    public static void writeGif(Context ctx, String id, byte[] data) throws IOException {
        writeAll(gifFile(ctx, id), data);
    }

    // ---------------------------------------------------------------
    // 表情列表缓存
    // ---------------------------------------------------------------

    public static final class CachedList {
        public final List<EmojiItem> items;
        public final long timeMillis;

        CachedList(List<EmojiItem> items, long timeMillis) {
            this.items = items;
            this.timeMillis = timeMillis;
        }
    }

    /** 写列表缓存，带当前时间戳。 */
    public static void writeList(Context ctx, List<EmojiItem> items) {
        try {
            JSONArray array = new JSONArray();
            for (EmojiItem item : items) {
                JSONObject o = new JSONObject();
                o.put("id", item.id);
                o.put("url", item.url);
                array.put(o);
            }
            JSONObject root = new JSONObject();
            root.put("time", System.currentTimeMillis());
            root.put("items", array);
            writeAll(listFile(ctx), root.toString().getBytes("UTF-8"));
        } catch (Exception ignore) {
            // 缓存写失败不影响主流程
        }
    }

    /** 读列表缓存；文件不存在或损坏返回 null。 */
    public static CachedList readList(Context ctx) {
        byte[] data = readOrNull(listFile(ctx));
        if (data == null) {
            return null;
        }
        try {
            JSONObject root = new JSONObject(new String(data, "UTF-8"));
            JSONArray array = root.optJSONArray("items");
            if (array == null || array.length() == 0) {
                return null;
            }
            List<EmojiItem> items = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) {
                JSONObject o = array.optJSONObject(i);
                if (o == null) {
                    continue;
                }
                String url = o.optString("url", "");
                if (url.isEmpty()) {
                    continue;
                }
                items.add(new EmojiItem(o.optString("id", "unknown"), url));
            }
            if (items.isEmpty()) {
                return null;
            }
            return new CachedList(items, root.optLong("time", 0L));
        } catch (Exception e) {
            return null;
        }
    }

    private static File listFile(Context ctx) {
        return new File(ctx.getFilesDir(), "emoji_cache.json");
    }

    // ---------------------------------------------------------------
    // 通用读写
    // ---------------------------------------------------------------

    public static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static byte[] readOrNull(File file) {
        try {
            if (!file.isFile() || file.length() == 0) {
                return null;
            }
            return readAll(file);
        } catch (IOException e) {
            return null;
        }
    }

    private static void writeAll(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建缓存目录");
        }
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    private static File dir(Context ctx, String name) {
        File dir = new File(ctx.getCacheDir(), name);
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private static String safeId(String id) {
        String safe = id.replaceAll("[^0-9A-Za-z_-]", "");
        return safe.isEmpty() ? "unknown" : safe;
    }

    private static String md5(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(value.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(32);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            // 极端情况下退化为 hashCode，仍然能起到缓存作用
            return Integer.toHexString(value.hashCode());
        }
    }
}
