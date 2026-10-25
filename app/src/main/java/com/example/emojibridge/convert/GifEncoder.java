package com.example.emojibridge.convert;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简动态 GIF 编码器（GIF89a）。
 *
 * <p>每帧独立局部颜色表（中位切分量化，最多 256 色），
 * 支持透明色、逐帧延迟、无限循环。帧必须是合成好的完整画布。
 */
final class GifEncoder {

    private static final class Box {
        int[] pixels;
        int rMin, rMax, gMin, gMax, bMin, bMax;
        int rAvg, gAvg, bAvg;
    }

    private final int width;
    private final int height;

    private final ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
    private boolean started;

    GifEncoder(int width, int height) {
        this.width = width;
        this.height = height;
    }

    void addFrame(int[] pixels, int delayMs) {
        if (!started) {
            writeHeader();
            started = true;
        }

        boolean hasTransparent = false;
        List<Integer> opaque = new ArrayList<>(pixels.length);
        for (int p : pixels) {
            if ((p >>> 24) < 128) {
                hasTransparent = true;
            } else {
                opaque.add(p);
            }
        }

        int maxColors = hasTransparent ? 255 : 256;
        int[] palette = buildPalette(opaque, maxColors);
        int transparentIndex = palette.length;

        int tableSize = 2;
        int needed = palette.length + (hasTransparent ? 1 : 0);
        while (tableSize < needed) {
            tableSize *= 2;
        }
        int tableSizeField = tableSize - 1;

        // 图形控制扩展：延迟（百分之一秒）+ 透明索引
        int delayCs = Math.max(2, Math.round(delayMs / 10f));
        int packed = 0x04 | (hasTransparent ? 0x01 : 0x00); // disposal=1
        writeBytes(0x21, 0xF9, 0x04, packed);
        writeShort(delayCs);
        out.write(hasTransparent ? transparentIndex : 0);
        out.write(0x00);

        // 图像描述符
        writeBytes(0x2C);
        writeShort(0); // left
        writeShort(0); // top
        writeShort(width);
        writeShort(height);
        out.write(0x80 | (bitsOf(tableSize) - 1)); // 局部颜色表（size 字段 = log2(表大小)-1）

        for (int color : palette) {
            out.write((color >> 16) & 0xff);
            out.write((color >> 8) & 0xff);
            out.write(color & 0xff);
        }
        for (int i = palette.length; i < tableSize - (hasTransparent ? 1 : 0); i++) {
            out.write(0);
            out.write(0);
            out.write(0);
        }
        if (hasTransparent) {
            out.write(0);
            out.write(0);
            out.write(0);
        }

        byte[] indexed = mapToPalette(pixels, palette, transparentIndex, hasTransparent);
        // GIF 规范要求 LZW 最小码长 >= 2
        lzwEncode(indexed, Math.max(2, bitsOf(tableSize)));
    }

    byte[] finish() {
        out.write(0x3B); // trailer
        return out.toByteArray();
    }

    // ---------------------------------------------------------------
    // 中位切分
    // ---------------------------------------------------------------

    private static int[] buildPalette(List<Integer> opaquePixels, int maxColors) {
        if (opaquePixels.isEmpty()) {
            return new int[0];
        }

        // 去重并统计，减少后续计算量
        Map<Integer, Integer> counts = new HashMap<>();
        for (int p : opaquePixels) {
            counts.merge(p, 1, Integer::sum);
        }

        Box root = new Box();
        int[] uniques = new int[counts.size()];
        int i = 0;
        for (int p : counts.keySet()) {
            uniques[i++] = p;
        }
        root.pixels = uniques;
        fillBoxStats(root);

        List<Box> boxes = new ArrayList<>();
        boxes.add(root);

        while (boxes.size() < maxColors) {
            Box target = null;
            int longest = 0;
            for (Box b : boxes) {
                if (b.pixels.length < 2) {
                    continue;
                }
                int range = Math.max(b.rMax - b.rMin, Math.max(b.gMax - b.gMin, b.bMax - b.bMin));
                if (range > longest) {
                    longest = range;
                    target = b;
                }
            }
            if (target == null) {
                break;
            }

            int channel = longestChannel(target);
            Integer[] sorted = new Integer[target.pixels.length];
            for (int k = 0; k < sorted.length; k++) {
                sorted[k] = target.pixels[k];
            }
            final int ch = channel;
            Arrays.sort(sorted, (a, b) -> channelValue(a, ch) - channelValue(b, ch));

            int mid = sorted.length / 2;
            Box left = new Box();
            Box right = new Box();
            left.pixels = new int[mid];
            right.pixels = new int[sorted.length - mid];
            for (int k = 0; k < mid; k++) {
                left.pixels[k] = sorted[k];
            }
            for (int k = mid; k < sorted.length; k++) {
                right.pixels[k - mid] = sorted[k];
            }
            fillBoxStats(left);
            fillBoxStats(right);

            boxes.remove(target);
            boxes.add(left);
            boxes.add(right);
        }

        int[] palette = new int[boxes.size()];
        for (int k = 0; k < boxes.size(); k++) {
            Box b = boxes.get(k);
            palette[k] = 0xFF000000 | (b.rAvg << 16) | (b.gAvg << 8) | b.bAvg;
        }
        return palette;
    }

