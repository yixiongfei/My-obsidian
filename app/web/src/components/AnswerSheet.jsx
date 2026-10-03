import { useEffect, useRef, useState } from 'react';
import { api, vaultUrl } from '../api.js';

/**
 * 主观题作答卡：文字 + 手写图，一张卡片。
 *
 * 平板上写完截图，点一下这张卡，Ctrl+V 就贴进来了（拖进来也行），不用找按钮，也不再画一块虚线提示框占地方。
 * 图存进 图像/作答/，答案里记成独占一行的 ![](图像/作答/xxx.png)——存储还是一段文字，
 * 在 Obsidian 里也能看。交卷后文字锁定，但手写图可以继续补（对完答案才拍的也算），
 * 那时走 onLockedImages 单独落库。
 * 手写图多是白底：夜间反相后用「变亮」叠在面板上，白底融进主题底色；日间用正片叠底。
 */

const IMG_LINE = /^!\[\]\((图像\/作答\/[^)]+)\)$/;

export function splitAnswer(value = '') {
  const text = [];
  const images = [];
  for (const line of String(value).split('\n')) {
    const m = line.match(IMG_LINE);
    if (m) images.push(m[1]); else text.push(line);
  }
  return { text: text.join('\n'), images };
}

export function joinAnswer(text, images) {
  const tail = images.map((p) => `![](${p})`).join('\n');
  if (!tail) return text;
  return text ? `${text}\n${tail}` : tail;
}

/** 剪贴板里的图：截图工具给的是 files，浏览器「复制图片」有时只在 items 里 */
function clipboardImages(dt) {
  if (!dt) return [];
  const fromItems = [...(dt.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  return fromItems.length ? fromItems : [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
}

export default function AnswerSheet({ value = '', onChange, onLockedImages, locked = false, rows = 8, placeholder }) {
  const { text, images } = splitAnswer(value);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [focus, setFocus] = useState(false);
  // 连传几张时，每张传完都要基于最新的值追加，不能用闭包里那份旧的
  const latest = useRef(value);
  latest.current = value;
  const canImage = !locked || !!onLockedImages;

  const setImages = async (next) => {
    const cur = splitAnswer(latest.current);
    if (!locked) {
      const v = joinAnswer(cur.text, next);
      latest.current = v;
      onChange(v);
      return;
    }
    const saved = await onLockedImages(next);
    latest.current = saved;
  };

  const addFiles = async (list) => {
    const files = [...(list || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || !canImage) return;
    setErr('');
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const out = await api.uploadAnswerImage(f);
        const cur = splitAnswer(latest.current);
        if (!cur.images.includes(out.path)) await setImages([...cur.images, out.path]);
      } catch (e) {
        setErr(e.message);
      }
      setUploading((n) => n - 1);
    }
  };

  const removeImage = async (p) => {
    try { await setImages(splitAnswer(latest.current).images.filter((x) => x !== p)); } catch (e) { setErr(e.message); }
  };

  useEffect(() => {
    if (!zoom) return undefined;
    const key = (e) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [zoom]);

  const onPaste = (e) => {
    const files = clipboardImages(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };

  const showText = !locked || text.trim();
  // 交过卷、没写字也没贴图：卡里空着，给一行淡字说明还能补图
  const emptyLocked = locked && !showText && !images.length && canImage;

  return (
    // tabIndex 让整张卡能拿到焦点：点在卡片任何地方都能直接粘贴，交卷后也一样
    <div className={`ans${drag ? ' drag' : ''}${focus ? ' focus' : ''}${locked ? ' locked' : ''}`}
         tabIndex={-1}
         onFocus={() => setFocus(true)}
         onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false); }}
         onMouseDown={(e) => { if (e.target === e.currentTarget || e.target.closest('.ans-note')) e.currentTarget.focus(); }}
         onPaste={onPaste}
         onDragOver={(e) => { if (canImage && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
         onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
         onDrop={(e) => { if (!canImage) return; e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
      {showText && (
        <textarea className="ans-text" rows={images.length ? Math.min(rows, 3) : rows} value={text} readOnly={locked}
                  placeholder={placeholder}
                  onChange={(e) => onChange(joinAnswer(e.target.value, splitAnswer(latest.current).images))} />
      )}

      {images.length > 0 && (
        <div className="ans-imgs">
          {images.map((p) => (
            <figure className="ans-img" key={p}>
              <img src={vaultUrl(p)} alt="手写作答" draggable={false} onClick={() => setZoom(p)} />
              {canImage && (
                <button className="ans-x" aria-label="移除这张图" title="移除这张图" onClick={() => removeImage(p)}>×</button>
              )}
            </figure>
          ))}
        </div>
      )}

      {(uploading > 0 || emptyLocked) && (
        <div className="ans-note">{uploading ? `上传中 · ${uploading} 张` : '没写作答。点这里 Ctrl+V 还能补贴手写图'}</div>
      )}
      {err && <div className="ans-err">{err}</div>}

      {zoom && (
        <div className="ans-zoom" role="button" tabIndex={-1} onClick={() => setZoom(null)}>
          <img src={vaultUrl(zoom)} alt="手写作答" />
        </div>
      )}
    </div>
  );
}
