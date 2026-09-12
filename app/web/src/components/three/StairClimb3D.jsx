import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createStage, projectToScreen } from './stage.js';

/**
 * 3D 登阶（深色主题的首页图）。
 *   三级台阶自左向右升高：英语 → 数学 → 408，材质沿用蓝色发光立方
 *   亮度 = log1p(学了多少) / log1p(总数)：词表 4801 个、考点 316 个，线性映射前几个月什么都看不出来，
 *   对数让"开始学了"立刻有反馈，后期增长放缓——和真实的学习曲线一样
 *   小人站在总进度对应的位置上：三级亮度之和 c∈[0,3]，floor(c) 是脚下哪一级，小数部分是在这一级走了多远
 *   三级全亮 → 小人站上顶阶、举起双手、头顶桂冠
 * 顶上的线框球仍是初试标记。
 */

const STEP_W = 7.5;    // 每级台阶的宽（前进方向）
const STEP_D = 9;      // 台阶的深
const RISE = 3.2;      // 每级升高
const GAP = 0.25;

const litOf = (learned, total) => (total > 0 && learned > 0 ? Math.min(1, Math.log1p(learned) / Math.log1p(total)) : 0);

/** 火柴人：几何体都很小，直接用基础几何拼，够看清"一个人"就行 */
function buildFigure(colors, dark) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: colors.text, emissive: colors.text, emissiveIntensity: dark ? 0.08 : 0.03, roughness: 0.55, metalness: 0.1,
  });
  const limbGeo = new THREE.CylinderGeometry(0.11, 0.11, 1.5, 8);
  const mk = (geo, mat = skin) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };

  const head = mk(new THREE.SphereGeometry(0.5, 20, 16)); head.position.y = 3.35; g.add(head);
  const torso = mk(new THREE.CylinderGeometry(0.22, 0.28, 1.7, 10)); torso.position.y = 2.05; g.add(torso);

  // 四肢各自挂在关节 pivot 上，动画只转 pivot
  const limb = (x, y, len = 1.5) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const m = mk(limbGeo.clone().scale(1, len / 1.5, 1)); m.position.y = -len / 2; pivot.add(m);
    g.add(pivot); return pivot;
  };
  const armL = limb(-0.42, 2.8, 1.35), armR = limb(0.42, 2.8, 1.35);
  const legL = limb(-0.2, 1.25, 1.3), legR = limb(0.2, 1.25, 1.3);

  // 桂冠：细环 + 一圈小叶，琥珀色，只在登顶时显示
  const laurel = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: colors.due, emissive: colors.due, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.5 });
  laurel.add(new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.05, 8, 40), gold));
  const leafGeo = new THREE.SphereGeometry(0.11, 8, 6);
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    const leaf = new THREE.Mesh(leafGeo, gold);
    leaf.position.set(Math.cos(a) * 0.56, (i % 2 ? 0.09 : -0.02), Math.sin(a) * 0.56);
    leaf.scale.set(1, 0.6, 1.8);
    leaf.rotation.y = -a;
    laurel.add(leaf);
  }
  laurel.rotation.x = Math.PI / 2 * 0.1;
  laurel.position.y = 3.6;
  laurel.visible = false;
  g.add(laurel);

  return { group: g, head, armL, armR, legL, legR, laurel };
}

