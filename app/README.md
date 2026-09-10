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
| 仪表盘 | 初试倒计时、今日待复习、复习热力图、各学科掌握度 |
| 笔记 | 目录树 + 阅读页，支持 KaTeX、表格、callout 折叠、wiki 链接互跳、反向链接 |
| 复习 | 到期笔记逐篇过，callout 默认折叠即天然自测；「已掌握 / 需重来」写回仓库 |
| 图谱 | `[[wiki 链接]]` 构成的力导向图，滚轮缩放、点击进入笔记 |
| 日程 | 年表 → 月表 → 日表逐层下钻，带共享元素动画 |

`Ctrl / ⌘ + K` 全局搜索。

## 数据怎么流动

后端不复制任何内容，vault 本身就是唯一数据源：

```
Obsidian 里保存 .md
      ↓ chokidar 监听
Node 重新索引这一个文件
      ↓ SSE 推送
网页自动刷新
```

**复习写回**只动笔记 frontmatter 的三个字段：

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
- **自定义日程** — 仓库根目录的 `schedule.json`（网页上添加时自动创建）

年表和月表顶部的阶段目标，实时解析 `个人/考研倒计时.canvas`——在 Obsidian 里改画布、勾选任务，网站跟着变。

## 目录结构

```
app/
  server/
    index.js            Express 路由 + chokidar 监听 + SSE
    config.js           vault 路径、端口、间隔表
    lib/vault.js        扫描、frontmatter 解析、wiki 链接解析、反向链接
    lib/markdown.js     markdown-it：KaTeX、callout 折叠、[[链接]]、==高亮==
    lib/review.js       间隔重复计算 + frontmatter 逐行写回
    lib/schedule.js     年/月/日聚合 + 画布路线图解析
    lib/query.js        搜索、图谱、仪表盘统计
  web/src/
    views/              Dashboard / Notes / Review / Graph / Schedule
    components/         Shell、命令面板、Prose、复习浮条
    styles/             base（设计系统）· markdown（正文）· views（各视图）
  electron/main.cjs     选仓库 → 起服务 → 开窗口
```

配色只有黑、白、蓝三族，全部定义在 `styles/base.css` 顶部的 CSS 变量里，改那一处就能整站换肤。深浅两套主题，左下角切换。
