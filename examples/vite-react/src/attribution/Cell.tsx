import { memo } from 'react';

export const Cell = memo(function Cell({ index, onOpen }: { index: number; onOpen: (index: number) => void }) {
  return <button type="button" className="cell" style={{ width: 80, height: 80 }} onClick={() => onOpen(index)}>Item {index}</button>;
});
