import { createPortal } from 'react-dom';

export function ItemDialog({ index, onClose }: { index: number; onClose: () => void }) {
  return createPortal(
    <div role="dialog" aria-label={`Item ${index}`} className="item-dialog" style={{ position: 'fixed', top: 120, left: 40, width: 240, padding: 16, background: '#fff', border: '2px solid #000' }}>
      <p>Details for item {index}</p>
      <button type="button" onClick={onClose}>Close</button>
    </div>,
    document.body,
  );
}
