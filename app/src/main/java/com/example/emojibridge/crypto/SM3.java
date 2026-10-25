package com.example.emojibridge.crypto;

/**
 * SM3 密码杂凑算法（GB/T 32905-2016），输出 32 字节摘要。
 * 用于 a_bogus 签名中的双重 SM3 计算，输出须与 Python gmssl 一致。
 */
public final class SM3 {

    private static final int[] IV = {
            0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
            0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
    };

    private SM3() {
    }

    public static byte[] hash(byte[] data) {
        byte[] padded = pad(data);

        int[] v = IV.clone();
        for (int offset = 0; offset < padded.length; offset += 64) {
            v = compress(v, padded, offset);
        }

        byte[] out = new byte[32];
        for (int i = 0; i < 8; i++) {
            out[i * 4] = (byte) (v[i] >>> 24);
            out[i * 4 + 1] = (byte) (v[i] >>> 16);
            out[i * 4 + 2] = (byte) (v[i] >>> 8);
            out[i * 4 + 3] = (byte) v[i];
        }
        return out;
    }

    private static byte[] pad(byte[] data) {
        long bitLength = (long) data.length * 8L;
        int k = (56 - (data.length + 1) % 64 + 64) % 64;

        byte[] out = new byte[data.length + 1 + k + 8];
        System.arraycopy(data, 0, out, 0, data.length);
        out[data.length] = (byte) 0x80;

        for (int i = 0; i < 8; i++) {
            out[out.length - 8 + i] = (byte) (bitLength >>> (56 - i * 8));
        }
        return out;
    }

    private static int[] compress(int[] v, byte[] block, int off) {
        int[] w = new int[68];
        for (int i = 0; i < 16; i++) {
            w[i] = ((block[off + i * 4] & 0xff) << 24)
                    | ((block[off + i * 4 + 1] & 0xff) << 16)
                    | ((block[off + i * 4 + 2] & 0xff) << 8)
                    | (block[off + i * 4 + 3] & 0xff);
        }
        for (int i = 16; i < 68; i++) {
            w[i] = p1(w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15))
                    ^ rotl(w[i - 13], 7) ^ w[i - 6];
        }

        int a = v[0], b = v[1], c = v[2], d = v[3];
        int e = v[4], f = v[5], g = v[6], h = v[7];

        for (int j = 0; j < 64; j++) {
            int t = j <= 15 ? 0x79cc4519 : 0x7a879d8a;
            int ss1 = rotl(rotl(a, 12) + e + rotl(t, j), 7);
            int ss2 = ss1 ^ rotl(a, 12);

            int ff = j <= 15 ? (a ^ b ^ c) : ((a & b) | (a & c) | (b & c));
            int gg = j <= 15 ? (e ^ f ^ g) : ((e & f) | (~e & g));

            int tt1 = ff + d + ss2;
            int tt2 = gg + h + ss1;

            d = c;
            c = rotl(b, 9);
            b = a;
            a = tt1;
            h = g;
            g = rotl(f, 19);
            f = e;
            e = p0(tt2);
        }

        return new int[]{
                a ^ v[0], b ^ v[1], c ^ v[2], d ^ v[3],
                e ^ v[4], f ^ v[5], g ^ v[6], h ^ v[7],
        };
    }

    private static int rotl(int x, int n) {
        n %= 32;
        return n == 0 ? x : (x << n) | (x >>> (32 - n));
    }

    private static int p0(int x) {
        return x ^ rotl(x, 9) ^ rotl(x, 17);
    }

    private static int p1(int x) {
        return x ^ rotl(x, 15) ^ rotl(x, 23);
    }
}
