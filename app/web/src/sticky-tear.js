/**
 * 剥离几何 —— 一个控制点 D，推出整张纸的形状
 *
 * 这不是「翻页」：纸是整张背面涂了胶贴在页面上的，捏住右上角 C 往左下拉到 D，
 * 胶从剥离线开始一点点松开，松开的纸**绕着一根平行于剥离线的圆柱弯起来**，
 * 弯过顶点之后平平地翻回来，一路伸到手指。俯视下来是这么几段：
 *
 *        M ──────────────╮ C(w,0)          t = (p − M)·a  是纸上每个点到剥离线的有符号距离
 *        ┆ ░░░░░░░░░░░░░ │                 t ≤ 0        还粘着，原样不动
 *   D ·←─┆░░ 卷 ░░│      │                 0 < t ≤ θR   绕在半径 R 的圆柱上，θ 是纸角绕到的角度
 *        ┆ ░░░░░░░░░░░░░ │                 t > πR       已经绕过顶点，平铺在高度 2R 上往回伸
 *        ┆                │
 *        └────────────────┘               a 是从 D 指向 C 的单位向量，剥离线过 M 且垂直于 a
 *
 * 纸是**不可伸长**的，所以每一段的投影都是刚性的：
 *   卷      p ↦ p + (R·sin(t/R) − t)·a          圆柱面绕到俯视图上是一条正弦
 *   平铺    p ↦ p − (2t − πR)·a                  正好等于关于直线 t = πR/2 做镜像
 * 圆柱半径 R 固定——纸是有硬度的，刚开始拉的时候纸角只是沿着这个大弧爬上去
 * （θ < π，θ − sin θ = L/R），爬过顶点之后才有翻平的那片。
 * 从上面看：t < πR/2 的那段是正面在抬起来（字还在，只是被压扁、渐渐背光），
 * t > πR/2 的那段露出纸背，从轮廓线（最暗）到顶棱（最亮）；翻平的片压在还粘着的纸上面。
 * 角 C 永远落在 D 上——这是求 M 的方程：
 *   θ < π：L = θR − R·sin θ，M = C − θR·a
 *   θ ≥ π：L = 2·dC − πR，   M = C − dC·a
 *
 * 只动 D。θ、M、每一段的形状每帧从 D 现算，永远自洽：不会出现内凹、拉伸或者散架。
 */

/* 判定阈值：拖过纸对角线的这个比例松手就算撕下来了 */
export const TEAR_THRESHOLD = 0.45;
const SPAN = 0.55;

/* 卷的半径：约是短边的三成。真便利贴有硬度，撕起来是个大弧，不是紧紧的一卷 */
export function rollRadius(w, h) {
  return Math.max(22, Math.min(46, Math.min(w, h) * 0.3));
}

/**
 * 把手指的位移压回「往纸里拉」的象限。
 * 往右上拉是把纸拽离页面，不是剥——那种方向只算它落在左 / 下的分量，
 * 剥离线因此永远从角落切进纸里，鼠标往上一抖不会让整张纸乱翻。
 */
export function clampPull(w, h, v) {
  // 上限要够 dForGone 把整张纸剥光，只是防止数值飞出去
  const cap = (w + h) * 2.5;
  let x = Math.min(0, v.x);
  let y = Math.max(0, v.y);
  const L = Math.hypot(x, y);
  if (L > cap) { x *= cap / L; y *= cap / L; }
  return { x, y };
}

/** 解 θ − sin θ = k（0 ≤ k ≤ π）。小角度时 ≈ θ³/6，拿它起步，牛顿法几步就收敛 */
function solveTheta(k) {
  let th = Math.cbrt(6 * k);
  for (let i = 0; i < 8; i++) {
    const f = th - Math.sin(th) - k;
    const df = 1 - Math.cos(th);
    if (df < 1e-6) break;
    th -= f / df;
  }
  return Math.max(0, Math.min(Math.PI, th));
}

const ON_LINE = 1e-6;
const fmt = (n) => Math.round(n * 100) / 100;
const pathOf = (pts) => (pts.length ? `M${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join('L')}Z` : '');

