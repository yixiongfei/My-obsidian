# 知识库

把这个 Obsidian 仓库变成一个可浏览、可复习、可回顾的网站。Vite + React 前端，Node 后端实时读取 vault，Electron 打包成 Windows 桌面程序。

## 跑起来

推荐用 pnpm：

```bash
cd app
pnpm install
pnpm run dev          # 前端 5173 + 后端 5174，打开 http://localhost:5173
pnpm run build
pnpm start            # 生产模式，后端同时托管前端：http://127.0.0.1:5174
```

已经装好 Node/npm 的环境按项目兼容性用 npm 也可以，把上面的 `pnpm` 换成 `npm` 即可。
脚本不依赖任何全局 shim：开发时直接用 Node 起服务端、用 Vite 起前端，Electron 打包也是直接调 `vite build`。

## 数据放在哪、哪些能重建

| 数据 | 真相在哪 | 能否重建 |
|---|---|---|
| 笔记正文 | `.md` 文件 | —— 它本身就是真相 |
| 笔记索引（notes/headings/links/全文检索） | `.kb/index.db` | **能**，删掉下次启动从 Markdown 原样长回来 |
| 本机日程（events） | `.kb/index.db` | **不能**，属于持久数据 |
| 英语词汇排期与复习历史 | `.kb/vocabulary.db` | **不能**，公开词表种子恢复不了个人进度 |
| 公开词表与例句 | `app/server/data/*.json` | **能**，见 `scripts/` 下的两个导入脚本 |
| 笔记复习日志 | `app/review_log.jsonl` | **不能**，只增不改的复习事件流 |
| 真题题面与标签 | `.kb/exams/*.json`（已进 git） | **能**，`node scripts/import-exams.mjs` 重新抓取 |
| 真题作答记录、划的句子 | `.kb/index.db` 的 `exam_attempts` / `exam_marks` | **不能**（随仓库提交） |
| 考点标签受控词表 | `app/tags.yaml` | —— 手写维护，思维导图与首页学科图的骨架 |

## 仓库布局：笔记全在 `My-md/`

```
<Obsidian 仓库>/
  My-md/            ← 笔记根目录：数学 / 英语 / 408 / 图像 / 个人，云端只需保留这一个文件夹
  .kb/              ← 派生数据：index.db、vocabulary.db、exams/、tts/（随 git 走，不需要另外同步）
  app/              ← 本站
  .obsidian/
```

服务端以 `My-md/` 为笔记根（`config.js` 的 `VAULT_ROOT`），笔记 id 相对它计算——还是 `数学/高等数学/xxx.md`，
所以复习记录、错题本、词汇日志、划句的路径都不受搬家影响。`NOTES_DIR` 环境变量可以换名字；
目录不存在时退回整个仓库根（老布局）。`.kb/` 始终在仓库根，由 `KB_DIR` 指定。

`.kb/` 里的两个 `.db` 已随仓库提交，clone 下来就能用；提交前跑 `node scripts/checkpoint-db.mjs`
把 `-wal` 里的写入并进主文件。

重导公开词表**不会**重置你的卡片进度——种子只补充释义、音标、例句，一行都不碰 `vocab_cards`。

## 打包成 Windows 程序

```bash
npm run electron:dev     # 桌面窗口里跑开发版
npm run electron:build   # 产出 release/kb-<版本>-setup.exe（约 100MB）
```

打包后第一次启动会让你选 Obsidian 仓库文件夹（选仓库根，程序自己找里面的 `My-md/`；不小心选到 `My-md/` 本身
也会自动退回上一级，不会在笔记目录里再建一个空的 `.kb/`），选过一次就记住了；设置面板或菜单里可以随时切换。
程序自带后端，随机挑一个空闲端口，不会和别的服务抢；只允许开一个实例，再点一次图标只会把已有窗口拉到前面。
桌面版读的是同一个仓库的 `.kb/` 与 `app/tags.yaml`、`app/review_log.jsonl`，和网页版数据完全一致。

顶栏「白天 / 夜间」左边的齿轮是**设置**：主题、界面缩放、启动时打开哪一页、重置本机界面记忆；
桌面版多出「窗口」（窗口 / 最大化 / 全屏，立即生效并记住）和「仓库」（当前路径、打开数据 / 笔记文件夹、切换仓库）。
窗口大小位置在普通窗口模式下会记住。`KB_SMOKE=1 ELECTRON_DEV=1 npx electron .` 可以无人值守地自检 preload 桥与窗口模式。

