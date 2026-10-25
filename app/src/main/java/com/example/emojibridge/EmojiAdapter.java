package com.example.emojibridge;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.ImageView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.bumptech.glide.Glide;
import com.example.emojibridge.model.EmojiItem;

import java.util.List;

/** 表情网格适配器：点击切换选中。 */
public class EmojiAdapter extends RecyclerView.Adapter<EmojiAdapter.Holder> {

    /** 选中数量变化回调：让宿主页面实时更新「转发到微信」等按钮状态。 */
    public interface OnSelectionChangedListener {
        void onSelectionChanged(int selectedCount);
    }

    private final List<EmojiItem> data;
    private OnSelectionChangedListener listener;

    public EmojiAdapter(List<EmojiItem> data) {
        this.data = data;
    }

    public void setOnSelectionChangedListener(OnSelectionChangedListener listener) {
        this.listener = listener;
    }

    /** 供外部（如「全选」）改完选中态后手动触发一次回调。 */
    public void notifySelectionChanged() {
        if (listener == null) {
            return;
        }
        int count = 0;
        for (EmojiItem item : data) {
            if (item.selected) {
                count++;
            }
        }
        listener.onSelectionChanged(count);
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_emoji, parent, false);
        return new Holder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        EmojiItem item = data.get(position);

        Glide.with(holder.image.getContext())
                .load(item.url)
                .placeholder(R.drawable.placeholder)
                .into(holder.image);
        holder.check.setChecked(item.selected);

        View.OnClickListener toggle = v -> {
            item.selected = !item.selected;
            holder.check.setChecked(item.selected);
            notifySelectionChanged();
        };
        holder.itemView.setOnClickListener(toggle);
    }

    @Override
    public int getItemCount() {
        return data.size();
    }

    static class Holder extends RecyclerView.ViewHolder {
        final ImageView image;
        final CheckBox check;

        Holder(@NonNull View itemView) {
            super(itemView);
            image = itemView.findViewById(R.id.emoji_image);
            check = itemView.findViewById(R.id.emoji_check);
        }
    }
}
