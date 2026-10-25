package com.example.emojibridge.convert;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;

/**
 * 表情格式转换入口：把抖音的动态 WebP 转成微信能识别动画的 GIF。
 *
 * <p>静态 WebP / GIF / PNG 等原样返回；转换失败也原样返回，不阻塞下载。
 */
public final class StickerConverter {

    private static final int MAX_SIZE = 240;

    private StickerConverter() {
    }

    public static final class Result {
        public final byte[] data;
        public final String mimeType;

        Result(byte[] data, String mimeType) {
            this.data = data;
            this.mimeType = mimeType;
        }
    }

    /** RIFF....WEBP 魔数检测。 */
    public static boolean isWebp(byte[] data) {
        return data.length >= 12
                && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
                && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P';
    }

    public static Result convertIfNeeded(byte[] data, String mimeType) {
        if (!isWebp(data)) {
            return new Result(data, mimeType);
        }
        try {
            ExtractingWebpDecoder decoder = new ExtractingWebpDecoder(data);
            decoder.prepare();
            int frameCount = decoder.frameCount();
            if (frameCount <= 1) {
                return new Result(data, mimeType); // 静态 WebP，微信能直接显示
            }

            byte[] gif = encodeGif(decoder, frameCount);
            if (gif != null) {
                return new Result(gif, "image/gif");
            }
        } catch (Throwable ignore) {
            // 任何解码异常都回退原图
        }
        return new Result(data, mimeType);
    }

    private static byte[] encodeGif(ExtractingWebpDecoder decoder, int frameCount) {
        Bitmap first = decoder.renderToBitmap(0);
        if (first == null) {
            return null;
        }

        int srcW = first.getWidth();
        int srcH = first.getHeight();
        float scale = Math.min(1f, (float) MAX_SIZE / Math.max(srcW, srcH));
        int w = Math.max(1, Math.round(srcW * scale));
        int h = Math.max(1, Math.round(srcH * scale));

        GifEncoder encoder = new GifEncoder(w, h);
        writeFrame(encoder, first, w, h, decoder.duration(0));
        first.recycle();

        for (int i = 1; i < frameCount; i++) {
            Bitmap frame = decoder.renderToBitmap(i);
            if (frame == null) {
                continue;
            }
            writeFrame(encoder, frame, w, h, decoder.duration(i));
            frame.recycle();
        }
        return encoder.finish();
    }

    private static void writeFrame(GifEncoder encoder, Bitmap frame, int w, int h, int durationMs) {
        Bitmap scaled = (frame.getWidth() == w && frame.getHeight() == h)
                ? frame : Bitmap.createScaledBitmap(frame, w, h, true);
        int[] pixels = new int[w * h];
        scaled.getPixels(pixels, 0, w, 0, 0, w, h);
        encoder.addFrame(pixels, durationMs > 0 ? durationMs : 100);
        if (scaled != frame) {
            scaled.recycle();
        }
    }
}
