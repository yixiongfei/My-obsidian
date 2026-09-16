import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/**
 * PDF 首页 → PNG。
 *
 * 浏览器原生的 PDF 预览（<iframe src=…>）也能看，但它是个**阅读器**：自带滚动条、
 * 不跟着纸片缩放、在一张 200px 宽的便利贴上只能挤出一条缝。便利贴要的是一张**图**，
 * 所以在前端把第一页光栅化，当封面贴上去；原始 PDF 仍然留着，点开纸片是完整阅读器。
 *
 * 整个 pdf.js 只在真的拖进来一个 PDF 时才动态加载，平时不进主包。
 *
 * 走 legacy/ 而不是默认构建：pdf.js 6 的主构建直接用了 Map.prototype.getOrInsertComputed
 * 这类刚进标准的方法，Electron 37（Chromium 138）上没有，一渲染就 TypeError。
 * legacy 构建自带 core-js 垫片，代价是包大一点——反正是按需加载的旁支。
 *
 * cMap 和标准字体必须给本地路径：考研真题这类中文 PDF 大量用 Adobe-GB1 之类的
 * 预定义 CMap，缺了它们整页渲染出来是空白。这两份资源由 vite.config.js 从
 * pdfjs-dist 复制到 public/pdfjs/，跟着 dist-web 一起打包，全程不出网。
 */

const BASE = new URL('pdfjs/', document.baseURI).href;

export async function pdfPoster(url, { maxW = 1400 } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  /* destroy() 在 loadingTask 上，不在文档代理上（pdf.js v6 把它挪走了）。
     拿错对象的后果很隐蔽：封面其实已经渲染好了，却在 finally 里抛出去，
     整个函数看起来像"渲染失败"，一路退回 iframe */
  const task = pdfjs.getDocument({
    url,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    isEvalSupported: false,
  });
  const doc = await task.promise;

  try {
    const pages = doc.numPages;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // 封面最宽 1400px：纸片上是缩略图，点开也够看，再大只是白烧内存
    const viewport = page.getViewport({ scale: Math.min(2, maxW / (base.width || maxW)) });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    // PDF 页面本身是透明的，不铺白底的话透出便利贴的黄，字就糊了
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    page.cleanup();
    if (!blob) throw new Error('canvas 导不出图');
    return { blob, w: canvas.width, h: canvas.height, pages };
  } finally {
    task.destroy().catch(() => {});
  }
}
