#!/usr/bin/env node
/**
 * 把两个 SQLite 库的 WAL 合并回主文件（PRAGMA wal_checkpoint(TRUNCATE)）。
 * 提交 .kb/*.db 到 git 之前跑一下，否则没 checkpoint 的写入还留在 -wal 里，
 * 换台电脑 clone 下来就丢了。服务在跑也没关系，会等它空闲。
 *
 *   node scripts/checkpoint-db.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from '../server/config.js';

for (const name of ['index.db', 'vocabulary.db']) {
  const file = path.join(VAULT_ROOT, '.kb', name);
  if (!fs.existsSync(file)) { console.log(`${name}：不存在，跳过`); continue; }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000;');
  const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();
  const wal = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
  console.log(`${name}：checkpoint busy=${r.busy} log=${r.log} checkpointed=${r.checkpointed}，主文件 ${(fs.statSync(file).size / 1024).toFixed(0)}KB，WAL 剩 ${wal} 字节`);
}
