import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * three.js 舞台的公共外壳：渲染器、相机、辉光后期、尺寸同步、暂停与释放。
 *
 * 三条硬规则：
 *   1. 配色一律从 CSS token 读，3D 场景不许自己定义颜色
 *   2. 出视口 / 切后台 / 开启减少动态效果时停掉 RAF，不空转 GPU
 *   3. 卸载时必须把 geometry、material、texture、renderer 全部 dispose，
 *      否则切主题反复挂载会漏显存
 */

/** 读取当前主题的 token 颜色 */
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const v = (cs.getPropertyValue(name) || '').trim();
    return new THREE.Color(v || fallback);
  };
  return {
    bg: pick('--bg-1', '#0B0F1A'),
    accent: pick('--accent', '#4C7DFF'),
    accent2: pick('--accent-2', '#7FA0FF'),
    due: pick('--due', '#E8A33D'),
    text: pick('--text', '#E8ECF5'),
    dim: pick('--dim', '#5A6479'),
    line: pick('--line-2', '#2E3950'),
    cyan: pick('--hue-3', '#3FC0C8'),
    purple: pick('--hue-5', '#A98DF2'),
  };
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {HTMLElement} el            挂载容器
 * @param {object}      opts
 * @param {number}      opts.fov
 * @param {[number,number,number]} opts.cameraAt
 * @param {number}      opts.bloom    辉光强度，0 表示不挂后期
 * @param {number}      [opts.ortho]  给了就用正交相机（2.5D 等轴），值是视口高度对应的世界单位
 * @param {(ctx) => (t: number, dt: number) => void} opts.build
 *        构建场景，返回每帧调用的 update
 */
export function createStage(el, { fov = 38, cameraAt = [0, 0, 60], bloom = 0.7, shadows = false, ortho = 0, build }) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const colors = themeColors();

  const width = Math.max(1, el.clientWidth);
  const height = Math.max(1, el.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  /* 画布透明，底色交给外层卡片的 CSS 背景。
     用不透明清屏色的话，那个值会在合成器管线里被多做一次 sRGB 编码——
     #0B0F1A 实测输出成 rgb(59,69,90)，画布比页面黑底亮一大截。
     透明就绕开了这段色彩空间往返，和 token 底色天然对齐。 */
  renderer.setClearColor(0x000000, 0);
  // 同理不做色调映射：ACES 会把暗部整体抬亮
  renderer.toneMapping = THREE.NoToneMapping;
  if (shadows) {
    renderer.shadowMap.enabled = true;
    // r186 起 PCFSoftShadowMap 已被移除，写它只会拿到一句警告和静默回退。
    // 柔和度改由各光源的 shadow.radius 控制。
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  el.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const orthoFrustum = (cam, w, h) => {
    const a = w / h;
    cam.left = -ortho * a / 2; cam.right = ortho * a / 2; cam.top = ortho / 2; cam.bottom = -ortho / 2;
  };
  let camera;
  if (ortho > 0) {
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
    orthoFrustum(camera, width, height);
  } else {
    camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 2000);
  }
  camera.position.set(...cameraAt);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));

  /* 辉光只在深色主题挂。
     UnrealBloomPass 靠亮度阈值挑出"该发光的部分"，而纸底本身亮度就有 0.96，
     任何低于它的阈值都会让背景自己发光，整幅画被推到纯白、物体全被淹没。
     亮场里没有能同时保住背景和物体的阈值，所以浅色直接走无后期的直渲。 */
  const useBloom = dark && bloom > 0;
  let bloomPass = null;
  if (useBloom) {
    /* 阈值要卡得高。0.2 会把整块蓝色立方都判成"该发光"，
       光晕铺满画布，看上去像在黑底上盖了张灰卡。
       只让最亮的边缘和自发光点溢出，才是"发光"而不是"发雾"。 */
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), bloom, 0.35, 0.65);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  /* 活的尺寸对象：resize 时就地改写，组件每帧直接读它。
     组件千万别在 rAF 里读 clientWidth——读布局属性会强制同步 layout，
     而同一个循环里又在写 transform，两者互相作废，每帧都触发强制重排。 */
  const size = { width, height };

  const update = build({ THREE, scene, camera, renderer, colors, dark, size });

  const resize = () => {
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    size.width = w;
    size.height = h;
    if (ortho > 0) orthoFrustum(camera, w, h);
    else camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloomPass?.setSize(w, h);
    // 暂停状态下也要重画一帧：否则容器定下尺寸前画的那帧会一直留在屏幕上，
    // 投影出来的标签坐标也跟着错到画布外面
    if (!raf) draw(clock, 0);
  };
  const ro = new ResizeObserver(resize);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = 0;
  let clock = 0;
  let onScreen = true;

  const draw = (t, dt) => {
    update?.(t, dt);
    if (useBloom) composer.render();
    else renderer.render(scene, camera);
  };

  const frame = (now) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    clock += dt;
    draw(clock, dt);
    raf = requestAnimationFrame(frame);
  };

  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } last = 0; } ;
  const sync = () => {
    const run = onScreen && !document.hidden && !reduce.matches;
    if (run && !raf) raf = requestAnimationFrame(frame);
    else if (!run) stop();
  };

  // 先画一帧静态姿态：减少动态效果时这就是最终画面
  resize();
  draw(0, 0);

  ro.observe(el);
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }, { threshold: 0.01 });
  io.observe(el);
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', sync);
  sync();

  return {
    camera,
    scene,
    renderer,
    dispose() {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduce.removeEventListener('change', sync);
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
        else m?.dispose?.();
      });
      composer.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** 世界坐标 → 容器内的像素坐标，用来把 HTML 文字标签钉在 3D 物体上 */
export function projectToScreen(vec3, camera, width, height, out) {
  const p = out || new THREE.Vector3();
  p.copy(vec3).project(camera);
  return {
    x: (p.x * 0.5 + 0.5) * width,
    y: (-p.y * 0.5 + 0.5) * height,
    behind: p.z > 1,
  };
}
