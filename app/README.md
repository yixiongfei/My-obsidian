# 知识库

把这个 Obsidian 仓库变成一个可浏览、可复习、可回顾的网站。Vite + React 前端，Node 后端实时读取 vault，Electron 打包成 Windows 桌面程序。

## 跑起来

```bash
cd app
npm install
npm run dev          # 前端 5173 + 后端 5174，打开 http://localhost:5173
```

生产模式（后端同时托管前端，只需一个端口）：

```bash
npm run build
npm start            # http://127.0.0.1:5174
```

## 打包成 Windows 程序

```bash
npm run electron:dev     # 桌面窗口里跑开发版
npm run electron:build   # 产出 release/ 里的安装包
```

打包后第一次启动会让你选 Obsidian 仓库文件夹，选过一次就记住了；菜单里可以随时切换。

## 五个视图

| 视图 | 做什么 |
|---|---|
| 首页 | 首屏是标题与学科图，往下滚是倒计时与四个入口 |
| 仪表盘 | 倒计时、统计、今日待复习、复习热力图、标签分布、最近复习 |
| 笔记 | 可折叠侧栏 + 思维导图 + 阅读页，支持 KaTeX、表格、callout 折叠、wiki 链接互跳、反向链接 |
| 复习 | 到期笔记逐篇过，callout 默认折叠即天然自测；「已掌握 / 需重来」写回仓库 |
| 日程 | 年表 → 月表 → 日表逐层下钻 |

`Ctrl / ⌘ + K` 全局搜索。

wiki 链接的关系图没有做——Obsidian 自带的 graph view 已经覆盖了。

## 两个图不是装饰

**首页的学科图按主题换一张画法**，数据是同一份（tags.yaml 的一级学科）：

- **夜间 · 等距立柱** —— 一段 = 一个学科，笔记最多的那科在顶端涂成实心，没有笔记的是纯线框；外圈虚线是复习周期，轨道上的小方块是下一次复习，顶端连到代表初试的线框球
- **白天 · 轨道图** —— 一个点 = 一个学科，点的大小 = 篇数，空学科是空心圈；点按学科个数均分一圈，三科就是一个三角形，不会挤在一侧

**笔记页的思维导图**以受控词表为骨架，不按目录结构。于是：

- 词表里声明了、还没有笔记的考点（408 那四门）会**先占好位置**，用虚线标成「待填充」
- 只打了大类标签、没打分支标签的笔记会落在「未归类到分支」，顺手查出打标签的漏网

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

用的是 Node 22 内置的 `node:sqlite`——零依赖，不用编译原生模块，Electron 37+ 同样是 Node 22，桌面端和服务端共用一份代码。

库里存三类东西：

| 表 | 内容 | 从哪来 |
|---|---|---|
| `notes` `tags` `headings` `links` | 笔记索引与链接关系 | 扫描 .md 派生 |
| `notes_fts` | 全文检索（FTS5 trigram 分词） | 同上 |
| `reviews` | 复习历史 | `review_log.jsonl` 的镜像 |
| `events` | 自定义日程 | **本库是唯一真相** |

全文检索用 trigram 分词器：中文没有词边界，默认的 unicode61 切不开。代价是查询词必须 ≥ 3 个字符，所以「矩阵」「极限」这类两字词自动退回 `LIKE` 匹配。

**复习写回是三处同时写**：笔记 frontmatter（给 Obsidian 看）、`review_log.jsonl`（给你那份 schema 和 Claudian 看）、SQLite（只为统计快）。前两者是契约，第三者随时能从前两者重建。

frontmatter 只动三个字段：

```yaml
review_count: 3
last_reviewed: 2026-09-10
next_review: 2026-09-17
```

正文一个字节都不改（用的是逐行替换，不是 YAML 重新序列化，所以 `tags: [a, b]` 这种写法也会原样保留）。同时向 `review_log.jsonl` 追加一行，字段和间隔表完全遵循仓库根目录的 `review_log_schema.md`：

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
  server/lib/mindmap.js   按 tags.yaml 词表组装的从属关系树
  server/lib/holidays.js  日本の祝日推算
  web/src/
    views/              Home（首页）/ Notes / Review / Schedule
    components/         Shell（顶栏）、命令面板、Prose、复习浮条、OrbitMap（轨道图）、MindMap（思维导图）
    styles/             base（设计系统）· markdown（正文）· views（各视图）
  design/               设计稿源文件（.dc.html 画板 + canvas.json）
  electron/main.cjs     选仓库 → 起服务 → 开窗口
```