export default function StairClimb3D({ steps = [], nextReview, theme }) {
  const mountRef = useRef(null);
  const labelRefs = useRef([]);

  // localStorage kb-debug-summit=1：把三级全点亮，用来看登顶的样子（调试用，不进设置面板）
  const stairs = useMemo(() => {
    let demo = false;
    try { demo = localStorage.getItem('kb-debug-summit') === '1'; } catch { /* 无 */ }
    return steps.map((s) => ({ ...s, lit: demo ? 1 : litOf(s.learned, s.total) }));
  }, [steps]);
  const climb = useMemo(() => stairs.reduce((a, s) => a + s.lit, 0), [stairs]);
  const summit = stairs.length > 0 && stairs.every((s) => s.lit >= 0.999);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !stairs.length) return undefined;
    let unbind = () => {};

    const stage = createStage(el, {
      fov: 38,
      cameraAt: [30, 18, 34],
      bloom: 0.34,
      shadows: true,
      build: ({ scene, camera, colors, dark, size }) => {
        scene.fog = new THREE.Fog(colors.bg, 60, 150);
        scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.42 : 0.9));
        const key = new THREE.DirectionalLight(0xffffff, dark ? 0.85 : 1.0);
        key.position.set(18, 30, 16);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 5; key.shadow.camera.far = 100;
        Object.assign(key.shadow.camera, { left: -26, right: 26, top: 30, bottom: -26 });
        key.shadow.bias = -0.002; key.shadow.radius = 3;
        scene.add(key);
        const fill = new THREE.DirectionalLight(colors.accent2, dark ? 0.7 : 0.6);
        fill.position.set(-22, 8, -14);
        scene.add(fill);

        // 台阶：第 i 级从地面起、高 (i+1)*RISE，沿 x 依次排开；整体居中
        const n = stairs.length;
        const totalW = n * STEP_W + (n - 1) * GAP;
        const x0 = -totalW / 2 + STEP_W / 2;
        const groundY = -((n * RISE) / 2) - 1;   // 让整段阶梯在画面中垂直居中
        const built = stairs.map((s, i) => {
          const h = (i + 1) * RISE;
          const geo = new THREE.BoxGeometry(STEP_W, h, STEP_D);
          const mat = new THREE.MeshStandardMaterial({
            color: colors.accent, emissive: colors.accent,
            emissiveIntensity: s.lit * (dark ? 0.26 : 0.12),
            roughness: 0.38, metalness: 0.4, transparent: true,
            // 一点都没学的那级只留线框
            opacity: s.lit > 0 ? 0.3 + s.lit * 0.66 : 0.05,
          });
          const box = new THREE.Mesh(geo, mat);
          box.castShadow = true; box.receiveShadow = true;
          const group = new THREE.Group();
          group.position.set(x0 + i * (STEP_W + GAP), groundY + h / 2, 0);
          group.add(box);
          group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({
            color: s.lit > 0 ? colors.accent2 : colors.line, transparent: true, opacity: s.lit > 0 ? 0.9 : 0.55,
          })));
          scene.add(group);
          return { ...s, group, topY: groundY + h, x: group.position.x };
        });

        // 影子接地面
        const catcher = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({ opacity: dark ? 0.22 : 0.18 }));
        catcher.rotation.x = -Math.PI / 2;
        catcher.position.y = groundY;
        catcher.receiveShadow = true;
        scene.add(catcher);

        // 小人：站在 climb 对应的位置。floor(c) 级台阶上，从这一级左缘走到右缘
        const fig = buildFigure(colors, dark);
        const idx = Math.min(n - 1, Math.floor(climb));
        const frac = summit ? 0.5 : Math.min(0.92, Math.max(0.12, climb - idx));
        const onStep = built[idx];
        const standX = onStep.x - STEP_W / 2 + frac * STEP_W;
        // 站在台阶前沿附近、放大一点，别被更高的那级挡住
        fig.group.position.set(standX, onStep.topY, STEP_D / 2 - 1.6);
        fig.group.scale.setScalar(1.2);
        fig.group.rotation.y = summit ? 0 : -Math.PI * 0.25;   // 侧身朝向更高的下一级
        fig.laurel.visible = summit;
        scene.add(fig.group);

        // 登顶用的光：桂冠下面一盏小点光，照亮头肩
        if (summit) {
          const halo = new THREE.PointLight(colors.due, 1.6, 12);
          halo.position.set(standX, onStep.topY + 5.5, STEP_D / 2 - 0.5);
          scene.add(halo);
        }

        // 初试标记：最高一级上方的线框球，小人的目标
        const last = built[n - 1];
        const markY = last.topY + 8;
        const globe = new THREE.Mesh(new THREE.SphereGeometry(2.2, 18, 12),
          new THREE.MeshBasicMaterial({ color: colors.dim, wireframe: true, transparent: true, opacity: 0.65 }));
        // 往后挪一点，登顶的小人站在前沿，别和这根线穿在一起
        globe.position.set(last.x, markY, -2.5);
        scene.add(globe);
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(last.x, last.topY, -2.5), new THREE.Vector3(last.x, markY - 2.2, -2.5)]),
        new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: 0.6 })));

        // 星野
        const pos = new Float32Array(420 * 3);
        for (let i = 0; i < 420; i += 1) {
          const r = 75 + Math.random() * 60, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
          pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph) * 0.7; pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
          color: dark ? colors.text : colors.dim, size: dark ? 0.7 : 0.55, transparent: true, opacity: dark ? 0.7 : 0.45, depthWrite: false,
        }));
        scene.add(stars);

        // 指针视差
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
        const centerY = groundY + (n * RISE) / 2;

        return (t) => {
          par.x += (par.tx - par.x) * 0.06;
          par.y += (par.ty - par.y) * 0.06;

          // 小人：登顶欢呼（举手 + 轻跳）/ 途中原地小幅踏步
          if (summit) {
            fig.armL.rotation.z = Math.PI * 0.8 + Math.sin(t * 3) * 0.15;
            fig.armR.rotation.z = -Math.PI * 0.8 - Math.sin(t * 3) * 0.15;
            fig.group.position.y = onStep.topY + Math.abs(Math.sin(t * 3)) * 0.35;
            fig.laurel.rotation.y = t * 0.6;
          } else {
            const sw = Math.sin(t * 2.2) * 0.35;
            fig.armL.rotation.x = sw; fig.armR.rotation.x = -sw;
            fig.legL.rotation.x = -sw * 0.8; fig.legR.rotation.x = sw * 0.8;
            fig.group.position.y = onStep.topY + Math.abs(Math.sin(t * 2.2)) * 0.08;
          }

          globe.rotation.y = t * 0.25;
          globe.rotation.x = Math.sin(t * 0.4) * 0.15;
          stars.rotation.y = t * 0.01;

          // 从左前方看：最矮的英语一级离镜头最近，台阶向右后方升高，是最"像楼梯"的角度
          const ang = -0.62 + Math.sin(t * 0.12) * 0.22 + par.x * 0.28;
          const rad = 44;
          camera.position.set(Math.sin(ang) * rad, centerY + 14 - par.y * 5 + Math.sin(t * 0.23) * 1.5, Math.cos(ang) * rad);
          camera.lookAt(1.5, centerY + 1, 0);

          // 标签贴在每级台阶正面的脚下，一排读过去就是三级的进度
          built.forEach((b, i) => {
            anchor.set(b.x, groundY - 0.4, STEP_D / 2);
            const s = projectToScreen(anchor, camera, size.width, size.height, tmp);
            const node = labelRefs.current[i];
            if (node) {
              node.style.transform = `translate(-50%, 0) translate(${s.x}px, ${s.y + 6}px)`;
              node.style.opacity = s.behind ? '0' : '1';
            }
          });
        };
      },
    });

    return () => { unbind(); stage.dispose(); };
  }, [stairs, climb, summit, theme]);

  if (!stairs.length) return <div className="orbit3d-empty">从一篇笔记开始</div>;

  return (
    <div className="orbit3d">
      <div className="orbit3d-view">
        <div className="orbit3d-stage" ref={mountRef} role="img"
             aria-label={`登阶：${stairs.map((s) => `${s.name} ${s.learned} / ${s.total} ${s.unit}`).join('，')}${summit ? '，已登顶' : ''}`} />
        <div className="orbit3d-labels">
          {stairs.map((s, i) => (
            <div key={s.key} className={`stair-label${s.lit > 0 ? ' on' : ''}`} ref={(node) => { labelRefs.current[i] = node; }}>
              <span className="sl-n">{s.name}</span>
              <span className="sl-v fig">{s.learned} / {s.total} {s.unit}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="orbit-cap">
        {summit ? '三级全亮，登顶。' : `脚下第 ${Math.min(stairs.length, Math.floor(climb) + 1)} 级 · ${stairs[Math.min(stairs.length - 1, Math.floor(climb))].name}`}
        {nextReview && <>　·　下次复习 {nextReview.slice(5).replace('-', '.')}</>}
      </div>
    </div>
  );
}
