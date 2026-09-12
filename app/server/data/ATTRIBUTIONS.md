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

Tatoeba 没覆盖到的词（retrospection、despatch、goodby、maltreat、sufficiency、instrumentalist、malign、
perplex、resultant、futility、dramatize、appall、appal、endow、gramme、administrate）由本项目自己写一句
真实用法的例句并附中文译文，收在 `project-examples.json`；`import-tatoeba-ky-examples.mjs` 优先取这里的句子，
没有的才退回占位句并在末尾提醒补写。这些句子由本项目撰写，不主张任何权利。

---

## 依赖说明

`seek-bzip@2.0.0` 仅用于 `import-tatoeba-ky-examples.mjs` 解压官方导出包，
是 devDependency，**不进入服务端运行时和浏览器打包产物**。

---

## 历年真题（不在本目录，位于 vault 的 `.kb/exams/`）

- **来源**：[计算机考研杂货铺](https://www.csgraduates.com/study_methods/) 的 英语 / 数学 / 408 历年真题页与真题标签页
- **许可**：站点声明「保留所有权利」。真题本身是公开考试内容，解析、范文与标签是站点作者的整理成果，
  因此抓取结果**只作个人练习使用**，存放在被 git 忽略的 `.kb/exams/`，不随仓库分发
- **重新生成**：`node scripts/import-exams.mjs`（每个 JSON 都保留 `source` 字段指回原页面）
- **依赖**：`node-html-parser@9` 仅用于这个脚本解析页面，是 devDependency，不进入服务端运行时和浏览器打包产物