    private static void fillBoxStats(Box b) {
        if (b.pixels.length == 0) {
            return;
        }
        b.rMin = b.gMin = b.bMin = 255;
        b.rMax = b.gMax = b.bMax = 0;
        long rSum = 0, gSum = 0, bSum = 0;

        for (int p : b.pixels) {
            int r = (p >> 16) & 0xff;
            int g = (p >> 8) & 0xff;
            int bl = p & 0xff;
            rSum += r;
            gSum += g;
            bSum += bl;
            if (r < b.rMin) b.rMin = r;
            if (r > b.rMax) b.rMax = r;
            if (g < b.gMin) b.gMin = g;
            if (g > b.gMax) b.gMax = g;
            if (bl < b.bMin) b.bMin = bl;
            if (bl > b.bMax) b.bMax = bl;
        }
        int n = b.pixels.length;
        b.rAvg = (int) (rSum / n);
        b.gAvg = (int) (gSum / n);
        b.bAvg = (int) (bSum / n);
    }

    private static int longestChannel(Box b) {
        int rr = b.rMax - b.rMin;
        int gg = b.gMax - b.gMin;
        int bb = b.bMax - b.bMin;
        if (rr >= gg && rr >= bb) return 0;
        if (gg >= bb) return 1;
        return 2;
    }

    private static int channelValue(int p, int ch) {
        switch (ch) {
            case 0:
                return (p >> 16) & 0xff;
            case 1:
                return (p >> 8) & 0xff;
            default:
                return p & 0xff;
        }
    }

    private static byte[] mapToPalette(int[] pixels, int[] palette,
                                       int transparentIndex, boolean hasTransparent) {
        byte[] indexed = new byte[pixels.length];

        // 相同颜色只计算一次最近色
        Map<Integer, Integer> cache = new HashMap<>();

        for (int i = 0; i < pixels.length; i++) {
            int p = pixels[i];
            if (hasTransparent && (p >>> 24) < 128) {
                indexed[i] = (byte) transparentIndex;
                continue;
            }

            Integer cached = cache.get(p);
            if (cached == null) {
                int r = (p >> 16) & 0xff;
                int g = (p >> 8) & 0xff;
                int b = p & 0xff;
                int best = 0;
                int bestDist = Integer.MAX_VALUE;
                for (int k = 0; k < palette.length; k++) {
                    int c = palette[k];
                    int dr = r - ((c >> 16) & 0xff);
                    int dg = g - ((c >> 8) & 0xff);
                    int db = b - (c & 0xff);
                    int dist = dr * dr + dg * dg + db * db;
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = k;
                    }
                }
                cache.put(p, best);
                cached = best;
            }
            indexed[i] = (byte) (int) cached;
        }
        return indexed;
    }

    // ---------------------------------------------------------------
    // LZW
    // ---------------------------------------------------------------

    private void lzwEncode(byte[] indexed, int minCodeSize) {
        out.write(minCodeSize);

        int clearCode = 1 << minCodeSize;
        int eoiCode = clearCode + 1;

        int codeSize = minCodeSize + 1;
        int nextCode = eoiCode + 1;

        // 字典：前缀码→当前字节 映射到输出码
        Map<Integer, Integer> dict = new HashMap<>(4096);

        BitBuffer bitBuffer = new BitBuffer();
        bitBuffer.write(clearCode, codeSize);

        int current = indexed[0] & 0xff;

        for (int i = 1; i < indexed.length; i++) {
            int b = indexed[i] & 0xff;
            int key = (current << 8) | b;
            Integer code = dict.get(key);
            if (code != null) {
                current = code;
            } else {
                bitBuffer.write(current, codeSize);
                if (nextCode < 4096) {
                    dict.put(key, nextCode);
                    if (nextCode == (1 << codeSize) && codeSize < 12) {
                        codeSize++;
                    }
                    nextCode++;
                } else {
                    bitBuffer.write(clearCode, codeSize);
                    dict.clear();
                    codeSize = minCodeSize + 1;
                    nextCode = eoiCode + 1;
                }
                current = b;
            }
        }

        bitBuffer.write(current, codeSize);
        bitBuffer.write(eoiCode, codeSize);
        bitBuffer.flushBlocks(out);
    }

    /** LZW 位流：LSB 优先，按子块（≤255）输出。 */
    private static final class BitBuffer {
        int accumulator;
        int bits;
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        void write(int code, int size) {
            accumulator |= code << bits;
            bits += size;
            while (bits >= 8) {
                bytes.write(accumulator & 0xff);
                accumulator >>>= 8;
                bits -= 8;
            }
        }

        void flushBlocks(ByteArrayOutputStream target) {
            if (bits > 0) {
                bytes.write(accumulator & 0xff);
                accumulator = 0;
                bits = 0;
            }
            byte[] all = bytes.toByteArray();
            int off = 0;
            while (off < all.length) {
                int len = Math.min(255, all.length - off);
                target.write(len);
                target.write(all, off, len);
                off += len;
            }
            target.write(0); // block terminator
        }
    }

    // ---------------------------------------------------------------
    // 文件结构
    // ---------------------------------------------------------------

    private void writeHeader() {
        out.write('G');
        out.write('I');
        out.write('F');
        out.write('8');
        out.write('9');
        out.write('a');

        writeShort(width);
        writeShort(height);
        out.write(0x00); // 无全局颜色表
        out.write(0x00); // 背景色
        out.write(0x00); // 像素宽高比

        // Netscape 循环扩展
        writeBytes(0x21, 0xFF, 0x0B);
        byte[] app = "NETSCAPE2.0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        out.write(app, 0, app.length);
        writeBytes(0x03, 0x01);
        writeShort(0); // 无限循环
        out.write(0x00);
    }

    private static int bitsOf(int tableSize) {
        int bits = 1;
        while ((1 << bits) < tableSize) {
            bits++;
        }
        return bits;
    }

    private void writeShort(int v) {
        out.write(v & 0xff);
        out.write((v >> 8) & 0xff);
    }

    private void writeBytes(int... values) {
        for (int v : values) {
            out.write(v);
        }
    }
}
