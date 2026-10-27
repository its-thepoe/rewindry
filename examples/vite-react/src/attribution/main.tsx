import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Board } from './Board.tsx';
import { Header } from './Header.tsx';
import { ItemDialog } from './ItemDialog.tsx';

function App() {
  const screen = new URLSearchParams(window.location.search).get('screen') ?? 'home';
  const [open, setOpen] = useState<number | null>(null);
  if (screen === 'profile') return <main><Header screen="profile" /><h1>Profile</h1></main>;
  return (
    <main>
      <Header screen="home" />
      <h1>Board</h1>
      <label>Search <input name="search" /></label>
      <Board onOpen={setOpen} />
      {open !== null && <ItemDialog index={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
