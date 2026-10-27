import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Board } from './Board.tsx';
import { Header } from './Header.tsx';
import { ItemDialog } from './ItemDialog.tsx';
import { WelcomeModal } from './WelcomeModal.tsx';

function App() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen') ?? 'home';
  const [open, setOpen] = useState<number | null>(null);
  // Opt-in, like a first-visit modal: it covers the board until dismissed.
  const [welcome, setWelcome] = useState(params.get('welcome') === '1');
  if (screen === 'profile') return <main><Header screen="profile" /><h1>Profile</h1></main>;
  return (
    <main>
      <Header screen="home" />
      <h1>Board</h1>
      <label>Search <input name="search" /></label>
      <Board onOpen={setOpen} />
      {open !== null && <ItemDialog index={open} onClose={() => setOpen(null)} />}
      {welcome && <WelcomeModal onClose={() => setWelcome(false)} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
