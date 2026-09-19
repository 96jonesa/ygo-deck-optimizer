import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo } from '../../shared/ipc';
import './styles.css';

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
  }, []);

  return (
    <main className="shell">
      <h1>YGO Deck Optimizer</h1>
      <p className="meta">
        {info === null
          ? 'Connecting to the main process…'
          : `v${info.version} · Electron ${info.electron} · Node ${info.node}`}
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
