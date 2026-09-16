# 项目记忆

## 发布流程（重要）

- 本项目发布必须从 `app/` 目录运行既有的一键脚本：
  `npm run ship -- "release: X.Y.Z（一句话说明）"`。
- 除非用户明确要求跳过某一步，不要手工拆分或另造发布流程。让 `scripts/ship.mjs` 完整执行：checkpoint DB → git add → 版本号递增 → commit → 标签 → 推送 `dev` / 标签 / `release` → 本机打包 → 静默覆盖安装 → 重启桌面端 → 等待 GitHub Actions 将安装包挂到 Release。
- 运行前先检查工作树，并向用户说明脚本会暂存 `app/`、`.kb/*.db`、`My-md/` 和 `.gitignore`；不得在用户不知情时混入无关改动。
- Windows 本机若在解压 `winCodeSign` 时因两个 macOS `.dylib` 符号链接报权限错误，必须按 `app/README.md` 的既有方法处理 electron-builder 缓存后重跑原发布流程。
- **禁止**使用 `--config.win.signAndEditExecutable=false` 或等价方式生成并安装桌面端。它会跳过 EXE 资源写入，导致任务栏/应用图标退回 Electron 默认图标。
- 如果本机打包暂时无法修复，不安装任何跳过资源写入的替代包；等待 GitHub Actions 完成后，安装同一标签下的正式 Release 安装包。

## 应用图标（重要）

- 正式图标是项目 `app/build/icon.ico` / `app/build/icon.png` 中的蓝底白色四角星图标。
- 未经用户明确要求，不得替换、重绘、绕过或移除该图标，也不得发布带 Electron 默认原子图标的安装包。
