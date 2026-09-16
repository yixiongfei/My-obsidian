/**
 * 撕页几何 —— 一个控制点 D，推出整张纸的形状
 *
 * 这是从 Android 那套 TearOffPaperView / TearGeometry 的模型搬过来的，换成 Web 的等价件：
 * Canvas.clipPath → CSS `clip-path: path()`，Canvas.drawPath → 一个 SVG `<path>`。
 * 模型本身一模一样，而且是**纯函数**：进来一个 D，出去两条路径，不碰 DOM、不管动画，
 * 所以可以单独测、单独用。
 *
 * ── 模型 ────────────────────────────────────────────────────────────
 *
 * 纸是矩形 (0,0)-(w,h)，被捏住的角 C 在右上 (w,0)。手指把 C 拖到了 D。
 * 那么纸一定沿着 **CD 的垂直平分线** 折起来——因为折过去之后 C 正好落在 D 上，
 * 折痕上的每个点到 C 和到 D 的距离必然相等。这条线就是折痕，别的点全从它推出来：
 *
 *        A ────────╮ C(w,0)              A、B ── 折痕与纸边的两个交点
 *       ╱          │                     E、F ── 翘起那片自由边的弯曲控制点
 *      D ·         │                     G   ── 折痕自己的弯曲控制点
 *       ╲          │                     D   ── 唯一的输入
 *        ╰─── B ───┤
 *        │         │
 *        └─────────┘
 *
 * 折痕把纸切成两半：含 C 的那半翻过去（dogEar），另一半留在原地（content）。
 * 「翻过去」在数学上就是**关于折痕做镜像**——C 镜像过去正好是 D，这也是模型自洽的证据。
 *
 * 为什么不给 A~G 各自做动画：它们不是七个独立的量，是 D 的函数。各自插值会散架
 * （折痕不再是垂直平分线，纸就"断"了）。只动 D，剩下的每帧现算，形状永远是自洽的。
 */

/* 判定阈值：拖过纸对角线的这个比例就算撕下来了。0.45 是 Android 那份规格里的数，
   配上下面这个跨度，一张 216×132 的便利贴大约要拖 63px——和原来那版手感接近 */
export const TEAR_THRESHOLD = 0.45;
const SPAN = 0.55;

/* 复用的临时点。每帧算一次几何，没必要每次都新建十几个对象 */
const P = [];
let pn = 0;
const pt = (x, y) => {
  // 按需增长，绝不回绕：回绕会静默覆盖掉这一帧前面算好的点
  const p = P[pn] || (P[pn] = { x: 0, y: 0 });
  pn++;
  p.x = x; p.y = y;
  return p;
};

const dot = (a, b) => a.x * b.x + a.y * b.y;
const ON_LINE = 1e-6;
/* 两次裁剪各自新建点对象，同一个几何点在 flap 和 keep 里**不是同一个对象**。
   按对象比会永远 indexOf === -1，路径就少一块——按坐标比 */
const same = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
const indexOfPoint = (arr, p) => arr.findIndex((q) => same(q, p));

/**
 * 用一条直线切多边形，只留下指定一侧（Sutherland–Hodgman）。
 * 不写分情况讨论的原因：折痕可能从「上边 + 右边」出去（切掉一个角），
 * 也可能从「上边 + 下边」出去（切掉右边一条）。用通用裁剪，两种都自然落进来。
 * @param side +1 保留法线正侧，-1 保留负侧
 */
