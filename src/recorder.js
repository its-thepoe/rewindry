// Dev-only. Learns how to reach UI states from ordinary use in any browser. Records route
// changes, clicks, Escape and select choices as structural locators; never typed text,
// input values, clipboard, cookies or storage. Served wrapped with the component collector.
(collectComponentMap) => {
  if (window.__rewindryRecorder || globalThis.__rewindryCapture) return;
  window.__rewindryRecorder = true;

  const ENDPOINT = '/__rewindry/states';
  const MAX_STEPS = 25;
  const QUIET_MS = 300;
  const MAX_SETTLE_MS = 2_000;
  const MAX_NAME = 120;
  const INTERACTIVE = 'button, a[href], summary, label, select, input, textarea, [role], [data-testid], [tabindex]:not([tabindex="-1"])';
  try { performance.setResourceTimingBufferSize(5_000); } catch { /* Older engines keep their default buffer. */ }

  let route = location.pathname + location.search;
  // The URL the current steps start from; it differs from `route` after a click changed the URL.
  let start = route;
  let steps = [];
  let clicked = false;
  let known = new Set();
  // Shortest path to each screen seen since this URL loaded, keyed by its component set.
  let reached = new Map();
  let queue = Promise.resolve();

  const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  const isTextEntry = (element) => element.isContentEditable || element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'color', 'range'].includes(element.type));

  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') {
      const type = element.type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return isTextEntry(element) ? 'textbox' : null;
    }
    return null;
  };

  // Labels and UI text only. Values and text inside editable fields are never read.
  const nameOf = (element) => {
    const label = element.getAttribute('aria-label');
    if (label) return normalize(label);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      return normalize(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    }
    if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
      const labels = [...(element.labels ?? [])].map((item) => item.textContent).join(' ');
      return normalize(labels || element.getAttribute('placeholder') || element.getAttribute('title'));
    }
    if (element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])')) return '';
    return normalize(element.textContent || element.getAttribute('title'));
  };

  const cssPath = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') { parts.unshift(tag); break; }
      const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    }
    return parts.join(' > ');
  };

  // Several candidates per step so replay can fall back when markup shifts.
  const locate = (element) => {
    const candidates = [];
    const testId = element.getAttribute('data-testid');
    if (testId && testId.length <= 200) {
      const matches = [...document.querySelectorAll('[data-testid]')].filter((item) => item.getAttribute('data-testid') === testId);
      candidates.push({ by: 'testid', value: testId, index: matches.indexOf(element) });
    }
    const role = roleOf(element);
    const name = role ? nameOf(element) : '';
    if (role && name && name.length <= MAX_NAME) {
      const matches = [...document.querySelectorAll('*')].filter((item) => roleOf(item) === role && nameOf(item) === name);
      candidates.push({ by: 'role', role, name, index: matches.indexOf(element) });
    }
    const path = cssPath(element);
    if (path && path.length <= 400) candidates.push({ by: 'css', value: path, index: [...document.querySelectorAll(path)].indexOf(element) });
    return candidates.filter((candidate) => candidate.index >= 0);
  };

  const settle = () => new Promise((resolve) => {
    let quiet;
    const finish = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      // Wait for paint, but not forever: browsers pause animation frames in background tabs and hidden panes.
      // Wait for paint, but not forever: browsers pause animation frames in background tabs and hidden panes.
      const painted = setTimeout(resolve, 200);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(painted); resolve(); }));
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, QUIET_MS);
    const limit = setTimeout(finish, MAX_SETTLE_MS);
  });

  const loadedModules = () => {
    const modules = new Set();
    for (const entry of performance.getEntriesByType('resource')) {
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (url.origin !== location.origin) continue;
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!path || path.startsWith('@') || path.startsWith('__rewindry') || path.includes('node_modules/') ||
          path.split('/').some((part) => part === '..' || part === '.')) continue;
      modules.add(path);
    }
    return [...modules].slice(0, 2_000);
  };

  const snapshot = async (force) => {
    clicked = false;
    let keys = [];
    try { keys = [...new Set(collectComponentMap().components.map((item) => item.key))].sort(); } catch { /* Screen-level only. */ }
    const appeared = keys.some((key) => !known.has(key));
    known = new Set(keys);
    // Back on a screen reached earlier (a dialog closed by its button, Escape or the backdrop):
    // the steps that opened and dismissed it are dropped, so replay never depends on them.
    const screen = `${route}\n${keys.join('\n')}`;
    const earlier = reached.get(screen);
    if (earlier && earlier.length <= steps.length) steps = earlier.slice();
    else reached.set(screen, steps.slice());
    const path = start === route ? steps : [{ action: 'load', route: start }, ...steps];
    if ((!force && !appeared) || path.length > MAX_STEPS) return;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route, path, components: keys, modules: loadedModules() }),
      });
      // Drain the body: an unread response stays open and keeps the page from reaching network idle.
      await response.arrayBuffer();
    } catch { /* Learning is best-effort; the app must never notice. */ }
  };

  // A URL change starts a new state. When a click changed it, the app may carry state across (a
  // welcome sheet that click dismissed), so the steps so far are kept and replay starts from the
  // earlier URL. Otherwise (load-time redirects, Back and Forward) replay loads the new URL directly.
  const routeChanged = (history) => {
    const next = location.pathname + location.search;
    if (next === route) return false;
    const carried = clicked && !history;
    route = next;
    known = new Set();
    if (!carried) {
      start = next;
      steps = [];
      reached = new Map();
    }
    return true;
  };

  // Steps join the path at click time, so each snapshot's path matches the page it sees after settling.
  const after = (step, history = false) => {
    if (step) {
      steps.push(step);
      clicked = true;
    }
    queue = queue.then(settle).then(() => snapshot(routeChanged(history))).catch(() => {});
  };

  const outsideRewindry = (element) => !element.closest('#rewindry-overlay-root');

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element) || !outsideRewindry(event.target)) return;
    const element = event.target.closest(INTERACTIVE) ?? event.target;
    if (element.tagName === 'SELECT' || element.tagName === 'OPTION') return;
    const target = locate(element);
    if (target.length) after({ action: 'click', target });
  }, true);

  document.addEventListener('change', (event) => {
    const element = event.target;
    if (!event.isTrusted || !(element instanceof HTMLSelectElement) || !outsideRewindry(element)) return;
    const target = locate(element);
    if (target.length) after({ action: 'select', target, option: { index: element.selectedIndex } });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Escape') after({ action: 'key', key: 'Escape' });
  }, true);

  window.addEventListener('popstate', () => after(null, true));
  queue = queue.then(settle).then(() => snapshot(true)).catch(() => {});
}
