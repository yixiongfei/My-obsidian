import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用目录 app/ */
export const APP_ROOT = path.resolve(__dirname, '..');

/**
 * Obsidian 仓库根目录（.obsidian、.kb、app 都在这一层）。
 * 默认取 app/ 的上一级（本仓库自身即 vault）。
 * 打包成桌面程序后由 VAULT_ROOT 环境变量指定用户自己的 vault 路径。
 */
export const NOTES_DIR = (process.env.NOTES_DIR ?? 'My-md').trim();

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * 桌面版让用户选文件夹时，选到 My-md/ 本身（而不是它上一级的仓库根）是很自然的事——
 * 那样 .kb/、app/tags.yaml 全都找不到，真题、标签、复习记录一起消失。
 * 所以：选中的目录自己没有 .kb/ 但上一级有、且它正是上一级的 NOTES_DIR，就把上一级当仓库根。
 */
function resolveRepoRoot(given) {
  const root = path.resolve(given);
  const parent = path.dirname(root);
  // 选错一次之后 My-md/ 里会被建出一个空的 .kb/，所以不能拿「自己有没有 .kb」当依据，只看名字和上一级
  if (parent !== root && path.basename(root) === NOTES_DIR && isDir(path.join(parent, '.kb'))) return parent;
  return root;
}

export const REPO_ROOT = resolveRepoRoot(process.env.VAULT_ROOT || path.resolve(APP_ROOT, '..'));

/**
 * 笔记根目录：仓库里的 My-md/。笔记、图片、画布全部收在这一个文件夹里，
 * 云端只需保留它；索引、真题、语音缓存这些派生数据留在仓库根的 .kb/，不混进去。
 * 笔记 id 相对这一层算（数学/…、英语/…），所以把文件夹整体搬进 My-md 不会让
 * 复习记录、错题本、词汇日志里的路径失效。
 * 可用 NOTES_DIR 环境变量换名字；该目录不存在时退回整个仓库根（老布局）。
 */
const notesRoot = NOTES_DIR ? path.join(REPO_ROOT, NOTES_DIR) : REPO_ROOT;
export const VAULT_ROOT = isDir(notesRoot) ? notesRoot : REPO_ROOT;

/** 派生数据目录：SQLite 索引、词汇库、真题 JSON、语音缓存 */
export const KB_DIR = path.join(REPO_ROOT, '.kb');

export const PORT = Number(process.env.PORT) || 5174;

/** 扫描与监听时跳过的目录 */
export const IGNORED_DIRS = new Set([
  '.git', '.obsidian', '.claudian', '.claude', '.kb', 'app',
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

/**
 * 只把这几个顶层目录下的 .md 当成笔记。
 *
 * 「个人」里的随笔、各种工具目录里的说明文档不是考点，暂不进知识库；
 * 以后要多收一个学科，在这里加一项即可（也可用 NOTE_DIRS 环境变量按逗号覆盖）。
 * 列表为空表示不设限、扫整个 vault。
 *
 * 只限制 .md：图片和 .canvas 仍然全库扫描——路线图画布在「个人」里，
 * 笔记嵌入的图片也可能放在任何位置。
 */
export const NOTE_DIRS = (process.env.NOTE_DIRS !== undefined
  ? process.env.NOTE_DIRS.split(/[,，;]/)
  : ['数学', '英语', '408', '图像'])
  .map((s) => s.trim()).filter(Boolean);

/** 笔记 id（POSIX 相对路径）是否在允许的目录里 */
export const isNotePath = (id) =>
  NOTE_DIRS.length === 0 || NOTE_DIRS.some((d) => id === d || id.startsWith(`${d}/`));

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

/** 间隔重复表：第 n 次复习之后，距离下一次的天数 */
export const INTERVALS = [1, 2, 4, 7, 15, 30];

/* 复习日志与标签词表是用户数据，跟着仓库走：本仓库放在 <仓库>/app/ 下。
   打包后的程序 APP_ROOT 在安装目录里，绝不能把这两个文件写到那儿去（升级就丢）——
   仓库里没有 app/ 的（别人的 vault）就落到 .kb/ */
const userFile = (name) => {
  const inApp = path.join(REPO_ROOT, 'app', name);
  return isDir(path.join(REPO_ROOT, 'app')) ? inApp : path.join(KB_DIR, name);
};
export const REVIEW_LOG = userFile('review_log.jsonl');
export const TAGS_FILE = userFile('tags.yaml');
/** 旧版日程文件，仅用于首次启动时向 SQLite 迁移 */
export const SCHEDULE_FILE = path.join(REPO_ROOT, 'schedule.json');

/** 考试日期，可被 schedule.json 的 examDate 覆盖 */
export const DEFAULT_EXAM_DATE = '2027-12-21';
