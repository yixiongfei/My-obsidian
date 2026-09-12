import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { createStage, projectToScreen } from './stage.js';

/**
 * 2.5D 知识岛（深色主题的首页图）。
 *   等轴视角、悬浮在星空里的一串小岛：起点 → 英语 → 数学 → 408 → 初试 → 复试 → 上岸，之字形向上，
 *   岛与岛之间是一段段悬空的台阶。
 *   岛的状态：未开始（深蓝灰、只剩轮廓）/ 进行中（蓝，亮度随 log 进度）/ 已完成（青，满亮）；
 *   小人站着的那座岛描紫边、脚下一盏紫光；三科全完成 → 站上初试岛；初试 / 复试在设置里勾过就往上走；
 *   上岸才算成功：岛变金、小人举手戴桂冠。
 *   小人从起点沿台阶慢慢走到当前岛（进入页面时走一遍），到了就原地小幅呼吸。
 *   当前岛 = 有进度的科目里最靠后的那科；在岛上的位置随该科进度从入口挪向出口。
 *   镜头固定不随鼠标晃；平时只标岛名，点一座岛才弹出它的进度。星空绕一根斜轴缓缓转，像站在地上看夜空。
 */

const ISLAND = 8;         // 岛的边长（正方形）
const START = 6;          // 起点岛
const THICK = 1.4;        // 岛的厚度
const SPAN = 12.5;        // 相邻岛中心的水平距离
const RISE = 3.6;         // 每级抬升
const STEPS = 6;          // 每段台阶的级数
const STEP_W = 2.6;

const litOf = (learned, total) => (total > 0 && learned > 0 ? Math.min(1, Math.log1p(learned) / Math.log1p(total)) : 0);

/** 岛的位置：偶数段向 -z 走（屏幕右上），奇数段向 -x 走（屏幕左上），等轴下就是之字形 */
function layout(count) {
  const islands = [];
  let c = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < count; i += 1) {
    islands.push({ center: c.clone(), size: i === 0 ? START : i === count - 1 ? 7 : ISLAND });
    const dir = i % 2 === 0 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
    c = c.clone().addScaledVector(dir, SPAN).add(new THREE.Vector3(0, RISE, 0));
    islands[i].dir = dir;
  }
  return islands;
}

/** 小人：圆头、深色头发、浅蓝上衣、深色裤子，四肢挂在关节上 */
function buildFigure(colors, dark) {
  const g = new THREE.Group();
  const mat = (color, e = 0.06) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: dark ? e : 0.02, roughness: 0.6, metalness: 0.05 });
  const skin = mat(colors.text, 0.05);
  const shirt = mat(colors.accent2, 0.12);
  const pants = mat(colors.line, 0.02);
  const hairM = mat(colors.dim, 0.0);
  const mk = (geo, m) => { const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; return mesh; };

  const torso = mk(new THREE.CapsuleGeometry(0.36, 0.85, 6, 12), shirt); torso.position.y = 1.95; g.add(torso);
  const neck = mk(new THREE.CylinderGeometry(0.12, 0.12, 0.25, 8), skin); neck.position.y = 2.55; g.add(neck);
  const head = mk(new THREE.SphereGeometry(0.42, 20, 16), skin); head.position.y = 3.0; g.add(head);
  // 头发：上半个球，稍大一点扣在头顶
  const hair = mk(new THREE.SphereGeometry(0.45, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairM);
  hair.position.y = 3.05; g.add(hair);

  const limb = (x, y, r, len, m) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = mk(new THREE.CapsuleGeometry(r, len - r * 2, 4, 10), m); mesh.position.y = -len / 2; pivot.add(mesh);
    g.add(pivot); return pivot;
  };
  const armL = limb(-0.5, 2.45, 0.11, 1.1, shirt), armR = limb(0.5, 2.45, 0.11, 1.1, shirt);
  const legL = limb(-0.19, 1.45, 0.14, 1.3, pants), legR = limb(0.19, 1.45, 0.14, 1.3, pants);
  // 鞋
  for (const leg of [legL, legR]) {
    const foot = mk(new THREE.BoxGeometry(0.28, 0.16, 0.42), hairM); foot.position.set(0, -1.3, 0.08); leg.add(foot);
  }

  // 桂冠：金环 + 一圈叶子，登顶才显示
  const laurel = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: colors.due, emissive: colors.due, emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.5 });
  laurel.add(new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.045, 8, 40), gold));
  const leafGeo = new THREE.SphereGeometry(0.1, 8, 6);
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    const leaf = new THREE.Mesh(leafGeo, gold);
    leaf.position.set(Math.cos(a) * 0.47, i % 2 ? 0.08 : -0.02, Math.sin(a) * 0.47);
    leaf.scale.set(1, 0.6, 1.8); leaf.rotation.y = -a;
    laurel.add(leaf);
  }
  laurel.position.y = 3.22; laurel.visible = false; g.add(laurel);

  return { group: g, armL, armR, legL, legR, laurel };
}

