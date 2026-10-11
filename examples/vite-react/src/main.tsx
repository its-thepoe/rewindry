import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main><h1>Rewindry preview fixture</h1><p>State A</p></main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
