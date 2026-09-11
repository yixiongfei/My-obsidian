import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createStage, projectToScreen } from './stage.js';

/**
 * 3D 星历仪。一个天体 = 一个一级学科：
 *   质量 = 1 + √篇数        篇数越多越重，离共同质心越近
 *   半径 = 1.3 + 1.7·∛(篇数/最多)
 *   自转 = 掌握度           掌握得越多转得越快
 * 轨道用解析解（1 体静止 / 2 体共质心 / 3 体拉格朗日等边），不做数值积分，
 * 所以长期不会漂移或撞在一起。
 */

const G = 170;
const SPACING_2 = 26;
const SPACING_3 = 25;

function layout(subjects) {
  const picked = subjects.filter((s) => s.notes > 0).slice(0, 3);
  if (!picked.length) return [];

  const maxNotes = Math.max(...picked.map((s) => s.notes));
  const base = picked.map((s) => ({
    name: s.name,
    notes: s.notes,
    mastery: s.mastery ?? 0,
    mass: 1 + Math.sqrt(s.notes),
    radius: 1.3 + 1.7 * Math.cbrt(s.notes / maxNotes),
  }));
  const M = base.reduce((a, b) => a + b.mass, 0);

  if (base.length === 1) return [{ ...base[0], orbitR: 0, phase: 0, omega: 0 }];

  if (base.length === 2) {
    const [a, b] = base;
    const omega = Math.sqrt((G * M) / SPACING_2 ** 3);
    return [
      { ...a, orbitR: (SPACING_2 * b.mass) / M, phase: 0, omega },
      { ...b, orbitR: (SPACING_2 * a.mass) / M, phase: Math.PI, omega },
    ];
  }

  const R3 = SPACING_3 / Math.sqrt(3);
  const verts = base.map((_, i) => {
    const a = (i * 2 * Math.PI) / 3 - Math.PI / 2;
    return [Math.cos(a) * R3, Math.sin(a) * R3];
  });
  const bx = verts.reduce((s, v, i) => s + v[0] * base[i].mass, 0) / M;
  const by = verts.reduce((s, v, i) => s + v[1] * base[i].mass, 0) / M;
  const omega = Math.sqrt((G * M) / SPACING_3 ** 3);

  return base.map((b, i) => {
    const x = verts[i][0] - bx;
    const y = verts[i][1] - by;
    return { ...b, orbitR: Math.hypot(x, y), phase: Math.atan2(y, x), omega };
  });
}

