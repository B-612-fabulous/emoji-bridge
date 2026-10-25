package com.example.emojibridge.convert;

import android.graphics.Bitmap;
import android.graphics.Rect;

import com.github.penfeizhou.animation.decode.Frame;
import com.github.penfeizhou.animation.loader.ByteBufferLoader;
import com.github.penfeizhou.animation.webp.decode.WebPDecoder;

import java.nio.ByteBuffer;

/**
 * 不使用实时播放循环，直接逐帧驱动解码器：
 * 依次调用 renderFrame 合成出每帧完整画布，再从 frameBuffer 取出像素。
 */
class ExtractingWebpDecoder extends WebPDecoder {

    ExtractingWebpDecoder(byte[] data) {
        super(new ByteBufferLoader() {
            @Override
            public ByteBuffer getByteBuffer() {
                return ByteBuffer.wrap(data);
            }
        }, null);
    }

    /** 触发容器解析（含帧列表与画布尺寸）。必须在非解码器线程调用。 */
    void prepare() {
        getBounds();
    }

    int frameCount() {
        return getFrameCount();
    }

    /** 合成第 index 帧并返回完整画布位图。 */
    Bitmap renderToBitmap(int index) {
        frameIndex = index;
        @SuppressWarnings("unchecked")
        Frame<com.github.penfeizhou.animation.webp.io.WebPReader,
                com.github.penfeizhou.animation.webp.io.WebPWriter> frame = frames.get(index);
        renderFrame(frame);

        Rect bounds = getBounds();
        Bitmap bitmap = Bitmap.createBitmap(bounds.width(), bounds.height(), Bitmap.Config.ARGB_8888);
        frameBuffer.rewind();
        bitmap.copyPixelsFromBuffer(frameBuffer);
        return bitmap;
    }

    int duration(int index) {
        return frames.get(index).frameDuration;
    }
}
