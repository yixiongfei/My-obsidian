import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用目录 app/ */
export const APP_ROOT = path.resolve(__dirname, '..');

/**
 * Obsidian 仓库根目录。
 * 默认取 app/ 的上一级（本仓库自身即 vault）。
 * 打包成桌面程序后由 VAULT_ROOT 环境变量指定用户自己的 vault 路径。
 */
export const VAULT_ROOT = path.resolve(process.env.VAULT_ROOT || path.resolve(APP_ROOT, '..'));

export const PORT = Number(process.env.PORT) || 5174;

/** 扫描与监听时跳过的目录 */
export const IGNORED_DIRS = new Set([
  '.git', '.obsidian', '.claudian', '.kb', 'app',
  'node_modules', 'dist', 'dist-web', 'release', '.trash', '.vscode',
]);

/**
 * 路径是否落在忽略目录里。
 *
 * 必须同时按 / 和 \ 拆：Windows 下 chokidar 给出的路径两种分隔符都可能出现，
 * 只按 path.sep 拆的话，另一种形式会被当成**一整段**，于是什么都匹配不上——
 * app/node_modules 里上万个文件就全进了监听器，卡顿和内存膨胀都从这儿来。
 */
export const isIgnoredPath = (p) =>
  String(p).split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

/** 间隔重复表：第 n 次复习之后，距离下一次的天数（见 review_log_schema.md） */
export const INTERVALS = [1, 2, 4, 7, 15, 30];

export const REVIEW_LOG = path.join(VAULT_ROOT, 'review_log.jsonl');
export const TAGS_FILE = path.join(VAULT_ROOT, 'tags.yaml');
export const SCHEDULE_FILE = path.join(VAULT_ROOT, 'schedule.json');

/** 考试日期，可被 schedule.json 的 examDate 覆盖 */
export const DEFAULT_EXAM_DATE = '2027-12-21';