function clipHalf(poly, m, u, side) {
  const out = [];
  const dist = (p) => side * ((p.x - m.x) * u.x + (p.y - m.y) * u.y);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dist(a);
    const db = dist(b);
    if (da >= -ON_LINE) out.push(a);
    if ((da > ON_LINE && db < -ON_LINE) || (da < -ON_LINE && db > ON_LINE)) {
      const t = da / (da - db);
      out.push(pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return out;
}

/** 二次 Bézier 的控制点：从弦的中点朝「背离折痕」的方向鼓出去 */
function bow(a, b, u, k = 0.17, cap = 26) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  // 两个法线方向选背离折痕的那个：翻过去的纸片鼓向 D 那一侧
  if (nx * u.x + ny * u.y < 0) { nx = -nx; ny = -ny; }
  const d = Math.min(len * k, cap);
  return pt((a.x + b.x) / 2 + nx * d, (a.y + b.y) / 2 + ny * d);
}

const fmt = (n) => (Math.round(n * 100) / 100);
const moveTo = (p) => `M${fmt(p.x)} ${fmt(p.y)}`;
const lineTo = (p) => `L${fmt(p.x)} ${fmt(p.y)}`;
const quadTo = (c, p) => `Q${fmt(c.x)} ${fmt(c.y)} ${fmt(p.x)} ${fmt(p.y)}`;

/**
 * D → 全部几何。
 *
 * @param {number} w 纸宽
 * @param {number} h 纸高
 * @param {{x:number,y:number}} d0 被拖到的位置（纸片本地坐标，原点在左上）
 * @returns {null | {
 *   A, B, C, D, E, F, G,        七个点
 *   content: string,            还留在原地的纸（拿去当 clip-path）
 *   dogEar: string,             翻起来的那片
 *   crease: {x:number,y:number}[],  折痕两端，画高光用
 *   progress: number,           0~1
 *   gone: boolean,              纸已经整张翻完了
 * }}
 */
export function tearGeometry(w, h, d0) {
  pn = 0;
  const C = pt(w, 0);
  const vx = d0.x - C.x;
  const vy = d0.y - C.y;
  const L = Math.hypot(vx, vy);
  if (L < 0.8) return null;                       // 还没动，当没撕

  // 折痕：CD 的垂直平分线。u 是它的法线（指向 D），n 是它自己的方向
  const M = pt(C.x + vx / 2, C.y + vy / 2);
  const u = pt(vx / L, vy / L);
  const n = pt(-u.y, u.x);

  const rect = [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)];
  const flap = clipHalf(rect, M, u, -1);          // 含 C 的那半：要翻过去
  const keep = clipHalf(rect, M, u, +1);          // 另一半：留在原地
  if (flap.length < 3) return null;

  /* 关于折痕做镜像。C 会精确落在 D 上——这正是「垂直平分线」的定义 */
  const mirror = (p) => {
    const ax = p.x - M.x;
    const ay = p.y - M.y;
    const along = ax * n.x + ay * n.y;
    return pt(M.x + 2 * along * n.x - ax, M.y + 2 * along * n.y - ay);
  };

  // A、B：折痕与纸边的两个交点，在两半里都是同样这两个点
  const onLine = (p) => Math.abs((p.x - M.x) * u.x + (p.y - M.y) * u.y) < 1e-3;
  const ends = flap.filter(onLine);

  /* 折痕已经整个跑到纸外：没有交点了，整张纸都翻了过去。
     收尾动画会走到这一档，这里得给出「只剩翻起那片」的形状，不能返回 null——
     否则纸会在最后一瞬间凭空消失，而不是卷着飞走 */
  if (ends.length < 2) {
    const m = flap.map(mirror);
    let d = moveTo(m[0]);
    for (let i = 1; i < m.length; i++) d += quadTo(bow(m[i - 1], m[i], u, 0.08, 18), m[i]);
    d += `${quadTo(bow(m[m.length - 1], m[0], u, 0.08, 18), m[0])}Z`;
    return {
      A: m[0], B: m[m.length - 1], C, D: pt(d0.x, d0.y),
      E: m[0], F: m[m.length - 1], G: m[0],
      content: '', dogEar: d, crease: [m[0], m[m.length - 1]],
      tip: m[Math.floor(m.length / 2)],
      progress: 1, gone: true,
    };
  }

  const A = ends[0];
  const B = ends[ends.length - 1];

  // 翻过去那片的自由边：从 A 出发，经过镜像后的内部顶点，到 B
  const iA = indexOfPoint(flap, A);
  const free = [];
  for (let k = 1; k < flap.length; k++) {
    const p = flap[(iA + k) % flap.length];
    if (same(p, B)) break;
    free.push(mirror(p));
  }
  // G：折痕自己也鼓一点。纸卷起来的时候折痕不会是一条尺子画的直线
  const G = bow(A, B, u, 0.05, 9);

  /* content：留下的纸。除了 A→B 这条边走 G 的曲线，其余照多边形走 */
  let content = '';
  if (keep.length >= 3) {
    /* 沿多边形走一圈，**按边判断**哪条是折痕（连接 A 和 B 的那条），只有它走曲线。
       按「走回起点的最后一条边」判断是错的：起点在多边形里的位置不固定，
       折痕可能是第一条边也可能是最后一条，判错了曲线就画到纸的直边上去 */
    content = moveTo(keep[0]);
    for (let k = 1; k <= keep.length; k++) {
      const prev = keep[(k - 1) % keep.length];
      const p = keep[k % keep.length];
      const isCrease = (same(prev, A) && same(p, B)) || (same(prev, B) && same(p, A));
      content += isCrease ? quadTo(G, p) : lineTo(p);
    }
    content += 'Z';
  }

  /* dogEar：A →(E)→ D →…→(F)→ B，再沿折痕(G)回到 A。
     不需要布尔运算：镜像出来的这片天然就在折痕另一侧，和 content 只共一条边 */
  const chain = [A, ...free, B];
  let E = null;
  let F = null;
  let dogEar = moveTo(A);
  for (let i = 1; i < chain.length; i++) {
    const c = bow(chain[i - 1], chain[i], u);
    if (i === 1) E = c;
    if (i === chain.length - 1) F = c;
    dogEar += quadTo(c, chain[i]);
  }
  dogEar += `${quadTo(G, A)}Z`;

  const span = Math.hypot(w, h) * SPAN;
  return {
    A, B, C, D: pt(d0.x, d0.y), E, F, G,
    content, dogEar,
    crease: [A, B],
    tip: free.length ? free[Math.floor((free.length - 1) / 2)] : pt(d0.x, d0.y),
    progress: Math.min(1, L / span),
    gone: keep.length < 3,
  };
}

/**
 * 要把整张纸翻完，D 至少得拖多远。
 *
 * 折痕过 M = C + (L/2)·û。纸上所有角都落到翻起的那一侧时才算翻完，
 * 也就是对每个角都有 dot(角 − M, û) < 0，即 L > 2·max(dot(角 − C, û))。
 * 撕到底的收尾动画照这个距离走，纸就会一路卷到消失，而不是卡在中途突然不见。
 */
export function dForGone(w, h, dir) {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  let far = 0;
  for (const [cx, cy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    far = Math.max(far, (cx - w) * ux + (cy - 0) * uy);
  }
  const L = far * 2 + Math.max(w, h) * 0.25;
  return { x: w + ux * L, y: uy * L };
}

/** 反过来：给一个进度，求 D 在哪儿（动画和 setTearProgress 用） */
export function dForProgress(w, h, progress, dir) {
  const span = Math.hypot(w, h) * SPAN;
  const L = Math.max(0, progress) * span;
  const len = Math.hypot(dir.x, dir.y) || 1;
  return { x: w + (dir.x / len) * L, y: (dir.y / len) * L };
}
