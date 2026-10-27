import { Cell } from './Cell.tsx';

export function Board({ onOpen }: { onOpen: (index: number) => void }) {
  return (
    <section className="board" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 80px)', gap: 8 }}>
      {[1, 2, 3].map((index) => <Cell key={index} index={index} onOpen={onOpen} />)}
    </section>
  );
}
