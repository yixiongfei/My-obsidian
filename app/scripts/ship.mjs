#!/usr/bin/env node
/**
 * 一键发版：提交 → 打标签推送 → 本机打包 → 覆盖安装 → 重启桌面端 → 等 GitHub Release 挂好安装包。
 *
 * 用法（在 app/ 下）：
 *   node scripts/ship.mjs "release: 1.0.10（一句话说明）"        自动把 patch 号 +1
 *   node scripts/ship.mjs -v 1.1.0 "release: 1.1.0（…）"         指定版本
 *   node scripts/ship.mjs --no-build "…"                         只提交推送，不打包不装
 *   node scripts/ship.mjs --no-wait "…"                          不等 Actions
 *
 * 步骤：
 *   1. scripts/checkpoint-db.mjs 把 WAL 合进 .kb/*.db
 *   2. git add：app/、.kb/*.db、My-md/、.gitignore（根目录 review_log.jsonl 和 图像/ 不进库）
 *   3. 改 app/package.json 的 version，commit，打 vX.Y.Z 标签，推 dev + 标签，release 分支快进并推
 *   4. npm run electron:build → release/kb-X.Y.Z-setup.exe
 *   5. 关掉正在跑的桌面端，静默安装（/S），重新启动
 *   6. 轮询 GitHub Actions（匿名 REST），直到 Release 里出现安装包
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const PKG = path.join(APP, 'package.json');
const REPO = 'yixiongfei/My-obsidian';
const APP_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'obsidian-knowledge-base', '知识库.exe');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const opt = (name) => { const i = args.indexOf(name); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } return null; };
const noBuild = flag('--no-build');
const noWait = flag('--no-wait');
const noInstall = flag('--no-install');
const version = opt('-v');
const message = args.join(' ').trim();
if (!message) { console.error('要给提交说明：node scripts/ship.mjs "release: 1.0.10（…）"'); process.exit(2); }

const sh = (cmd, cwd = ROOT, quiet = false) => {
  if (!quiet) console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
};
const out = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

// ── 1. 版本号 ──
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const next = version || pkg.version.replace(/(\d+)$/, (m) => String(Number(m) + 1));
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error(`版本号不合法：${next}`); process.exit(2); }
if (out('git tag -l v' + next)) { console.error(`标签 v${next} 已经存在`); process.exit(2); }
const branch = out('git branch --show-current');
if (branch !== 'dev') { console.error(`当前在 ${branch}，发版要在 dev 上`); process.exit(2); }

console.log(`\n▶ 发版 ${pkg.version} → ${next}\n`);

// ── 2. 落库、提交、推送 ──
sh('node scripts/checkpoint-db.mjs', APP);
fs.writeFileSync(PKG, fs.readFileSync(PKG, 'utf8').replace(/"version": "[^"]+"/, `"version": "${next}"`));
sh('git add app .kb/index.db .kb/vocabulary.db My-md .gitignore');
const staged = out('git diff --cached --name-only');
if (!staged) { console.error('没有要提交的改动'); process.exit(2); }
const msg = `${message}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`;
const tmp = path.join(APP, 'release', '.commit-msg.txt');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, msg);
sh(`git -c core.autocrlf=true commit -q -F "${tmp}"`);
fs.unlinkSync(tmp);
sh(`git tag v${next}`);
sh('git push -q origin dev');
sh(`git push -q origin v${next}`);
sh('git branch -f release dev');
sh('git push -q -f origin release');
console.log(`\n✓ 已推送 dev / release / v${next}\n`);

// ── 3. 本机打包、装、重启 ──
if (!noBuild) {
  sh('npm run electron:build', APP);
  const exe = path.join(APP, 'release', `kb-${next}-setup.exe`);
  if (!fs.existsSync(exe)) { console.error(`没找到 ${exe}`); process.exit(1); }
  console.log(`✓ 安装包 ${exe}（${(fs.statSync(exe).size / 1048576).toFixed(0)} MB）`);

  if (!noInstall && process.platform === 'win32') {
    console.log('关闭桌面端…');
    spawnSync('taskkill', ['/IM', '知识库.exe', '/F'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    console.log('静默安装…');
    const r = spawnSync(exe, ['/S'], { stdio: 'ignore' });
    if (r.status !== 0) { console.error(`安装退出码 ${r.status}`); process.exit(1); }
    if (fs.existsSync(APP_EXE)) {
      spawn(APP_EXE, [], { detached: true, stdio: 'ignore' }).unref();
      console.log(`✓ 桌面端 ${next} 已启动`);
    } else {
      console.warn(`装完没找到 ${APP_EXE}`);
    }
  }
}

// ── 4. 等 GitHub Release ──
if (!noWait) {
  console.log('\n等 GitHub Actions 打包…');
  const started = Date.now();
  for (;;) {
    let status = '';
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=3`);
      const j = await res.json();
      const run = (j.workflow_runs || []).find((x) => x.head_branch === `v${next}`);
      status = run ? `${run.status}:${run.conclusion}` : 'pending';
      if (run?.status === 'completed') {
        if (run.conclusion !== 'success') { console.error(`✗ Actions ${run.conclusion}：${run.html_url}`); process.exit(1); }
        const rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${next}`)).json();
        console.log(`✓ ${rel.html_url}\n  ${(rel.assets || []).map((a) => a.name).join(', ')}`);
        break;
      }
    } catch (e) { status = `网络错误 ${e.message}`; }
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    process.stdout.write(`  ${status}（${mins} 分钟）\r`);
    if (Date.now() - started > 25 * 60000) { console.error('\n等了 25 分钟还没好，去 Actions 页面看看'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 30000));
  }
}
console.log('\n完成。');
