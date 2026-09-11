import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { createStage, projectToScreen } from './stage.js';

/**
 * 3D 学习立方堆（深色主题的首页图）。
 *   一层 = 一个一级学科，按篇数升序自下而上堆，篇数最多的在顶上
 *   亮度 = log1p(篇数)/log1p(最多)，用对数是因为线性映射会让少量差异完全看不出来
 *   空层 = 只留线框，但仍可点选
 * 顶上的线框球是初试日期标记，底下缓慢转动的小方块是下次复习。
 */

const W = 9;       // 层的宽深
const H = 3.4;     // 单层高度
const GAP = 0.3;

export default function CubeStack3D({ subjects = [], nextReview, theme }) {
  const mountRef = useRef(null);
  const labelRefs = useRef([]);
  const selectRef = useRef(0);
  const [selected, setSelected] = useState(0);

  const layers = useMemo(() => {
    const picked = subjects.slice(0, 4);
    const max = Math.max(1, ...picked.map((s) => s.notes));
    return [...picked]
      .sort((a, b) => (a.notes - b.notes) || (a.mastery - b.mastery))
      .map((s) => ({
        name: s.name,
        notes: s.notes,
        mastery: s.mastery ?? 0,
        lit: s.notes > 0 ? Math.log1p(s.notes) / Math.log1p(max) : 0,
      }));
  }, [subjects]);

  // 默认选中篇数最多的那层（排序后在最顶上）
  useEffect(() => {
    const top = layers.length - 1;
    selectRef.current = top;
    setSelected(top);
  }, [layers]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !layers.length) return undefined;

    // build 在 createStage 返回之前就执行，这时 stage 还在 TDZ 里，
    // 事件解绑只能挂到外面这个变量上
    let unbind = () => {};

    const stage = createStage(el, {
      fov: 40,
      cameraAt: [26, 16, 30],
      bloom: 0.32,
      build: ({ scene, camera, colors, dark }) => {
        scene.fog = new THREE.Fog(colors.bg, 60, 150);
        scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.42 : 0.9));

        const key = new THREE.DirectionalLight(0xffffff, dark ? 0.85 : 1.0);
        key.position.set(18, 28, 16);
        scene.add(key);
        const fill = new THREE.DirectionalLight(colors.accent2, dark ? 0.7 : 0.6);
        fill.position.set(-22, 8, -14);
        scene.add(fill);

        const totalH = layers.length * H + (layers.length - 1) * GAP;
        const yOf = (i) => -totalH / 2 + H / 2 + i * (H + GAP);

        const boxGeo = new THREE.BoxGeometry(W, H, W);
        const edgeGeo = new THREE.EdgesGeometry(boxGeo);

        const built = layers.map((l, i) => {
          const group = new THREE.Group();
          group.position.y = yOf(i);

          const mat = new THREE.MeshStandardMaterial({
            color: colors.accent,
            emissive: colors.accent,
            emissiveIntensity: l.lit * (dark ? 0.22 : 0.12),
            roughness: 0.38,
            metalness: 0.4,
            transparent: true,
            // 空层只留线框：没有笔记的学科不该有体积
            opacity: l.notes > 0 ? 0.35 + l.lit * 0.62 : 0.05,
          });
          const box = new THREE.Mesh(boxGeo, mat);
          group.add(box);

          const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
            color: colors.line, transparent: true, opacity: 0.9,
          }));
          group.add(edges);

          scene.add(group);
          return { ...l, group, box, mat, edges, y: yOf(i) };
        });

        // 初试标记：顶上的线框球
        const markY = totalH / 2 + 9;
        const globe = new THREE.Mesh(
          new THREE.SphereGeometry(2.5, 18, 12),
          new THREE.MeshBasicMaterial({ color: colors.dim, wireframe: true, transparent: true, opacity: 0.65 }),
        );
        globe.position.y = markY;
        scene.add(globe);
        const stem = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, totalH / 2, 0), new THREE.Vector3(0, markY - 2.5, 0),
          ]),
          new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: 0.6 }),
        );
        scene.add(stem);

        // 下次复习：底下悬着的小方块
        const chipY = -totalH / 2 - 7;
        const chip = new THREE.Group();
        const chipGeo = new THREE.BoxGeometry(3, 3, 3);
        chip.add(new THREE.Mesh(chipGeo, new THREE.MeshStandardMaterial({
          color: colors.bg, roughness: 0.5, metalness: 0.2, transparent: true, opacity: 0.6,
        })));
        chip.add(new THREE.LineSegments(new THREE.EdgesGeometry(chipGeo),
          new THREE.LineBasicMaterial({ color: colors.line })));
        chip.add(new THREE.Mesh(
          new THREE.SphereGeometry(0.42, 16, 16),
          new THREE.MeshBasicMaterial({ color: colors.accent }),
        ));
        chip.position.set(9, chipY, 4);
        scene.add(chip);

        // 星野
        const pos = new Float32Array(420 * 3);
        for (let i = 0; i < 420; i += 1) {
          const r = 75 + Math.random() * 60;
          const th = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
          pos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
          pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
          color: dark ? colors.text : colors.dim, size: dark ? 0.7 : 0.55,
          transparent: true, opacity: dark ? 0.7 : 0.45, depthWrite: false,
        }));
        scene.add(stars);

        // 点选：射线拾取命中的那一层
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const pick = (ev) => {
          const r = el.getBoundingClientRect();
          ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
          ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
          ray.setFromCamera(ndc, camera);
          const hit = ray.intersectObjects(built.map((b) => b.box), false)[0];
          if (hit) {
            const idx = built.findIndex((b) => b.box === hit.object);
            if (idx >= 0) { selectRef.current = idx; setSelected(idx); }
          }
        };
        el.addEventListener('click', pick);

        // 指针视差只写到这个对象上，不触发 React 重渲染——鼠标一动就 setState 会卡
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

        unbind = () => {
          el.removeEventListener('click', pick);
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerleave', onLeave);
        };

        const tmp = new THREE.Vector3();
        const anchor = new THREE.Vector3();
        const size = { w: 0, h: 0 };

        return (t) => {
          par.x += (par.tx - par.x) * 0.06;
          par.y += (par.ty - par.y) * 0.06;

          const sel = selectRef.current;
          built.forEach((b, i) => {
            const on = i === sel;
            b.edges.material.color.copy(on ? colors.accent2 : colors.line);
            b.edges.material.opacity = on ? 1 : 0.55;
            // 选中层轻微抬起，让"选中"这件事在 3D 里也读得出来
            const lift = on ? 0.55 : 0;
            b.group.position.y += (b.y + lift - b.group.position.y) * 0.12;
          });

          globe.rotation.y = t * 0.25;
          globe.rotation.x = Math.sin(t * 0.4) * 0.15;
          chip.rotation.y = t * 0.5;
          chip.position.y = chipY + Math.sin(t * 0.9) * 0.5;
          stars.rotation.y = t * 0.01;

          const ang = t * 0.07 + par.x * 0.32;
          const rad = 50;
          camera.position.set(Math.sin(ang) * rad, 17 - par.y * 5 + Math.sin(t * 0.23) * 2.5, Math.cos(ang) * rad);
          camera.lookAt(0, 0, 0);

          const host = mountRef.current;
          if (host) {
            size.w = host.clientWidth; size.h = host.clientHeight;
            built.forEach((b, i) => {
              anchor.set(W * 0.95, b.group.position.y, 0);
              const s = projectToScreen(anchor, camera, size.w, size.h, tmp);
              const node = labelRefs.current[i];
              if (node) {
                node.style.transform = `translate(0, -50%) translate(${s.x + 14}px, ${s.y}px)`;
                node.style.opacity = s.behind ? '0' : '1';
              }
            });
          }
        };
      },
    });

    return () => { unbind(); stage.dispose(); };
  }, [layers, theme]);

  if (!layers.length) return <div className="orbit3d-empty">从一篇笔记开始</div>;

  return (
    <div className="orbit3d">
      <div className="orbit3d-view">
        <div className="orbit3d-stage" ref={mountRef}
             role="img"
             aria-label={`学习立方：${layers.map((l) => `${l.name} ${l.notes} 篇`).join('，')}`} />
        {/* 只留学科名：篇数由层的体积表达，掌握度由亮度表达，写成文字是冗余 */}
        <div className="orbit3d-labels">
          {layers.map((l, i) => (
            <button key={l.name}
                    className={`cube-label${i === selected ? ' on' : ''}`}
                    ref={(el) => { labelRefs.current[i] = el; }}
                    onClick={() => { selectRef.current = i; setSelected(i); }}>
              <span className="cl-n">{l.name}</span>
            </button>
          ))}
        </div>
      </div>
      {/* 复习周期在首页导语里已经写过，初试日期在折线以下的倒计时里；这里只留底下那个小方块的说明 */}
      {nextReview && (
        <div className="orbit-cap">下次复习 {nextReview.slice(5).replace('-', '.')}</div>
      )}
    </div>
  );
}