/** 用有符号距离函数切多边形，只留 f(p) ≥ 0 的那部分（Sutherland–Hodgman） */
function clipBy(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = f(p);
    const dq = f(q);
    if (dp >= -ON_LINE) out.push(p);
    if ((dp > ON_LINE && dq < -ON_LINE) || (dp < -ON_LINE && dq > ON_LINE)) {
      const k = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
    }
  }
  return out;
}

/**
 * 把多边形逐点映射过去。映射沿 a 方向是非线性的（正弦），
 * 所以斜着穿过卷的直边要按 t 细分成折线，否则圆柱的轮廓会被拉成直线。
 * 只有 t > 0 的那段真的会弯：一条边若跨过剥离线，先在 t = 0 处切开，只细分抬起的那一半。
 */
function mapPoly(poly, t, map, step) {
  const out = [];
  const walk = (p, q, tp, tq) => {
    const n = Math.min(16, Math.max(1, Math.ceil(Math.abs(tq - tp) / step)));
    for (let k = 0; k < n; k++) {
      const s = k / n;
      out.push(map({ x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s }));
    }
  };
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const tp = t(p);
    const tq = t(q);
    if (tp <= 0 && tq <= 0) { out.push(map(p)); continue; }
    if (tp > 0 && tq > 0) { walk(p, q, tp, tq); continue; }
    const k = tp / (tp - tq);
    const c = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    if (tp <= 0) { out.push(map(p)); walk(c, q, 0, tq); }
    else walk(p, c, tp, 0);
  }
  return out;
}

/**
 * D → 全部几何。
 *
 * @param {number} w 纸宽
 * @param {number} h 纸高
 * @param {{x:number,y:number}} d0 手指所在（纸片本地坐标，原点在左上）
 * @returns {null | {
 *   content: string,        没被翻过去盖住、字还看得见的纸：粘着的 + 正在抬起的正面（拿去当 clip-path）
 *   rise: string,           正在抬起的正面那段（投影后），画背光渐变用
 *   roll: string,           绕过轮廓线之后露出的纸背
 *   flap: string,           已经翻平、伸向手指的那片（可能为空）
 *   contact: string,        卷贴地那条轮廓线，画接触阴影用
 *   crest: string,          卷的顶棱，画高光用（纸角还没爬过顶点时为空）
 *   rise0, rise1,           抬起段的渐变：剥离线 → 轮廓线
 *   roll0, roll1,           纸背的渐变：顶棱 → 轮廓线
 *   flap0, flap1,           平铺片的渐变：顶棱 → 手指
 *   a, r,                   剥离方向、卷的半径
 *   progress: number,       0~1
 *   gone: boolean,          纸上已经没有粘着的部分了
 * }}
 */
