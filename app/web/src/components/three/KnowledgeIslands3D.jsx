import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createStage, projectToScreen } from './stage.js';

/**
 * 2.5D 知识岛（深色主题的首页图）。
 *   等轴视角、悬浮在星空里的一串小岛：起点 → 英语 → 数学 → 408 → 初试，之字形向上，
 *   岛与岛之间是一段段悬空的台阶。
 *   岛的状态：未开始（深蓝灰、只剩轮廓）/ 进行中（蓝，亮度随 log 进度）/ 已完成（青，满亮）；
 *   小人站着的那座岛描紫边、脚下一盏紫光；三科全完成 → 登上初试岛，戴金色桂冠。
 *   小人从起点沿台阶慢慢走到当前岛（进入页面时走一遍），到了就原地小幅呼吸。
 *   当前岛 = 有进度的科目里最靠后的那科；在岛上的位置随该科进度从入口挪向出口。
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

export default function KnowledgeIslands3D({ steps = [], nextReview, theme }) {
  const mountRef = useRef(null);
  const labelRefs = useRef([]);

  // localStorage kb-debug-summit=1：三科全点亮，看登顶的样子（调试用）
  const stairs = useMemo(() => {
    let demo = false;
    try { demo = localStorage.getItem('kb-debug-summit') === '1'; } catch { /* 无 */ }
    return steps.map((s) => ({ ...s, lit: demo ? 1 : litOf(s.learned, s.total) }));
  }, [steps]);
  const summit = stairs.length > 0 && stairs.every((s) => s.lit >= 0.999);
  // 当前岛：有进度的科目里最靠后的一科（1 起；0 = 还在起点）
  const current = summit ? stairs.length + 1 : stairs.reduce((m, s, i) => (s.lit > 0 ? i + 1 : m), 0);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !stairs.length) return undefined;
    let unbind = () => {};

    const islands = layout(stairs.length + 2);   // 起点 + 各科 + 初试
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

        const stateOf = (i) => {
          if (i === 0) return { kind: 'start', lit: 1 };
          if (i === islands.length - 1) return { kind: 'summit', lit: summit ? 1 : 0 };
          const s = stairs[i - 1];
          return { kind: s.lit >= 0.999 ? 'done' : s.lit > 0 ? 'doing' : 'locked', lit: s.lit, data: s };
        };

        const built = islands.map((it, i) => {
          const st = stateOf(i);
          const geo = new THREE.BoxGeometry(it.size, THICK, it.size);
          const tone = st.kind === 'done' || st.kind === 'start' ? colors.cyan
            : st.kind === 'summit' ? (summit ? colors.due : colors.line)
              : st.kind === 'doing' ? colors.accent : colors.line;
          const glow = st.kind === 'done' ? 0.5 : st.kind === 'start' ? 0.18 : st.kind === 'summit' && summit ? 0.6 : st.lit * 0.34;
          const mat = new THREE.MeshStandardMaterial({
            color: tone, emissive: tone, emissiveIntensity: dark ? glow : glow * 0.4,
            roughness: 0.4, metalness: 0.35, transparent: true,
            opacity: st.kind === 'locked' || (st.kind === 'summit' && !summit) ? 0.3 : 0.5 + st.lit * 0.45,
          });
          const mesh = new THREE.Mesh(geo, mat);
          const group = new THREE.Group();
          group.position.copy(it.center);
          group.add(mesh);
          const edgeMat = new THREE.LineBasicMaterial({ color: i === current ? colors.purple : tone, transparent: true, opacity: i === current ? 1 : 0.7 });
          group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
          scene.add(group);
          return { ...it, i, st, group, mat, edgeMat, top: it.center.y + THICK / 2 };
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
        // 目标：当前岛上，按该科进度从入口偏到出口（±size/2 的 70%）
        let target;
        if (current === 0 || current >= built.length - 1) target = centerDist(Math.min(current, built.length - 1));
        else {
          const s = stairs[current - 1];
          target = centerDist(current) + (s.lit - 0.5) * built[current].size * 0.7;
        }

        // 小人
        const fig = buildFigure(colors, dark);
        fig.group.scale.setScalar(1.25);
        fig.laurel.visible = summit;
        scene.add(fig.group);
        const pos = new THREE.Vector3();
        const ahead = new THREE.Vector3();
        let walked = 0;                        // 已走的路线距离
        const speed = Math.max(3.2, target / 9); // 最长约 9 秒走到
        let facing = 0;
        at(0, pos); fig.group.position.copy(pos);

        if (summit) {
          const halo = new THREE.PointLight(colors.due, 2, 14);
          halo.position.set(built.at(-1).center.x, built.at(-1).top + 5, built.at(-1).center.z);
          scene.add(halo);
        }

        // 初试标记：终点岛上方的线框球
        const last = built[built.length - 1];
        const globe = new THREE.Mesh(new THREE.SphereGeometry(1.8, 18, 12),
          new THREE.MeshBasicMaterial({ color: summit ? colors.due : colors.dim, wireframe: true, transparent: true, opacity: 0.7 }));
        globe.position.set(last.center.x, last.top + 8.5, last.center.z);
        scene.add(globe);
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(last.center.x, last.top, last.center.z), new THREE.Vector3(last.center.x, last.top + 6.7, last.center.z)]),
        new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: 0.6 })));

        // 星野
        const n = 520;
        const sp = new Float32Array(n * 3);
        for (let i = 0; i < n; i += 1) {
          const r = 90 + Math.random() * 80, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
          sp[i * 3] = mid.x + r * Math.sin(ph) * Math.cos(th); sp[i * 3 + 1] = mid.y + r * Math.cos(ph) * 0.8; sp[i * 3 + 2] = mid.z + r * Math.sin(ph) * Math.sin(th);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
          color: dark ? colors.text : colors.dim, size: dark ? 0.7 : 0.5, transparent: true, opacity: dark ? 0.65 : 0.4, depthWrite: false, sizeAttenuation: false,
        }));
        scene.add(stars);

        // 指针视差：轻微转动等轴相机
        const par = { x: 0, y: 0, tx: 0, ty: 0 };
        const onMove = (ev) => {
          if (ev.pointerType === 'touch') return;
          const r = el.getBoundingClientRect();
          par.tx = ((ev.clientX - r.left) / r.width - 0.5) * 2;
          par.ty = ((ev.clientY - r.top) / r.height - 0.5) * 2;
        };
        const onLeave = () => { par.tx = 0; par.ty = 0; };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', onLeave);
        unbind = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerleave', onLeave); };

        const tmp = new THREE.Vector3();
        const anchor = new THREE.Vector3();
        const R = 90;

        return (t, dt) => {
          par.x += (par.tx - par.x) * 0.05;
          par.y += (par.ty - par.y) * 0.05;

          // 岛在宇宙里轻轻浮动，各自相位不同
          built.forEach((b, i) => {
            b.group.position.y = b.center.y + Math.sin(t * 0.6 + i * 1.3) * 0.18;
            if (i === current) b.edgeMat.opacity = 0.75 + Math.sin(t * 2.4) * 0.25;
          });

          // 小人：先沿路线走到目标，再原地呼吸；登顶则举手戴冠
          const moving = walked < target - 0.05;
          if (moving) {
            walked = Math.min(target, walked + speed * dt);
            at(walked, pos);
            at(Math.min(total, walked + 0.6), ahead);
            if (ahead.distanceToSquared(pos) > 1e-4) facing = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);
            fig.group.rotation.y += (facing - fig.group.rotation.y) * 0.2;
            const sw = Math.sin(t * 7) * 0.55;
            fig.legL.rotation.x = sw; fig.legR.rotation.x = -sw;
            fig.armL.rotation.x = -sw * 0.7; fig.armR.rotation.x = sw * 0.7;
            fig.group.position.set(pos.x, pos.y + Math.abs(Math.sin(t * 7)) * 0.07, pos.z);
          } else if (summit) {
            fig.armL.rotation.z = Math.PI * 0.8 + Math.sin(t * 3) * 0.12;
            fig.armR.rotation.z = -Math.PI * 0.8 - Math.sin(t * 3) * 0.12;
            fig.legL.rotation.x = 0; fig.legR.rotation.x = 0;
            fig.group.position.set(pos.x, pos.y + Math.abs(Math.sin(t * 3)) * 0.3, pos.z);
            fig.group.rotation.y += (Math.PI * 0.25 - fig.group.rotation.y) * 0.05;
            fig.laurel.rotation.y = t * 0.6;
          } else {
            // 站定：面朝下一段台阶的方向，轻微呼吸
            const nextDir = built[Math.min(current, built.length - 1)].dir;
            const face = Math.atan2(nextDir.x, nextDir.z);
            fig.group.rotation.y += (face - fig.group.rotation.y) * 0.05;
            fig.legL.rotation.x *= 0.9; fig.legR.rotation.x *= 0.9;
            fig.armL.rotation.x = Math.sin(t * 1.4) * 0.06; fig.armR.rotation.x = -Math.sin(t * 1.4) * 0.06;
            fig.group.position.set(pos.x, pos.y + Math.sin(t * 1.4) * 0.03, pos.z);
          }
          // 岛在浮动，小人跟着最近的那座岛一起动
          let under = built[0];
          for (const b of built) if (Math.abs(walked - centerDist(b.i)) < Math.abs(walked - centerDist(under.i))) under = b;
          fig.group.position.y += under.group.position.y - under.center.y;

          globe.rotation.y = t * 0.25;
          globe.rotation.x = Math.sin(t * 0.4) * 0.15;

          // 等轴相机：固定 45° 俯角方向，只做轻微视差
          const az = Math.PI / 4 + par.x * 0.09 + Math.sin(t * 0.1) * 0.03;
          const el2 = Math.atan(1 / Math.SQRT2) + par.y * 0.05;
          camera.position.set(
            mid.x + R * Math.cos(el2) * Math.sin(az),
            mid.y + R * Math.sin(el2),
            mid.z + R * Math.cos(el2) * Math.cos(az),
          );
          camera.lookAt(mid);

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
  }, [stairs, current, summit, theme]);

  if (!stairs.length) return <div className="orbit3d-empty">从一篇笔记开始</div>;

  const labels = [
    { key: 'start', name: '起点', sub: '', cls: 'done' },
    ...stairs.map((s, i) => ({
      key: s.key, name: s.name,
      sub: `${s.learned} / ${s.total} ${s.unit}`,
      cls: s.lit >= 0.999 ? 'done' : s.lit > 0 ? 'doing' : 'locked',
      tag: current === i + 1 && !summit ? '当前' : s.lit >= 0.999 ? '已完成' : s.lit > 0 ? '进行中' : '未开始',
    })),
    { key: 'summit', name: '初试', sub: summit ? '登顶' : '', cls: summit ? 'gold' : 'locked' },
  ];

  return (
    <div className="orbit3d">
      <div className="orbit3d-view">
        <div className="orbit3d-stage" ref={mountRef} role="img"
             aria-label={`知识岛：${stairs.map((s) => `${s.name} ${s.learned} / ${s.total} ${s.unit}`).join('，')}${summit ? '，已登顶' : ''}`} />
        <div className="orbit3d-labels">
          {labels.map((l, i) => (
            <div key={l.key} className={`isle-label ${l.cls}`} ref={(node) => { labelRefs.current[i] = node; }}>
              <span className="il-n">{l.name}{l.tag && <i className="il-tag">{l.tag}</i>}</span>
              {l.sub && <span className="il-v fig">{l.sub}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="orbit-cap">
        {summit ? '三座岛全亮，登顶。' : current === 0 ? '还在起点' : `当前在「${stairs[current - 1].name}」岛`}
        {nextReview && <>　·　下次复习 {nextReview.slice(5).replace('-', '.')}</>}
      </div>
    </div>
  );
}
