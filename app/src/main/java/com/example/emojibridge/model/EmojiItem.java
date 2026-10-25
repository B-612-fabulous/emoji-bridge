package com.example.emojibridge.model;

/** 抖音收藏表情。 */
public class EmojiItem {

    public final String id;
    public final String url;

    public boolean selected;

    public EmojiItem(String id, String url) {
        this.id = id;
        this.url = url;
    }
}
