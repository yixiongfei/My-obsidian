import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * 渲染后端产出的笔记 HTML。
 * 站内 wiki 链接走前端路由（不整页刷新），图片点开是灯箱。
 */
export default function Prose({ html, className = '' }) {
  const navigate = useNavigate();
  const [zoom, setZoom] = useState(null);

  const onClick = useCallback((e) => {
    const link = e.target.closest('a[data-note]');
    if (link) {
      e.preventDefault();
      navigate(`/note/${encodeURIComponent(link.dataset.note)}`);
      return;
    }
    const canvas = e.target.closest('a.is-canvas');
    if (canvas) { e.preventDefault(); navigate('/schedule'); return; }
    const img = e.target.closest('.md-figure img');
    if (img) { e.preventDefault(); setZoom(img.src); }
  }, [navigate]);

  return (
    <>
      <div className={`prose ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      <AnimatePresence>
        {zoom && (
          <motion.div
            className="lightbox" onClick={() => setZoom(null)}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
          >
            <motion.img
              src={zoom} alt=""
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