/** 三科之后的三站；done 来自设置里的里程碑开关 */
const STAGES = [
  { key: '初试', name: '初试', hint: '三科都学完就站上来；考完在设置里勾「初试」' },
  { key: '复试', name: '复试', hint: '初试过了就到这儿；复试过了勾「复试」' },
  { key: '上岸', name: '上岸', hint: '勾上「上岸」，桂冠就戴上了' },
];

export default function KnowledgeIslands3D({ steps = [], milestones = {}, nextReview, theme }) {
  const mountRef = useRef(null);
  const labelRefs = useRef([]);
  const [picked, setPicked] = useState(-1);   // 点选的岛（索引；-1 没选）
  const pickedRef = useRef(-1);
  useEffect(() => { pickedRef.current = picked; }, [picked]);

  // localStorage kb-debug-summit=1：三科全点亮，看登顶的样子（调试用）
  const stairs = useMemo(() => {
    let demo = false;
    try { demo = localStorage.getItem('kb-debug-summit') === '1'; } catch { /* 无 */ }
    return steps.map((s) => ({ ...s, lit: demo ? 1 : litOf(s.learned, s.total) }));
  }, [steps]);
  const subjectsDone = stairs.length > 0 && stairs.every((s) => s.lit >= 0.999);
  const stages = useMemo(() => {
    let demo = false;
    try { demo = localStorage.getItem('kb-debug-summit') === '1'; } catch { /* 无 */ }
    return STAGES.map((st) => ({ ...st, done: demo || !!milestones?.[st.key], date: milestones?.[st.key] || null }));
  }, [milestones]);
  const landed = stages[2].done;               // 上岸 = 成功
  const N = stairs.length;                      // 科目岛数
  // 当前岛（索引；0 = 起点，1..N = 科目，N+1 初试，N+2 复试，N+3 上岸）：
  // 上岸 / 复试过了 → 上岸岛；初试过了 → 复试岛；三科学完 → 初试岛；否则有进度的最靠后一科
  const current = landed || stages[1].done ? N + 3
    : stages[0].done ? N + 2
      : subjectsDone ? N + 1
        : stairs.reduce((m, s, i) => (s.lit > 0 ? i + 1 : m), 0);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !stairs.length) return undefined;
    let unbind = () => {};

    const islands = layout(N + 1 + stages.length);   // 起点 + 各科 + 初试 / 复试 / 上岸
    // 让整串岛在画面中居中：包围盒中心当 lookAt 目标；等轴视口高度按跨度算
    const box = new THREE.Box3();
    islands.forEach((it) => box.expandByPoint(it.center));
    // 顶上的线框球和最底下那座岛的底面也要在画面里
    box.expandByPoint(islands.at(-1).center.clone().add(new THREE.Vector3(0, 10.5, 0)));
    box.expandByPoint(islands[0].center.clone().add(new THREE.Vector3(0, -THICK, 0)));
    const mid = box.getCenter(new THREE.Vector3());
    const span = box.getSize(new THREE.Vector3());
    // 等轴投影：竖直跨度按 1 算，水平跨度按 1/√6 折到屏幕纵向；再留一点边
    const viewH = (span.y * 0.82 + (span.x + span.z) / Math.sqrt(6)) + 10;

    const stage = createStage(el, {
      ortho: viewH,
      cameraAt: [mid.x + 60, mid.y + 60, mid.z + 60],
      bloom: 0.3,
      shadows: false,
      build: ({ scene, camera, colors, dark, size }) => {
        scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.55 : 0.95));
        const key = new THREE.DirectionalLight(0xffffff, dark ? 0.9 : 1.0);
        key.position.set(20, 40, 25);
        scene.add(key);
        const fill = new THREE.DirectionalLight(colors.accent2, dark ? 0.5 : 0.4);
        fill.position.set(-30, 10, -20);
        scene.add(fill);

        /* 每座岛的状态：
             start  起点，青
             done   已完成，青满亮        doing  进行中，蓝、亮度随进度
             locked 未开始，深蓝灰轮廓    gold   上岸，金 */
        const stateOf = (i) => {
          if (i === 0) return { kind: 'start', lit: 1 };
          if (i > N) {
            const st = stages[i - N - 1];
            if (i === islands.length - 1) return { kind: st.done ? 'gold' : i === current ? 'doing' : 'locked', lit: st.done ? 1 : i === current ? 0.5 : 0 };
            return { kind: st.done ? 'done' : i === current ? 'doing' : 'locked', lit: st.done ? 1 : i === current ? 0.5 : 0 };
          }
          const s = stairs[i - 1];
          return { kind: s.lit >= 0.999 ? 'done' : s.lit > 0 ? 'doing' : 'locked', lit: s.lit, data: s };
        };

        const built = islands.map((it, i) => {
          const st = stateOf(i);
          const geo = new THREE.BoxGeometry(it.size, THICK, it.size);
          const tone = st.kind === 'done' || st.kind === 'start' ? colors.cyan
            : st.kind === 'gold' ? colors.due
              : st.kind === 'doing' ? colors.accent : colors.line;
          const glow = st.kind === 'done' ? 0.5 : st.kind === 'start' ? 0.18 : st.kind === 'gold' ? 0.6 : st.lit * 0.34;
          const mat = new THREE.MeshStandardMaterial({
            color: tone, emissive: tone, emissiveIntensity: dark ? glow : glow * 0.4,
            roughness: 0.4, metalness: 0.35, transparent: true,
            opacity: st.kind === 'locked' ? 0.3 : 0.5 + st.lit * 0.45,
          });
          const mesh = new THREE.Mesh(geo, mat);
          const group = new THREE.Group();
          group.position.copy(it.center);
          group.add(mesh);
          const edgeMat = new THREE.LineBasicMaterial({ color: i === current ? colors.purple : tone, transparent: true, opacity: i === current ? 1 : 0.7 });
          group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
          scene.add(group);
          return { ...it, i, st, group, mesh, mat, edgeMat, tone, top: it.center.y + THICK / 2 };
        });

        // 当前岛脚下一盏紫光
        if (current < built.length) {
          const cur = built[current];
          const lamp = new THREE.PointLight(colors.purple, dark ? 2.2 : 0.8, 16);
          lamp.position.set(cur.center.x, cur.top + 4, cur.center.z);
          scene.add(lamp);
        }

        // 台阶：岛 i 的出口到岛 i+1 的入口，一段悬空的斜梯；走过的段亮，没走到的暗
        const path = [];   // 小人的路线（地表高度）
        path.push(new THREE.Vector3(built[0].center.x, built[0].top, built[0].center.z));
        const flights = [];
        for (let i = 0; i < built.length - 1; i += 1) {
          const a = built[i], b = built[i + 1];
          const dir = a.dir;
          const exit = a.center.clone().addScaledVector(dir, a.size / 2); exit.y = a.top;
          const entry = b.center.clone().addScaledVector(dir, -b.size / 2); entry.y = b.top;
          const horiz = exit.distanceTo(new THREE.Vector3(entry.x, exit.y, entry.z));
          const depth = horiz / STEPS;
          const walked = i < current;
          const tone = walked ? colors.accent2 : colors.line;
          const g = new THREE.Group();
          g.position.copy(exit);
          g.rotation.y = Math.atan2(dir.x, dir.z);
          const stepGeo = new THREE.BoxGeometry(STEP_W, 0.5, depth * 0.92);
          const stepMat = new THREE.MeshStandardMaterial({
            color: tone, emissive: tone, emissiveIntensity: walked ? (dark ? 0.3 : 0.1) : 0.02,
            roughness: 0.45, metalness: 0.3, transparent: true, opacity: walked ? 0.9 : 0.35,
          });
          path.push(exit.clone());
          for (let k = 0; k < STEPS; k += 1) {
            const topY = (k + 1) * (RISE / (STEPS + 1));
            const m = new THREE.Mesh(stepGeo, stepMat);
            m.position.set(0, topY - 0.25, (k + 0.5) * depth);
            g.add(m);
            const edge = new THREE.LineSegments(new THREE.EdgesGeometry(stepGeo), new THREE.LineBasicMaterial({ color: tone, transparent: true, opacity: walked ? 0.8 : 0.4 }));
            edge.position.copy(m.position);
            g.add(edge);
            const p = new THREE.Vector3(0, topY, (k + 0.5) * depth).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(exit);
            path.push(p);
          }
          path.push(entry.clone());
          path.push(new THREE.Vector3(b.center.x, b.top, b.center.z));
          scene.add(g);
          flights.push({ g, stepMat });
        }

        // 路线累计长度，方便按距离取点
        const cum = [0];
        for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + path[i].distanceTo(path[i - 1]));
        const total = cum[cum.length - 1];
        const at = (d, out) => {
          const dd = Math.max(0, Math.min(total, d));
          let i = 1;
          while (i < cum.length - 1 && cum[i] < dd) i += 1;
          const t = (dd - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
          return out.copy(path[i - 1]).lerp(path[i], t);
        };
        // 每座岛中心在路线上的距离：起点 0，之后每段 = 出口 + 台阶 + 入口 + 中心，共 STEPS+3 个点
        const centerDist = (i) => cum[Math.min(cum.length - 1, i * (STEPS + 3))];
        // 目标：科目岛上按该科进度从入口偏到出口（±size/2 的 70%）；其余岛站中间
        let target;
        if (current >= 1 && current <= N) {
          const s = stairs[current - 1];
          target = centerDist(current) + (s.lit - 0.5) * built[current].size * 0.7;
        } else target = centerDist(Math.min(current, built.length - 1));

        // 小人
        const fig = buildFigure(colors, dark);
        fig.group.scale.setScalar(1.25);
        fig.laurel.visible = landed;
        scene.add(fig.group);
        const pos = new THREE.Vector3();
        const ahead = new THREE.Vector3();
        let walked = 0;                          // 已走的路线距离
        const speed = Math.max(2.4, target / 12); // 慢慢走，最长约 12 秒
        let facing = 0;
        // 角度插值走最短弧，别在 ±π 处转一整圈
        const turnTo = (cur, want, k) => {
          let d = want - cur;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          return cur + d * k;
        };
        at(0, pos); fig.group.position.copy(pos);
        at(0.6, ahead); fig.group.rotation.y = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);

        if (landed) {
          const halo = new THREE.PointLight(colors.due, 2, 14);
          halo.position.set(built.at(-1).center.x, built.at(-1).top + 5, built.at(-1).center.z);
          scene.add(halo);
        }

        // 初试标记：终点岛上方的线框球
        const last = built[built.length - 1];
        const globe = new THREE.Mesh(new THREE.SphereGeometry(1.8, 18, 12),
          new THREE.MeshBasicMaterial({ color: landed ? colors.due : colors.dim, wireframe: true, transparent: true, opacity: 0.7 }));
        globe.position.set(last.center.x, last.top + 8.5, last.center.z);
        scene.add(globe);
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(last.center.x, last.top, last.center.z), new THREE.Vector3(last.center.x, last.top + 6.7, last.center.z)]),
        new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: 0.6 })));

        // 星空：两层——满天细小的暗星 + 少量亮星，一起绕一根斜轴慢转（像在地上看周日视运动）
        const sky = new THREE.Group();
        sky.position.copy(mid);
        const makeStars = (count, size, opacity) => {
          const arr = new Float32Array(count * 3);
          for (let i = 0; i < count; i += 1) {
            const r = 160 + Math.random() * 120, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
            arr[i * 3] = r * Math.sin(ph) * Math.cos(th); arr[i * 3 + 1] = r * Math.cos(ph); arr[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
          return new THREE.Points(geo, new THREE.PointsMaterial({
            color: dark ? colors.text : colors.dim, size, transparent: true, opacity, depthWrite: false, sizeAttenuation: false,
          }));
        };
        sky.add(makeStars(1600, dark ? 0.9 : 0.6, dark ? 0.45 : 0.3));
        sky.add(makeStars(200, dark ? 1.4 : 1.0, dark ? 0.7 : 0.5));
        scene.add(sky);
        // 天极：从画面左上方斜插进来的一根轴，星星绕它转
        const pole = new THREE.Vector3(-1, 1.7, -1).normalize();

        // 点选：射线打在哪座岛上就选中它（再点一次取消）
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const onClick = (ev) => {
          const r = el.getBoundingClientRect();
          ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
          ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
          ray.setFromCamera(ndc, camera);
          const hit = ray.intersectObjects(built.map((b) => b.mesh), false)[0];
          const idx = hit ? built.findIndex((b) => b.mesh === hit.object) : -1;
          setPicked((cur) => (cur === idx ? -1 : idx));
        };
        const onHover = (ev) => {
          const r = el.getBoundingClientRect();
          ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
          ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
          ray.setFromCamera(ndc, camera);
          el.style.cursor = ray.intersectObjects(built.map((b) => b.mesh), false).length ? 'pointer' : '';
        };
        el.addEventListener('click', onClick);
        el.addEventListener('pointermove', onHover);
        unbind = () => { el.removeEventListener('click', onClick); el.removeEventListener('pointermove', onHover); el.style.cursor = ''; };

        const tmp = new THREE.Vector3();
        const anchor = new THREE.Vector3();
        const R = 90;
        // 镜头固定：标准等轴角度，不跟鼠标
        const el2 = Math.atan(1 / Math.SQRT2);
        camera.position.set(mid.x + R * Math.cos(el2) * Math.SQRT1_2, mid.y + R * Math.sin(el2), mid.z + R * Math.cos(el2) * Math.SQRT1_2);
        camera.lookAt(mid);

        return (t, dt) => {
          // 岛在宇宙里轻轻浮动，各自相位不同；选中的岛描亮边
          const sel = pickedRef.current;
          built.forEach((b, i) => {
            b.group.position.y = b.center.y + Math.sin(t * 0.6 + i * 1.3) * 0.14;
            if (i === sel) { b.edgeMat.color.copy(colors.text); b.edgeMat.opacity = 1; }
            else {
              b.edgeMat.color.copy(i === current ? colors.purple : b.tone);
              b.edgeMat.opacity = i === current ? 0.75 + Math.sin(t * 2.4) * 0.25 : 0.7;
            }
          });

          // 星空绕天极慢转：一圈约 12 分钟，肉眼能察觉在动又不抢戏
          sky.rotateOnAxis(pole, dt * 0.0085);

          // 小人：先沿路线走到目标，再原地呼吸；登顶则举手戴冠
          const moving = walked < target - 0.05;
          if (moving) {
            walked = Math.min(target, walked + speed * dt);
            at(walked, pos);
            at(Math.min(total, walked + 0.8), ahead);
            if (ahead.distanceToSquared(pos) > 1e-4) facing = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);
            fig.group.rotation.y = turnTo(fig.group.rotation.y, facing, 0.12);
            // 步幅跟着走过的距离算，不跟时间——速度变了脚步也不会打滑
            const ph = walked * 2.9;
            const sw = Math.sin(ph) * 0.48;
            fig.legL.rotation.x = sw; fig.legR.rotation.x = -sw;
            fig.armL.rotation.x = -sw * 0.55; fig.armR.rotation.x = sw * 0.55;
            fig.armL.rotation.z = 0.12; fig.armR.rotation.z = -0.12;
            fig.group.rotation.x = 0.06;   // 身子微微前倾
            fig.group.position.set(pos.x, pos.y + Math.abs(Math.sin(ph)) * 0.05, pos.z);
          } else if (landed) {
            fig.armL.rotation.z = Math.PI * 0.8 + Math.sin(t * 3) * 0.12;
            fig.armR.rotation.z = -Math.PI * 0.8 - Math.sin(t * 3) * 0.12;
            fig.legL.rotation.x = 0; fig.legR.rotation.x = 0;
            fig.group.position.set(pos.x, pos.y + Math.abs(Math.sin(t * 3)) * 0.3, pos.z);
            fig.group.rotation.x = 0;
            fig.group.rotation.y = turnTo(fig.group.rotation.y, Math.PI * 0.25, 0.05);
            fig.laurel.rotation.y = t * 0.6;
          } else {
            // 站定：面朝下一段台阶的方向，轻微呼吸
            const nextDir = built[Math.min(current, built.length - 1)].dir;
            const face = Math.atan2(nextDir.x, nextDir.z);
            fig.group.rotation.y = turnTo(fig.group.rotation.y, face, 0.05);
            fig.group.rotation.x *= 0.9;
            fig.legL.rotation.x *= 0.85; fig.legR.rotation.x *= 0.85;
            fig.armL.rotation.x *= 0.85; fig.armR.rotation.x *= 0.85;
            fig.armL.rotation.z = 0.12 + Math.sin(t * 1.4) * 0.03; fig.armR.rotation.z = -0.12 - Math.sin(t * 1.4) * 0.03;
            fig.group.position.set(pos.x, pos.y + Math.sin(t * 1.4) * 0.03, pos.z);
          }
          // 岛在浮动，小人跟着最近的那座岛一起动
          let under = built[0];
          for (const b of built) if (Math.abs(walked - centerDist(b.i)) < Math.abs(walked - centerDist(under.i))) under = b;
          fig.group.position.y += under.group.position.y - under.center.y;

          globe.rotation.y = t * 0.25;
          globe.rotation.x = Math.sin(t * 0.4) * 0.15;

          // 标签吊在各岛最前面那个角的下方（等轴里那是岛的最低点），不压台阶
          built.forEach((b, i) => {
            const node = labelRefs.current[i];
            if (!node) return;
            anchor.set(b.center.x + b.size / 2, b.group.position.y - THICK / 2, b.center.z + b.size / 2);
            const s = projectToScreen(anchor, camera, size.width, size.height, tmp);
            node.style.transform = `translate(-50%, 0) translate(${s.x}px, ${s.y + 6}px)`;
            node.style.opacity = s.behind ? '0' : '1';
          });
        };
      },
    });

    return () => { unbind(); stage.dispose(); };
  }, [stairs, stages, current, landed, theme]);

  // 科目岛被点选：底部说明也写这一科的进度
  const detail = picked > 0 && picked <= N ? stairs[picked - 1] : null;

  if (!stairs.length) return <div className="orbit3d-empty">从一篇笔记开始</div>;

  const tagOf = (s, i) => (current === i + 1 ? '当前' : s.lit >= 0.999 ? '已完成' : s.lit > 0 ? '进行中' : '未开始');
  const labels = [
    { key: 'start', name: '起点', cls: 'done' },
    ...stairs.map((s, i) => ({
      key: s.key, name: s.name,
      cls: s.lit >= 0.999 ? 'done' : s.lit > 0 ? 'doing' : 'locked',
      // 只有点选的那座岛才展开进度，平时只留岛名
      detail: picked === i + 1 ? { tag: tagOf(s, i), sub: `${s.learned} / ${s.total} ${s.unit}`, pct: s.total ? Math.round((s.learned / s.total) * 100) : 0 } : null,
    })),
    ...stages.map((st, j) => {
      const idx = N + 1 + j;
      return {
        key: st.key, name: st.name,
        cls: st.done ? (j === stages.length - 1 ? 'gold' : 'done') : idx === current ? 'doing' : 'locked',
        // 只给一个状态标签；怎么亮起来不写出来，留作彩蛋
        detail: picked === idx ? { tag: st.done ? `已通过${st.date ? ' ' + st.date.slice(5).replace('-', '.') : ''}` : idx === current ? '当前' : '未到' } : null,
      };
    }),
  ];
  const where = current === 0 ? '还在起点' : current <= N ? `当前在「${stairs[current - 1].name}」岛` : `当前在「${stages[current - N - 1].name}」岛`;

  return (
    <div className="orbit3d">
      <div className="orbit3d-view">
        <div className="orbit3d-stage" ref={mountRef} role="img"
             aria-label={`知识岛：${stairs.map((s) => `${s.name} ${s.learned} / ${s.total} ${s.unit}`).join('，')}${landed ? '，已上岸' : ''}`} />
        <div className="orbit3d-labels">
          {labels.map((l, i) => (
            <div key={l.key} className={`isle-label ${l.cls}${picked === i ? ' picked' : ''}`} ref={(node) => { labelRefs.current[i] = node; }}>
              <span className="il-n">{l.name}{l.detail?.tag && <i className="il-tag">{l.detail.tag}</i>}</span>
              {l.detail?.sub && <span className="il-v fig">{l.detail.sub}{l.detail.pct != null && ` · ${l.detail.pct}%`}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="orbit-cap">
        {detail
          ? <>{detail.name}：{detail.learned} / {detail.total} {detail.unit}{detail.total ? `，${Math.round((detail.learned / detail.total) * 100)}%` : ''}</>
          : landed ? '上岸了。' : `${where} · 点一座岛看进度`}
        {nextReview && <>　·　下次复习 {nextReview.slice(5).replace('-', '.')}</>}
      </div>
    </div>
  );
}