Windows 本机打包时 electron-builder 会解压 `winCodeSign`，里面两个 macOS 符号链接在没有
「创建符号链接」权限的账户下会报错。绕过：用 7za 手动把
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<随机数>.7z` 解到同目录的 `winCodeSign-2.6.0/`
（两个 dylib 报错忽略），再跑一次 build 就会直接用缓存。

### 发布：打标签，GitHub 自动出安装包

安装包超过 GitHub 单文件 100MB 上限，不进 git 分支；由 [`.github/workflows/release.yml`](../.github/workflows/release.yml)
在推送 `v*` 标签时于 windows-latest 上打包，并挂到同名 Release：

```bash
# 改 app/package.json 的 version，提交后：
git tag v1.0.1
git push origin v1.0.1
```

几分钟后到仓库的 Releases 页下载 `kb-1.0.1-setup.exe`。换电脑：clone 仓库（带 `My-md/` 与 `.kb/`）→ 装安装包 → 首次启动选 clone 下来的文件夹。

分支约定：`dev` 日常开发；`release` 只在发版时快进到打了标签的提交，永远可装可用。

## 六个视图

| 视图 | 做什么 |
|---|---|
| 首页 | 首屏是标题与学科图，往下滚是倒计时与五个入口 |
| 仪表盘 | 倒计时、**考点进度**（今天学了哪些、还剩多少没学、多少要复习、每科走到哪）、待复习笔记、复习热力图、标签分布、最近复习 |
| 笔记 | 可折叠的文件树（一级目录带学科色）+ 结构图（学科 → 分支 → 考点 → 笔记，可折叠）+ 阅读页，支持 KaTeX、表格、callout 折叠、wiki 链接互跳、反向链接 |
| 复习 | **英语词汇 Anki**：每轮最多 100 张到期卡 + 20 个新词，四档评分，Space 翻面、1/2/3/4 评分 |
| 日程 | 年表 → 月表 → 日表逐层下钻，日视图含当天的词汇完成数 |
| 资源 | **历年真题**：英语一 / 二、数学一 / 二 / 三、408，按真卷版式出题，整单元交卷后才给答案；408 与数学另有知识点标签页 |

笔记的深度复习**不在**「复习」页：数学和 408 这类知识点要回到笔记原文长时间琢磨，
所以阅读页标题右侧的「复习这篇」打开**阅读模式**——全屏，一张细格子的素白笔记纸，只剩标题和正文，
没有顶栏、侧栏、字数日期链接这些和知识无关的东西；夜间主题下纸也是白的。底部悬浮条记一次复习
（需重来 / 已掌握，可附一句本次理解）就退出，Esc 或右上角 × 也能退。只有英语单词才做成卡片。

## 英语词汇 Anki

- 词表：ECDICT 考研标签 4801 条，例句来自 Tatoeba，全部离线，复习时不访问任何第三方网络
- 排期：`again` 归零重来 / `hard` 缩短 / `good` 按难度系数推进 / `easy` 直接毕业，之后永不再出现
- 翻卡不等磁盘：评分只写 SQLite 和一个脏标记就返回，Markdown 日志在闲置 30 秒或一轮结束后合并写一次
- 日志按 ISO 周落在 `英语/词汇复习/YYYY-Www.md`（周内按日期分节），只替换 `<!-- kb:vocab:start -->` 到 `end` 之间的自动区，
  区外你自己写的手记不会被覆盖；早期按天的文件若没有手写内容会自动并入周文件
- 发音：先走 `/api/tts`——转发到 AIchat 仓库里的 tts-voice-magic Worker（`en-US-JennyNeural`，可用 `TTS_URL` / `TTS_API_KEY` 环境变量覆盖），
  合成结果缓存在 `.kb/tts/`，同一个词第二次就是本地文件；Worker 不通时前端退回系统语音（美式女声）。
  这是整站唯一会出网的地方，而且只在「发音」开关打开后才发请求。开着时翻卡即读，例句旁可单独朗读
- 单词列表（复习页右上角）：今日 / 未学习 / 学习中 / 已熟识四栏，能加词、标重要；**点一行展开编辑**音标、义项和例句——
  种子里的 ECDICT 释义和 Tatoeba 例句有错就在这儿改，改过的词打上 `user_edited`，以后词表升级不会覆盖；一个词可以配多句例句，卡背会全部列出

数据来源与署名见 [`server/data/ATTRIBUTIONS.md`](server/data/ATTRIBUTIONS.md)。

`Ctrl / ⌘ + K` 全局搜索。

wiki 链接的关系图没有做——Obsidian 自带的 graph view 已经覆盖了。

## 历年真题

题面抓自 [计算机考研杂货铺](https://www.csgraduates.com/study_methods/)，一次抓完放在 `.kb/exams/`（英语 34 套、数学 57 套、408 18 套，
加两份知识点标签）。该站声明保留所有权利，抓下来只作个人练习，所以数据和 SQLite 一样留在 `.kb/` 里、不进 git：

```bash
node scripts/import-exams.mjs            # 全部，约 180MB（含原始页面缓存与图片）
node scripts/import-exams.mjs 408        # 只抓一科：english1 english2 408 math1 math2 math3 tags
node scripts/import-exams.mjs --reparse  # 不联网，用缓存重新解析
```

**答案由服务端把关**：`/api/exams/:id` 交卷前不下发答案、解析和知识点标签，DevTools 里也看不到；
`POST …/submit` 之后才随响应返回。「交卷」的粒度是单元——英语的完形 / 每篇阅读 / 新题型 / 翻译 / 作文，
408 的四门选择题各一块 + 综合题逐题，数学的选择 / 填空各一块 + 解答题逐题。草稿边做边存，刷新不丢；重做就清掉这一单元。

- 完形的空是可回填的：选了词就写进正文的下划线上，判完卷再打对错
- 新题型（英语 Part B）的答案格式站点每年都不一样，脚本尽力提取；提不出来时前端退化为「对照解析自评」
- 数学公式是站点 KaTeX 渲染好的 HTML，原样保留；408 的代码块去掉了 Chroma 高亮只留纯文本
- 主观题分值按题面里的「本题满分 N 分」「（4 分）」相加得来，写没写就不显示、也不计总分
- 知识点标签页（`/resources/tags/408`、`/resources/tags/math`）来自站点的真题标签页，点题号跳到对应卷子的那道题（`?q=题号`）

源站数据本身有几处瑕疵（2010 英语一完形缺第 3 空、2023 英语一一句话重复、2026 数学三还没写完），脚本不猜，原样保留。

**卷面上的两种留痕**

- 生词：英语卷里双击一个词 → 记进词汇库。先做一轮粗糙的词形还原（criticized → criticize），
  对得上考研词表的画红线、标在原词条上；对不上的建自定义词、画蓝线。标注词在 Anki 队列里插队。
- 句子：选中一句右键「标记句子」→ 荧光笔，黄 / 绿 / 蓝 / 粉四色可选、记住上次用的。真相在 `exam_marks` 表，
  投影到 `英语/语法/真题例句.md`——和词汇日志一个节奏：只落脏标记，闲置 30 秒或离开卷面时合并写一次。
  md 里每句带 `?hl=标记id` 的链接，点开直接滚到那一句；卷面右栏也列出本卷的书签。
- 错题：每道题右侧「错题」把题干 / 选项 / 答案解析追加到 `<学科>/错题本/<年份 科目>.md`，
  frontmatter 带知识点标签。公式没有 TeX 源，只能取 KaTeX 的渲染文本裹在反引号里；
  图片不搬，换成回到原题的链接。答案只在那一单元交过卷之后才附。

**数据随仓库走**：`.kb/*.db`（复习进度、真题作答、标注）和 `.kb/exams/*.json`、`img/` 都进 git，
换电脑 clone 下来就能用；`raw/` 页面缓存和 `-wal/-shm` 不进。提交前跑一下
`node scripts/checkpoint-db.mjs` 把 WAL 合并回主文件，否则最近的写入还留在 -wal 里。
两台电脑**不要同时**改同一个 .db——SQLite 是二进制，git 合并不了。

## 两个图不是装饰

**首页的学科图按主题换一张画法**，数据是同一份（tags.yaml 的一级学科）：

- **夜间 · 等距立柱** —— 一段 = 一个学科，笔记最多的那科在顶端涂成实心，没有笔记的是纯线框；外圈虚线是复习周期，轨道上的小方块是下一次复习，顶端连到代表初试的线框球
- **白天 · 轨道图** —— 一个点 = 一个学科，点的大小 = 篇数，空学科是空心圈；点按学科个数均分一圈，三科就是一个三角形，不会挤在一侧

**笔记页的结构图**以受控词表为骨架，不按目录结构。于是：

- 词表里声明了、还没有笔记的分支会**先占好位置**，用虚线标成「待填充」
- 只打了大类标签、没打分支标签的笔记会落在「未归类到分支」，顺手查出打标签的漏网

数学和 408 的分支下面再挂一层**考点**——名字就是真题标签（`.kb/exams/tags-*.json` 里的知识点），当锚点用。
我的笔记不是考点本身，而是学某个考点时写的感悟，所以一篇笔记按「标题就是考点名 / 打了这个标签 / 标题里含考点名」归到考点下，
标点和「的」不计较（`函数，极限，连续` 对得上 `函数、极限、连续`）。于是一个考点的状态就是学习过程本身：

- **今日学习**（实心蓝）——对上的笔记今天新建 / 首次复习；**待复习**（实心琥珀）——那篇笔记到期了
- **已学**（空心深）——有笔记；**未学**（空心浅）——一篇都没有，点它直接去看这个考点的历年真题
- 学科和分支都能折叠；展开的分支只列已学考点，未学的收在「还有 N 个未学考点」一行里，点开才全列。折叠状态记在本机

仪表盘的顶部数字和「考点进度」「今日学习」「待复习考点」「接下来可以学」都从这一层算出来。

这和 Obsidian 的 graph view 不重叠——那个画 `[[wiki 链接]]`，这个画从属关系。

## 数据怎么流动

**.md 文件始终是笔记的唯一真相**，SQLite 只是从它派生出来的索引层：

```
Obsidian 里保存 .md
      ↓ chokidar 监听
Node 重解析这一个文件 → 写进 SQLite
      ↓ SSE 推送
网页自动刷新
```

删掉 `.kb/index.db` 下次启动会原样重建，所以它不进 git。

**只有 `server/config.js` 里 `NOTE_DIRS` 列出的顶层目录会被当成笔记来源**（目前是 数学 / 英语 / 408 / 图像）。
「个人」里的随笔、工具目录里的说明文档不进索引、不进目录树、不进复习队列；要多收一个学科就在那个数组里加一项，
或者启动时用 `NOTE_DIRS=数学,英语,408,政治` 环境变量覆盖。这个限制只针对 `.md`，图片和 `.canvas` 仍然全库扫描——
路线图画布就在「个人」里。

用的是 Node 22 内置的 `node:sqlite`——零依赖，不用编译原生模块，Electron 37+ 同样是 Node 22，桌面端和服务端共用一份代码。

库里存三类东西：

| 表 | 内容 | 从哪来 |
|---|---|---|
| `notes` `tags` `headings` `links` | 笔记索引与链接关系 | 扫描 .md 派生 |
| `notes_fts` | 全文检索（FTS5 trigram 分词） | 同上 |
| `reviews` | 复习历史 | `review_log.jsonl` 的镜像 |
| `events` | 自定义日程 | **本库是唯一真相** |
| `exam_attempts` | 真题作答（草稿 / 交卷时间 / 得分） | **本库是唯一真相** |

全文检索用 trigram 分词器：中文没有词边界，默认的 unicode61 切不开。代价是查询词必须 ≥ 3 个字符，所以「矩阵」「极限」这类两字词自动退回 `LIKE` 匹配。

**复习写回是三处同时写**：笔记 frontmatter（给 Obsidian 看）、`review_log.jsonl`（给你那份 schema 和 Claudian 看）、SQLite（只为统计快）。前两者是契约，第三者随时能从前两者重建。

frontmatter 只动三个字段：

```yaml
review_count: 3
last_reviewed: 2026-09-10
next_review: 2026-09-17
```

正文一个字节都不改（用的是逐行替换，不是 YAML 重新序列化，所以 `tags: [a, b]` 这种写法也会原样保留）。同时向 `app/review_log.jsonl` 追加一行（每行一条 JSON：`date` / `note_path` / `tags` / `review_count_after` / `added_content` / `source`），间隔表如下：

| 已复习次数 | 距下次天数 |
|---|---|
| 0 → 1 | 1 |
| 1 → 2 | 2 |
| 2 → 3 | 4 |
| 3 → 4 | 7 |
| 4 → 5 | 15 |
| 5+ | 30 |

选「需重来」时次数照常累加（`review_count` 是累计值），但下次仍排在明天。

## 日程数据从哪来

日表上的四类信息各有来源，全部实时算出，不落库：

- **待复习** — 笔记 frontmatter 的 `next_review`
- **已复习** — `review_log.jsonl`
- **新建** — 笔记 frontmatter 的 `created`
- **自定义日程** — SQLite 的 `events` 表（旧的 `schedule.json` 首次启动会自动迁移进来，原文件改名成 `.migrated` 留档）
- **日本の祝日** — `server/lib/holidays.js` 纯算法推算，不联网不打表

## 日本节假日

日历按日本习惯周日起头（日 月 火 水 木 金 土），周日和祝日的日期标红。祝日是算出来的，不是硬编码的表：

1. 本体 —— 固定日、ハッピーマンデー（第 n 个星期一）、春分・秋分（1980–2099 适用的近似式）
2. 振替休日 —— 本体落在周日，顺延到之后第一个非祝日
3. 国民の休日 —— 被两个祝日夹住的平日

第 2、3 条必须在第 1 条之后按序算。2026 年 5/3 憲法記念日是周日，5/4、5/5 本身也是祝日，所以振替休日一路顺延到 5/6；9 月 21 日敬老の日与 23 日秋分の日夹出 22 日的国民の休日，也就是シルバーウィーク。

年表和月表顶部的阶段目标，实时解析 `个人/考研倒计时.canvas`——在 Obsidian 里改画布、勾选任务，网站跟着变。

## 设计：一副骨架，两套语言

同一批组件，靠 `web/src/styles/base.css` 顶部那组变量分岔成两种完全不同的观感：

| | 夜间 | 白天 |
|---|---|---|
| 气质 | 瑞士网格 | 日式纸感 |
| 底色 | 近黑 `#08090A` | 暖纸 `#EDEAE1` |
| 主色 | 电光蓝 `#2C5CFF` | 墨绿 `#2E6B4F` |
| 圆角 | 0 | 5–8px |
| 质地 | 纯色 + 1px 线 | 叠一层 feTurbulence 噪点做纸纹 |

纸纹那层有个坑值得记一笔：`feTurbulence` 默认对 R/G/B **各生成一套独立噪声**，直接铺上去每个像素的三通道会各偏几级，大面积纯色上看着就是「发花」。用 `feColorMatrix` 把 RGB 全压成 0、只把噪声喂给 alpha，它就变成一层纯黑的疏密变化，色相零偏移。实测同像素 RGB 极差从最大 16 降到 12——正好等于底色 `#EDEAE1` 自身的极差，也就是完全不引入色偏。

另外没有用 `mix-blend-mode: multiply`：它的强度随底色亮度变化，`#EDEAE1` / `#F6F4EE` / `#FBFAF6` 三种面板上纸纹粗细会不一样。普通 alpha 才是各处一致的。

组件层不写死任何颜色、圆角、字体，全部走变量，所以加第三套主题只需要再写一组 `:root[data-theme=...]`。

西文和数字用自托管的 Archivo（latin 子集 35KB，离线可用），中文走系统字体栈（PingFang SC / 微软雅黑）——**没用中文衬线**：参考稿本身就是无衬线，纸感来自底色与留白；而且中文衬线在各系统上可用性差别太大，不值得赌。大号数字走 Georgia。

设计稿源文件在 `app/design/*.dc.html`。

## 目录结构

```
app/
  server/
    index.js            Express 路由 + chokidar 监听 + SSE
    config.js           vault 路径、端口、间隔表
    lib/vault.js        扫描、frontmatter 解析、wiki 链接解析、反向链接
    lib/markdown.js     markdown-it：KaTeX、callout 折叠、[[链接]]、==高亮==
    lib/review.js       间隔重复计算 + frontmatter 逐行写回
    lib/db.js           SQLite 建表（node:sqlite）+ 事务封装
    lib/sync.js          .md / review_log.jsonl → SQLite 的同步
    lib/schedule.js     年/月/日聚合 + 画布路线图解析
    lib/query.js        全文检索、复习分桶、仪表盘统计
  server/lib/points.js    考点层：真题标签 → 考点清单，笔记归考点、学习进度汇总
  server/lib/mindmap.js   按 tags.yaml 词表组装的从属关系树（分支下挂考点）
  server/lib/holidays.js  日本の祝日推算
  server/lib/exams.js     真题：按需加载卷子、作答记录、交卷判分、答案把关
  scripts/import-exams.mjs  抓取并整理真题（英语 / 408 / 数学 + 知识点标签）
  web/src/
    views/              Home（首页）/ Dashboard / Notes / Review / Words（单词列表）/ Schedule / Resources（真题列表）/ Exam（卷面）/ ExamTags（知识点标签）
    components/         Shell（顶栏）、命令面板、Prose、复习浮条、FolderTree（文件树）、OrbitMap（轨道图）、MindMap（思维导图）
    styles/             base（设计系统）· markdown（正文）· views（各视图）
  design/               设计稿源文件（.dc.html 画板 + canvas.json）
  electron/main.cjs     选仓库 → 起服务 → 开窗口
```
