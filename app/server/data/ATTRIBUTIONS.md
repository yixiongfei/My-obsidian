# 离线数据来源与署名

本目录下的 JSON 都是离线种子，由 `app/scripts/` 里的脚本从公开数据源生成。
运行时和复习过程**不访问任何第三方网络**。

---

## lists/ — 词表范围与词频（2025 版）

词表不再靠 ECDICT 的 `ky` 标签，而是下面三份清单的并集，ECDICT 只负责补音标和释义。

| 文件 | 内容 | 来源 / 许可 |
|---|---|---|
| `syllabus-2025.txt` | 2025 硕士研究生英语（一）大纲词汇，5,680 词 | 教育部考试中心公开大纲；纯词形清单 |
| `zhenti-2025.txt` | 《2025 考研真相·真题词汇篇》词形清单，按章节排列：高频 / 中频 / 低频 / 基础 / 超纲派生 | 仅取词形，不含书中释义与例句；作个人学习范围使用 |
| `netem_full_list.json` | [exam-data/NETEMVocabulary](https://github.com/exam-data/NETEMVocabulary) 的「5530 考研词汇词频排序表」 | **CC BY-NC-SA 4.0**，作者 exam-data；本项目非商业使用，取 `词频` 与 `释义` 两列 |

分档（`tier`）：`basic` = 真题词汇篇「基础」章；其余按 NETEM 真题词频 ≥40 `core`、10–39 `mid`、1–9 `low`、
未在 NETEM 出现的超纲 / 派生词 `extra`。`rank` = core → mid → low → extra 顺序、同档词频降序，是复习队列的出词顺序；
basic 排最后、默认不进队列（设置里可打开）。

---

## ecdict-ky.json — 考研词表

- **来源**：[ECDICT](https://github.com/skywind3000/ECDICT)
- **许可**：MIT License
- **锁定版本**：commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- **筛选口径**：词形落在 `lists/` 并集内（小写、`’`→`'`）；ECDICT 没收的 13 个合成词用 NETEM 释义占位
- **规模**：6,065 条（core 1,158 / mid 1,373 / low 1,299 / extra 412 / basic 1,823）
- **重新生成**：`node scripts/import-ecdict-ky.mjs [ecdict.csv]`

钉死 commit 而不是跟 master：ECDICT 会持续更新词条和标签，跟着 master 走会让
每次重新生成的词表都不一样，对不上账。

保留字段：英文词形、音标、中文释义、英英释义、NETEM 词频、`tier` / `rank`，以及 `考研 / 英语一 / 大纲2025 / 真题词汇` 标签。

换词表后原 `ky` 词表里多出来的 236 个词（abundance、accustomed 这类）在库里标 `retired = 1`：不再出新词，
但已有的复习记录和到期复习照旧。

---

## tatoeba-ky-examples.json — 例句

- **来源**：[Tatoeba](https://tatoeba.org) 英语句子导出
- **许可**：CC BY 2.0 FR
- **输入包**：`https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2`
- **输入包 SHA-256**：记录在 JSON 的 `inputSha256` 字段里
- **匹配口径**：大小写不敏感的**精确 token 匹配**（剥掉首尾标点后整词相等）
- **规模**：5,952 条 Tatoeba 例句
- **重新生成**：`node scripts/import-tatoeba-ky-examples.mjs [eng_sentences.tsv.bz2]`

每条例句都保留原始 sentence id 和可回溯 URL（`https://tatoeba.org/en/sentences/show/<id>`），
满足 CC BY 的署名要求。

筛选规则：只保留 5–22 词的自然短句，过滤链接、非 ASCII 残留、重复词，以及 Tatoeba 里
铺天盖地的 Tom / Mary 模板句；中性陈述句优先。

---

## 项目自备兜底例句

- **许可**：CC0（放弃权利，可自由使用）
- **规模**：122 条

Tatoeba 没覆盖到的词（多是英式拼写变体、合成词和短语，如 utilise、peer-review、status quo、per cent）由本项目自己写一句
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
