# 离线数据来源与署名

本目录下的两个 JSON 都是离线种子，由 `app/scripts/` 里的脚本从公开数据源生成。
运行时和复习过程**不访问任何第三方网络**。

---

## ecdict-ky.json — 考研词表

- **来源**：[ECDICT](https://github.com/skywind3000/ECDICT)
- **许可**：MIT License
- **锁定版本**：commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- **筛选口径**：`tag` 字段按空格切分后，token 精确等于 `ky`
- **规模**：4,801 条（去重后）
- **重新生成**：`node scripts/import-ecdict-ky.mjs [ecdict.csv]`

钉死 commit 而不是跟 master：ECDICT 会持续更新词条和标签，跟着 master 走会让
每次重新生成的词表都不一样，对不上账。

保留字段：英文词形、音标、中文释义、英英释义、词频，以及 `考研 / 英语一 / ECDICT` 标签。

---

## tatoeba-ky-examples.json — 例句

- **来源**：[Tatoeba](https://tatoeba.org) 英语句子导出
- **许可**：CC BY 2.0 FR
- **输入包**：`https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2`
- **输入包 SHA-256**：记录在 JSON 的 `inputSha256` 字段里
- **匹配口径**：大小写不敏感的**精确 token 匹配**（剥掉首尾标点后整词相等）
- **规模**：4,785 条 Tatoeba 例句
- **重新生成**：`node scripts/import-tatoeba-ky-examples.mjs [eng_sentences.tsv.bz2]`

每条例句都保留原始 sentence id 和可回溯 URL（`https://tatoeba.org/en/sentences/show/<id>`），
满足 CC BY 的署名要求。

筛选规则：只保留 5–22 词的自然短句，过滤链接、非 ASCII 残留、重复词，以及 Tatoeba 里
铺天盖地的 Tom / Mary 模板句；中性陈述句优先。

---

## 项目自备兜底例句

- **许可**：CC0（放弃权利，可自由使用）
- **规模**：16 条

Tatoeba 没覆盖到的词由项目自己补一条占位例句，保证每个词条都有例句可显示。
这些句子由本项目撰写，不主张任何权利。

---

## 依赖说明

`seek-bzip@2.0.0` 仅用于 `import-tatoeba-ky-examples.mjs` 解压官方导出包，
是 devDependency，**不进入服务端运行时和浏览器打包产物**。
