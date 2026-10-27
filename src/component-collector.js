// Runs inside a captured page (React development build only). Plain JS so it is
// serialized exactly as written. Reads React's dev-only fiber fields; never mutates them.
(options) => {
  const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
  const HOST_TAGS = new Set([5, 26, 27]);
  const origin = options?.origin ?? location.origin;
  const scrollX = options?.scrollX ?? window.scrollX;
  const scrollY = options?.scrollY ?? window.scrollY;

  const roots = options?.roots ?? (() => {
    const found = new Set();
    for (const element of document.querySelectorAll('*')) {
      for (const key of Object.keys(element)) {
        if (!key.startsWith('__reactContainer$')) continue;
        const fiber = element[key];
        if (fiber && fiber.tag === 3 && fiber.stateNode?.current) found.add(fiber.stateNode.current);
      }
    }
    return [...found];
  })();
  if (!roots.length) return { components: [], unattributed: 0, reason: 'react-root-not-found' };

  const nameOf = (fiber) => {
    const type = fiber.tag === 11 ? fiber.type?.render ?? fiber.type : fiber.type;
    return type?.displayName || type?.name || null;
  };

  // React creates the stack inside jsxDEV/createElement, so the owner's render is the first
  // frame after React's (and any JSX wrapper's) own frames, wherever its file is served from.
  const JSX_FRAME = /(^|[.\s])(jsxDEV|jsxs?|jsxWithValidation\w*|createElement)$/;
  const fileFromStack = (stack) => {
    if (typeof stack !== 'string') return null;
    for (const line of stack.split('\n').slice(1)) {
      const frame = /^\s*at\s+(?:(.*?)\s+\()?(\S+?):\d+:\d+\)?\s*$/.exec(line);
      if (!frame) return null;
      if (frame[1] && JSX_FRAME.test(frame[1])) continue;
      let url;
      try { url = new URL(frame[2]); } catch { return null; }
      if (url.origin !== origin) return null;
      return decodeURIComponent(url.pathname).replace(/^\/+/, '');
    }
    return null;
  };

  // React 18 records the JSX call site as _debugSource (an absolute file path from the JSX
  // dev transform). It is returned as-is; the caller makes it project-relative.
  const fileFromSource = (source) => {
    const fileName = typeof source?.fileName === 'string' ? source.fileName.replace(/\\/g, '/') : '';
    if (!fileName || fileName.includes('/node_modules/')) return null;
    return fileName;
  };

  // Each owned fiber's _debugStack (React 19) or _debugSource (React 18) points at the JSX call
  // inside its owner's render, so the owner component's source file is where that call lives.
  const ownerFiles = new Map();
  const ordered = [];
  const union = (a, b) => !a ? b : !b ? a : {
    left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
  };
  const visit = (fiber) => {
    // Reserve the slot before children so components stay in document (pre-)order.
    const slot = COMPONENT_TAGS.has(fiber.tag) ? ordered.push(null) - 1 : -1;
    let bounds = null;
    for (let child = fiber.child; child; child = child.sibling) bounds = union(bounds, visit(child));
    const owner = fiber._debugOwner;
    if (owner && !ownerFiles.has(owner)) {
      const file = fileFromStack(fiber._debugStack?.stack) ?? fileFromSource(fiber._debugSource);
      if (file) ownerFiles.set(owner, file);
    }
    if (HOST_TAGS.has(fiber.tag) && typeof fiber.stateNode?.getBoundingClientRect === 'function') {
      const rect = fiber.stateNode.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) bounds = union(bounds, rect);
    }
    if (slot >= 0) ordered[slot] = { fiber, bounds };
    return bounds;
  };
  for (const root of roots) visit(root);

  const occurrences = new Map();
  const components = [];
  let unattributed = 0;
  for (const { fiber, bounds } of ordered) {
    const component = nameOf(fiber);
    const file = ownerFiles.get(fiber) ?? (fiber.alternate ? ownerFiles.get(fiber.alternate) : undefined) ?? null;
    if (!component || !file) { unattributed++; continue; }
    if (!bounds) continue;
    const { left, top, right, bottom } = bounds;
    const key = `${file}#${component}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    components.push({
      key, file, component, occurrence,
      box: { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top },
    });
  }
  return { components, unattributed };
}