export function tearGeometry(w, h, d0) {
  const C = { x: w, y: 0 };
  const v = clampPull(w, h, { x: d0.x - C.x, y: d0.y - C.y });
  const L = Math.hypot(v.x, v.y);
  if (L < 0.8) return null;

  const a = { x: -v.x / L, y: -v.y / L };            // D → C
  const n = { x: -a.y, y: a.x };                     // 沿剥离线
  const R = rollRadius(w, h);
  const half = Math.PI * R / 2;
  const full = Math.PI * R;

  // 纸角绕到哪儿了：没过顶点时按 θ − sin θ = L/R 解；过了顶点多出来的纸平铺，dC 线性
  const onArc = L < full;
  const theta = onArc ? solveTheta(L / R) : Math.PI;
  const dC = onArc ? theta * R : (L + full) / 2;
  const M = { x: C.x - dC * a.x, y: C.y - dC * a.y };
  const t = (p) => (p.x - M.x) * a.x + (p.y - M.y) * a.y;

  const rect = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const wrap = (p) => {
    const k = R * Math.sin(t(p) / R) - t(p);
    return { x: p.x + k * a.x, y: p.y + k * a.y };
  };
  const flatten = (p) => {
    const k = -(2 * t(p) - full);
    return { x: p.x + k * a.x, y: p.y + k * a.y };
  };

  const keep = clipBy(rect, (p) => -t(p));
  const riseEnd = Math.min(dC, half);                       // 抬起段在纸上的终点
  const onRise = clipBy(clipBy(rect, (p) => t(p)), (p) => riseEnd - t(p));
  const onRoll = dC > half ? clipBy(clipBy(rect, (p) => t(p) - half), (p) => Math.min(dC, full) - t(p)) : [];
  const onFlap = dC > full ? clipBy(rect, (p) => t(p) - full) : [];

  /* 字还看得见的部分：粘着的 + 抬起段**投影之后**的形状。抬起那段正面朝上只是被压扁了一点，
     字照原位留着比突然消失自然得多；压扁本身交给上面那层背光渐变去暗示。
     必须按投影后的轮廓裁：纸边一抬起来就往剥离线缩，原来那一小条位置露出的是底下的页面，
     还按矩形裁会在角上留下一片「纸还在但没被抬起」的假象 */
  const lift = (p) => (t(p) > 0 ? wrap(p) : p);
  const visible = mapPoly(clipBy(rect, (p) => riseEnd - t(p)), t, lift, R * 0.18);
  const risePts = onRise.length >= 3 ? mapPoly(onRise, t, wrap, R * 0.18) : [];
  const rollPts = onRoll.length >= 3 ? mapPoly(onRoll, t, wrap, R * 0.18) : [];
  const flapPts = onFlap.length >= 3 ? onFlap.map(flatten) : [];

  /* 轮廓线和顶棱各自只画纸真正到达的那一段：
     从卷那块多边形里挑出落在 t = πR/2（轮廓线）和 t = πR（顶棱）上的顶点，投影后取两端 */
  const extent = (poly, at) => {
    let lo = Infinity;
    let hi = -Infinity;
    let base = null;
    for (const p of poly) {
      if (Math.abs(t(p) - at) > 1e-3) continue;
      const q = wrap(p);
      base = base || q;
      const sAlong = (q.x - M.x) * n.x + (q.y - M.y) * n.y;
      if (sAlong < lo) lo = sAlong;
      if (sAlong > hi) hi = sAlong;
    }
    if (!(hi > lo + 0.5)) return '';
    const off = (base.x - M.x) * a.x + (base.y - M.y) * a.y;
    const p0 = { x: M.x + a.x * off + n.x * lo, y: M.y + a.y * off + n.y * lo };
    const p1 = { x: M.x + a.x * off + n.x * hi, y: M.y + a.y * off + n.y * hi };
    return `M${fmt(p0.x)} ${fmt(p0.y)}L${fmt(p1.x)} ${fmt(p1.y)}`;
  };
  const rim = { x: M.x + a.x * R, y: M.y + a.y * R };

  const flapLen = Math.max(0, dC - full);
  const span = Math.hypot(w, h) * SPAN;
  return {
    content: visible.length >= 3 ? pathOf(visible) : '',
    rise: pathOf(risePts),
    roll: pathOf(rollPts),
    flap: pathOf(flapPts),
    contact: extent(onRoll, half),
    crest: extent(onRoll, full),
    rise0: M,
    rise1: rim,
    roll0: M,
    roll1: rim,
    flap0: M,
    flap1: { x: M.x - a.x * Math.max(flapLen, 1), y: M.y - a.y * Math.max(flapLen, 1) },
    a, r: R,
    progress: Math.min(1, L / span),
    gone: keep.length < 3,
  };
}

/**
 * 要把整张纸剥光，D 至少得拖多远。
 *
 * 纸上离剥离线最远的角也在剥离线的 +a 侧时就没有粘着的部分了：
 * dC > max(C − p)·a，代回 L = 2·dC − πR 再多给一小截，收尾动画一路卷到消失。
 */
export function dForGone(w, h, dir) {
  const v = clampPull(w, h, dir);
  const len = Math.hypot(v.x, v.y) || 1;
  const ux = v.x / len;
  const uy = v.y / len;
  let far = 0;
  for (const [cx, cy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    far = Math.max(far, (w - cx) * -ux + (0 - cy) * -uy);
  }
  const full = Math.PI * rollRadius(w, h);
  const L = Math.max(full, 2 * far - full) + Math.max(w, h) * 0.3;
  return { x: w + ux * L, y: uy * L };
}
