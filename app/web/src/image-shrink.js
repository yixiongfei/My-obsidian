/**
 * 上传前把图片缩到模型实际会用的尺寸，再转成 WebP。
 *
 * 模型看图时，长边超过 1568px 会先被缩小——多出来的像素只是白白拖慢上传、
 * 多占额度、推迟第一句回答。4K 屏上的截图动辄两三千像素宽、几百 KB 的 PNG，
 * 缩完转 WebP 一般几十 KB，手写的字照样清楚。
 * 已经够小的、动图、解不开的，原样返回。
 */

const MAX_EDGE = 1568;
const SMALL = 300 * 1024;

export async function shrinkImage(file, { maxEdge = MAX_EDGE, quality = 0.9 } = {}) {
  if (!file?.type?.startsWith('image/') || /gif|svg/.test(file.type)) return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= SMALL) { bmp.close(); return file; }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || (scale === 1 && blob.size >= file.size)) return file;
  return new File([blob], `${(file.name || 'paste').replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp' });
}
