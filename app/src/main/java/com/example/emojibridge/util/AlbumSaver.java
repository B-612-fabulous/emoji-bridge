package com.example.emojibridge.util;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.IOException;
import java.io.OutputStream;

/** 把图片字节写入系统相册（默认 Pictures/WeChatEmoji）。 */
public final class AlbumSaver {

    private AlbumSaver() {
    }

    public static Uri save(Context context, byte[] data, String displayName, String mimeType)
            throws IOException {
        return save(context, data, displayName, mimeType, "WeChatEmoji");
    }

    /**
     * 指定相册子目录。二维码单独放一个目录，用户去相册里找「刚存的那张」时一眼能认出来。
     */
    public static Uri save(Context context, byte[] data, String displayName, String mimeType,
            String folder) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/" + folder);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        }

        Uri uri = context.getContentResolver()
                .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("无法创建相册条目");
        }

        try (OutputStream os = context.getContentResolver().openOutputStream(uri)) {
            if (os == null) {
                throw new IOException("无法打开相册输出流");
            }
            os.write(data);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            context.getContentResolver().update(uri, done, null, null);
        }
        return uri;
    }
}
