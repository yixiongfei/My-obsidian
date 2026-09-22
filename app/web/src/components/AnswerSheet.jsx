import { useEffect, useRef, useState } from 'react';
import { api, vaultUrl } from '../api.js';

/**
 * 主观题作答区：文字 + 手写图。
 *
 * 平板上写完截图粘进来（或拖进来、点「插入图片」），图存进 图像/作答/，
 * 答案里记成独占一行的 ![](图像/作答/xxx.png)——存储格式不变（还是一段文字），
 * 在 Obsidian 里也是能看的 Markdown。文本框里只显示文字，图排在下面。
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

export default function AnswerSheet({ value = '', onChange, locked = false, rows = 8, placeholder }) {
  const { text, images } = splitAnswer(value);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [zoom, setZoom] = useState(null);
  const fileRef = useRef(null);
  // 连传几张时，每张传完都要基于最新的值追加，不能用闭包里那份旧的
  const latest = useRef(value);
  latest.current = value;

  const emit = (next) => { latest.current = next; onChange(next); };

  const addFiles = async (list) => {
    const files = [...(list || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || locked) return;
    setErr('');
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const out = await api.uploadAnswerImage(f);
        const cur = splitAnswer(latest.current);
        if (!cur.images.includes(out.path)) emit(joinAnswer(cur.text, [...cur.images, out.path]));
      } catch (e) {
        setErr(e.message);
      }
      setUploading((n) => n - 1);
    }
  };

  useEffect(() => {
    if (!zoom) return undefined;
    const key = (e) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [zoom]);

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.some((f) => f.type.startsWith('image/'))) return;
    e.preventDefault();
    addFiles(files);
  };

  return (
    <div className={`ans${drag ? ' drag' : ''}`}
         onDragOver={(e) => { if (!locked && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
         onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
         onDrop={(e) => { if (locked) return; e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
      <textarea className="paper-input" rows={images.length ? Math.min(rows, 4) : rows} value={text} readOnly={locked}
                placeholder={placeholder}
                onPaste={onPaste}
                onChange={(e) => emit(joinAnswer(e.target.value, splitAnswer(latest.current).images))} />

      {images.map((p) => (
        <figure className="ans-img" key={p}>
          <img src={vaultUrl(p)} alt="手写作答" draggable={false} onClick={() => setZoom(p)} />
          {!locked && (
            <button className="ans-x" aria-label="移除这张图" title="移除这张图"
                    onClick={() => { const cur = splitAnswer(latest.current); emit(joinAnswer(cur.text, cur.images.filter((x) => x !== p))); }}>
              ×
            </button>
          )}
        </figure>
      ))}

      {!locked && (
        <div className="ans-bar">
          <span>{uploading ? `上传中 · ${uploading} 张` : '手写的解题过程可以直接粘贴、拖进来'}</span>
          <span className="spacer" />
          <button className="ans-pick" onClick={() => fileRef.current?.click()}>插入图片</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </div>
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
