import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Board } from './Board.tsx';
import { Header } from './Header.tsx';
import { HelpPanel } from './HelpPanel.tsx';
import { ItemDialog } from './ItemDialog.tsx';
import { WelcomeModal } from './WelcomeModal.tsx';

function App() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen') ?? 'home';
  const shell = params.get('shell') === '1';
  const [open, setOpen] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  // Opt-in, like a first-visit modal: it covers the board until dismissed.
  const [welcome, setWelcome] = useState(params.get('welcome') === '1');
  if (screen === 'profile') return <main><Header screen="profile" /><h1>Profile</h1></main>;
  const page = (
    <main>
      <Header screen="home" />
      <h1>Board</h1>
      <label>Search <input name="search" /></label>
      {/* Opt-in app-shell layout: the page height is fixed and the board sits far down an inner scroller. */}
      {shell && <div style={{ height: 1200 }} />}
      <Board onOpen={setOpen} />
      {/* A second click-only screen, after the board so earlier layout is unchanged. */}
      <button type="button" onClick={() => setHelp((value) => !value)}>Help</button>
      {help && <HelpPanel />}
      {open !== null && <ItemDialog index={open} onClose={() => setOpen(null)} />}
      {/* Start dismisses the modal and changes the URL, like an onboarding button; reloading that URL shows the modal again. */}
      {welcome && <WelcomeModal onClose={() => setWelcome(false)} onStart={() => {
        setWelcome(false);
        history.pushState(null, '', `${location.pathname}${location.search}&view=board`);
      }} />}
    </main>
  );
  if (!shell) return page;
  return (
    <div style={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{page}</div>
    </div>
  );
}

// App shells reset the body margin (as Tailwind's preflight does) so the 100dvh shell fits the viewport exactly.
if (new URLSearchParams(window.location.search).get('shell') === '1') document.body.style.margin = '0';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
