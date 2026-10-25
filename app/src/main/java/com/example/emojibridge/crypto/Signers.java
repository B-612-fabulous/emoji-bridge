package com.example.emojibridge.crypto;

/**
 * 签名器工厂。
 *
 * <p>出于合规考虑，本开源仓库<b>不包含</b>签名算法的真实实现（{@code ABogus}）。
 * 这里通过反射按需加载：本地开发环境存在该实现时直接使用；
 * 若不存在（例如直接克隆公开仓库），则返回一个会明确报错的占位实现，
 * 保证工程始终可以编译、可以阅读，而不是编译失败。
 */
public final class Signers {

    private Signers() {
    }

    private static final SignatureSigner INSTANCE = create();

    public static SignatureSigner get() {
        return INSTANCE;
    }

    private static SignatureSigner create() {
        try {
            Class<?> cls = Class.forName("com.example.emojibridge.crypto.ABogus");
            return (SignatureSigner) cls.getDeclaredConstructor().newInstance();
        } catch (Throwable t) {
            return (query, method) -> {
                throw new java.io.IOException(
                        "签名算法未包含在本开源仓库中，无法直接调用接口。请自行实现 SignatureSigner。");
            };
        }
    }
}