export default function Orrery3D({ subjects = [], theme }) {
  const hostRef = useRef(null);
  const mountRef = useRef(null);
  const labelRefs = useRef([]);

  const bodies = useMemo(() => layout(subjects), [subjects]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !bodies.length) return undefined;

    const stage = createStage(el, {
      fov: 42,
      cameraAt: [0, 30, 40],
      bloom: 0.85,
      build: ({ scene, camera, colors, dark }) => {
        scene.fog = new THREE.Fog(colors.bg, 70, 165);

        // 环境光必须是白光：拿 --text 当光色的话，浅色主题下它是近黑色，等于没开灯
        scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.5 : 0.95));
        const core = new THREE.PointLight(colors.accent, dark ? 260 : 120, 300, 2);
        scene.add(core);
        const rim = new THREE.DirectionalLight(colors.accent2, dark ? 1.1 : 0.7);
        rim.position.set(-30, 26, -18);
        scene.add(rim);

        // 共同质心：一颗自发光的小核，同时是场景唯一光源的位置
        const bary = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 24, 24),
          new THREE.MeshBasicMaterial({ color: colors.accent }),
        );
        scene.add(bary);

        // 参考平面：星历表的格网，给 3D 一个可读的地面
        const grid = new THREE.PolarGridHelper(40, 8, 4, 96, colors.line, colors.line);
        grid.material.transparent = true;
        grid.material.opacity = dark ? 0.22 : 0.28;
        grid.position.y = -0.01;
        scene.add(grid);

        // 星野
        const starPos = new Float32Array(520 * 3);
        for (let i = 0; i < 520; i += 1) {
          const r = 90 + Math.random() * 70;
          const th = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
          starPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
          starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
          color: dark ? colors.text : colors.dim,
          size: dark ? 0.75 : 0.6,
          sizeAttenuation: true,
          transparent: true,
          opacity: dark ? 0.75 : 0.5,
          depthWrite: false,
        }));
        scene.add(stars);

        const planets = bodies.map((b) => {
          const group = new THREE.Group();

          const mat = new THREE.MeshStandardMaterial({
            color: colors.accent,
            emissive: colors.accent,
            // 掌握度越高越自发光：这颗星"点着了"
            emissiveIntensity: (dark ? 0.25 : 0.05) + Math.min(1, b.mastery) * (dark ? 0.9 : 0.3),
            roughness: dark ? 0.32 : 0.48,
            metalness: dark ? 0.55 : 0.2,
          });
          const ball = new THREE.Mesh(new THREE.SphereGeometry(b.radius, 48, 48), mat);
          group.add(ball);

          // 细框架球壳：保住星历台的线描语言，不让它变成纯渲染球
          const wire = new THREE.Mesh(
            new THREE.SphereGeometry(b.radius * 1.16, 16, 12),
            new THREE.MeshBasicMaterial({
              color: colors.accent2, wireframe: true, transparent: true, opacity: dark ? 0.2 : 0.16,
            }),
          );
          group.add(wire);
          scene.add(group);

          // 轨道线
          if (b.orbitR > 0) {
            const pts = [];
            for (let i = 0; i <= 160; i += 1) {
              const a = (i / 160) * Math.PI * 2;
              pts.push(new THREE.Vector3(Math.cos(a) * b.orbitR, 0, Math.sin(a) * b.orbitR));
            }
            const ring = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(pts),
              new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: dark ? 0.55 : 0.8 }),
            );
            scene.add(ring);
          }

          // 拖尾：让"它在动"这件事一眼能看出来
          const TRAIL = 90;
          const trailGeo = new THREE.BufferGeometry();
          trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
          trailGeo.setDrawRange(0, 0);
          const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
            color: colors.accent, transparent: true, opacity: dark ? 0.55 : 0.4,
          }));
          scene.add(trail);

          return { ...b, group, ball, wire, trail, trailGeo, filled: 0 };
        });

        const tmp = new THREE.Vector3();
        const tmp2 = new THREE.Vector3();
        const edge = new THREE.Vector3();
        const size = { w: 0, h: 0 };

        return (t) => {
          planets.forEach((p, i) => {
            const a = p.phase + p.omega * t;
            p.group.position.set(Math.cos(a) * p.orbitR, 0, Math.sin(a) * p.orbitR);
            p.ball.rotation.y += 0.004 + Math.min(1, p.mastery) * 0.01;
            p.wire.rotation.y -= 0.002;

            const arr = p.trailGeo.attributes.position.array;
            if (p.orbitR > 0) {
              // 环形队列左移一格，当前位置压到队尾。
              // 缓冲区没填满时，有效点落在尾部，所以要从 cap-n 开始画——
              // 从 0 开始画会把前面那段还是 0 的位置当成轨迹，拉出一条连回原点的直线
              const cap = arr.length / 3;
              arr.copyWithin(0, 3);
              arr[(cap - 1) * 3] = p.group.position.x;
              arr[(cap - 1) * 3 + 1] = p.group.position.y;
              arr[(cap - 1) * 3 + 2] = p.group.position.z;
              p.filled = Math.min(p.filled + 1, cap);
              p.trailGeo.setDrawRange(cap - p.filled, p.filled);
              p.trailGeo.attributes.position.needsUpdate = true;
            }

            const host = mountRef.current;
            if (host) {
              size.w = host.clientWidth; size.h = host.clientHeight;
              const s = projectToScreen(p.group.position, camera, size.w, size.h, tmp);
              // 标签要让开球体本身：把球顶也投影一次，拿到它此刻的屏幕半径。
              // 固定像素偏移在近大远小的透视里必然会压到大行星上
              edge.copy(p.group.position).y += p.radius;
              const se = projectToScreen(edge, camera, size.w, size.h, tmp2);
              const rpx = Math.abs(se.y - s.y);
              const node = labelRefs.current[i];
              if (node) {
                node.style.transform = `translate(-50%, 0) translate(${s.x}px, ${s.y + rpx + 12}px)`;
                node.style.opacity = s.behind ? '0' : '1';
              }
            }
          });

          // 相机缓慢环绕 + 轻微起伏，静止的构图会让 3D 看起来像张图片
          // 相机缓慢环绕 + 轻微升降。仰角保持在 30° 上下，压得太低轨道会被拍扁成直线
          const ang = t * 0.055;
          camera.position.set(Math.sin(ang) * 40, 28 + Math.sin(t * 0.19) * 5, Math.cos(ang) * 40);
          camera.lookAt(0, 0, 0);
          stars.rotation.y = t * 0.008;
        };
      },
    });

    return () => stage.dispose();
  }, [bodies, theme]);

  if (!bodies.length) {
    return (
      <div className="orbit3d" ref={hostRef}>
        <div className="orbit3d-empty">从一篇笔记开始</div>
      </div>
    );
  }

  return (
    <div className="orbit3d" ref={hostRef}>
      <div className="orbit3d-view">
        {/* three.js 把 canvas 挂进这个空 div；React 永远不往里放子节点，免得和它打架 */}
        <div className="orbit3d-stage" ref={mountRef}
             role="img"
             aria-label={`学科轨道系统：${bodies.map((b) => `${b.name} ${b.notes} 篇`).join('，')}。笔记越多的学科质量越大、越靠近共同质心。`} />
        {/* 只留学科名：篇数已经由星球大小表达了，再写一遍是冗余 */}
        <div className="orbit3d-labels" aria-hidden="true">
          {bodies.map((b, i) => (
            <div key={b.name} className="orbit3d-label" ref={(el) => { labelRefs.current[i] = el; }}>
              <span className="o3-n">{b.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
