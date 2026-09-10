# 复习日志说明

`review_log.jsonl`：每行一条 JSON 记录，代表一次复习事件。只增不改，新记录追加到文件末尾。

## 字段

- `date`：复习发生的日期，格式 YYYY-MM-DD
- `note_path`：对应笔记文件在仓库中的相对路径
- `tags`：考点标签数组，取值必须来自 `tags.yaml`
- `review_count_after`：本次复习后，该笔记累计被复习的次数
- `added_content`：本次复习新增/加深的具体理解，一两句话概括
- `source`："白天复习" 或 "晚上首次学习"

## 示例

```json
{"date": "2026-09-10", "note_path": "数学/线性代数/特征值与特征向量.md", "tags": ["线性代数", "特征值"], "review_count_after": 2, "added_content": "补充了对角化的几何意义", "source": "白天复习"}
```

## 笔记文件的当前状态字段（frontmatter）

每个 .md 笔记文件顶部维护：

```yaml
---
review_count: 0
last_reviewed: 2026-09-10
next_review: 2026-09-11
---
```

间隔表（第 review_count 次复习后，到下一次的天数）：

| review_count | 距上次复习天数 |
|---|---|
| 0 → 1 | 1 |
| 1 → 2 | 2 |
| 2 → 3 | 4 |
| 3 → 4 | 7 |
| 4 → 5 | 15 |
| 5+ | 30 |
