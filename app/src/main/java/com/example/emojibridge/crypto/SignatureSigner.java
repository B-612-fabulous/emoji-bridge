package com.example.emojibridge.crypto;

import java.io.IOException;

/**
 * 请求签名器：为来源平台的 Web API 生成 {@code a_bogus} 反爬参数。
 *
 * <p>把签名能力抽象成接口，是为了让「签名算法的具体实现」与业务代码解耦：
 * 业务侧只依赖本接口，真实实现可以按需替换或不随仓库分发。
 */
public interface SignatureSigner {

    /**
     * 生成签名。
     *
     * @param query  参与签名的有序查询串（不含 a_bogus）
     * @param method HTTP 方法，如 "GET"
     * @return 已 URL 编码的 a_bogus 值
     */
    String sign(String query, String method) throws IOException;
}