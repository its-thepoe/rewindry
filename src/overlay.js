(() => {
  if (document.getElementById('rewindry-overlay-root')) return;
  const host = document.createElement('div');
  host.id = 'rewindry-overlay-root';
  const shadow = host.attachShadow({ mode: 'open' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/__rewindry/overlay.css';
  shadow.append(stylesheet);
  const root = document.createElement('div');
  root.innerHTML = `
    <button class="trigger" type="button" title="Open Rewindry timeline (Alt+Shift+R)" aria-label="Open Rewindry timeline (Alt+Shift+R)" aria-expanded="false">●</button>
    <section class="review" hidden aria-label="Recorded visual">
      <div class="visual"><img alt="" hidden><p class="missing" hidden>No visual was captured for this iteration.</p></div>
      <time class="time"></time>
    </section>
    <nav class="timeline" hidden aria-label="Rewindry iteration timeline" aria-keyshortcuts="Alt+Shift+R">
      <button class="control previous" type="button" title="Previous iteration" aria-label="Previous iteration">‹</button>
      <div class="dots" role="group" aria-label="Recorded iterations and current state"></div>
      <button class="control next" type="button" title="Next iteration" aria-label="Next iteration">›</button>
      <button class="control play" type="button" title="Play history" aria-label="Play history">▶</button>
      <button class="control close" type="button" title="Close timeline" aria-label="Close timeline">×</button>
    </nav>
    <div class="peek" hidden><img alt="" hidden><span class="peek-label"></span></div>`;
  shadow.append(root);
  const trigger = root.querySelector('.trigger');
  const review = root.querySelector('.review');
  const image = root.querySelector('.visual img');
  const missing = root.querySelector('.missing');
  const time = root.querySelector('.time');
  const timeline = root.querySelector('.timeline');
  const dots = root.querySelector('.dots');
  const previous = root.querySelector('.previous');
  const next = root.querySelector('.next');
  const play = root.querySelector('.play');
  const close = root.querySelector('.close');
  const peek = root.querySelector('.peek');
  const peekImage = root.querySelector('.peek img');
  const peekLabel = root.querySelector('.peek-label');
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  image.addEventListener('error', () => {
    image.hidden = true;
    missing.hidden = false;
  });
  let checkpoints = [];
  let selected = 0;
  let playing = null;
  let outsideFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;

  document.addEventListener('focusin', (event) => {
    if (event.composedPath().includes(host) || !(event.target instanceof HTMLElement)) return;
    outsideFocusTarget = event.target;
  }, true);

  const items = () => [...checkpoints, { id: '__live__', live: true }];
  const stop = () => {
    if (playing !== null) clearInterval(playing);
    playing = null;
    play.textContent = '▶';
    play.title = 'Play history';
    play.setAttribute('aria-label', 'Play history');
  };
  const showPeek = (entry, dot) => {
    const bounds = dot.getBoundingClientRect();
    peek.style.left = `${Math.max(8, Math.min(innerWidth - 188, bounds.left + bounds.width / 2 - 90))}px`;
    peek.hidden = false;
    peekLabel.textContent = entry.live ? 'Current working state' : `${format.format(new Date(entry.createdAt))}${entry.overlap ? ' · Overlapping activity' : ''}${entry.previewStatus === 'captured' ? '' : ' · Source only'}`;
    peekImage.hidden = entry.previewStatus !== 'captured';
    if (entry.previewStatus === 'captured') peekImage.src = entry.previewUrl;
    else peekImage.removeAttribute('src');
  };
  const hidePeek = () => { peek.hidden = true; };
  const render = () => {
    const all = items();
    selected = Math.max(0, Math.min(selected, all.length - 1));
    const point = all[selected];
    const historical = !point.live;
    review.hidden = !historical;
    if (historical) {
      time.textContent = format.format(new Date(point.createdAt));
      time.dateTime = point.createdAt;
      image.hidden = point.previewStatus !== 'captured';
      missing.hidden = point.previewStatus === 'captured';
      if (point.previewStatus === 'captured') image.src = point.previewUrl;
      else image.removeAttribute('src');
    }
    const fragment = document.createDocumentFragment();
    all.forEach((entry, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `dot${index === selected ? ' selected' : ''}${entry.live ? ' live' : ''}${entry.overlap ? ' overlap' : ''}${!entry.live && entry.previewStatus !== 'captured' ? ' source-only' : ''}`;
      dot.title = entry.live ? 'Current working state' : format.format(new Date(entry.createdAt));
      dot.setAttribute('aria-label', entry.live ? 'Current working state' : `Iteration ${index + 1}, ${dot.title}${entry.overlap ? ', overlapping activity' : ''}${entry.previewStatus === 'captured' ? '' : ', source only'}`);
      dot.setAttribute('aria-current', index === selected ? 'step' : 'false');
      dot.addEventListener('click', () => { selected = index; render(); setTimeout(hidePeek, 0); });
      dot.addEventListener('mouseenter', () => showPeek(entry, dot));
      dot.addEventListener('focus', () => showPeek(entry, dot));
      dot.addEventListener('mouseleave', hidePeek);
      dot.addEventListener('blur', hidePeek);
      fragment.append(dot);
    });
    dots.replaceChildren(fragment);
    dots.children[selected]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    previous.disabled = selected === 0;
    next.disabled = selected === all.length - 1;
    play.disabled = all.length < 2;
  };
  const refresh = async () => {
    try {
      const response = await fetch('/__rewindry/iterations', { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (!Array.isArray(result.checkpoints)) return;
      const wasLive = selected === checkpoints.length;
      const selectedId = items()[selected]?.id;
      checkpoints = result.checkpoints;
      selected = wasLive ? checkpoints.length : Math.max(0, checkpoints.findIndex((item) => item.id === selectedId));
      render();
    } catch { /* Source capture can remain available while the dev server restarts. */ }
  };
  const open = () => {
    if (!timeline.hidden) return;
    trigger.hidden = true;
    timeline.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    selected = checkpoints.length;
    void refresh();
    close.focus();
  };
  const hide = () => {
    stop();
    hidePeek();
    timeline.hidden = true;
    trigger.hidden = false;
    trigger.setAttribute('aria-expanded', 'false');
    selected = checkpoints.length;
    render();
    if (outsideFocusTarget.isConnected && !host.contains(outsideFocusTarget)) outsideFocusTarget.focus({ preventScroll: true });
  };
  trigger.addEventListener('click', open);
  close.addEventListener('click', hide);
  previous.addEventListener('click', () => { selected--; render(); });
  next.addEventListener('click', () => { selected++; render(); });
  play.addEventListener('click', () => {
    if (playing !== null) return stop();
    if (selected === items().length - 1) selected = 0;
    render();
    play.textContent = 'Ⅱ';
    play.title = 'Pause history';
    play.setAttribute('aria-label', 'Pause history');
    playing = setInterval(() => {
      if (selected === items().length - 1) return stop();
      selected++;
      render();
    }, 1400);
  });
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const isEditable = target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
    const isToggleShortcut = event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r';
    if (isToggleShortcut && !isEditable) {
      event.preventDefault();
      event.stopPropagation();
      if (timeline.hidden) open();
      else hide();
      return;
    }
    if (timeline.hidden) return;
    if (event.key === 'Escape') return hide();
    if (event.key === 'ArrowLeft') selected--;
    else if (event.key === 'ArrowRight') selected++;
    else if (event.key === 'Home') selected = 0;
    else if (event.key === 'End') selected = items().length - 1;
    else return;
    event.preventDefault();
    render();
  });
  document.documentElement.append(host);
  window.addEventListener('pointermove', (event) => {
    if (timeline.hidden && event.pointerType === 'mouse') {
      const bounds = trigger.getBoundingClientRect();
      const nearTrigger = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      trigger.classList.toggle('is-revealed', nearTrigger);
    } else {
      trigger.classList.remove('is-revealed');
    }
  });
  window.addEventListener('pointerdown', (event) => {
    if (timeline.hidden && event.pointerType !== 'mouse') {
      const bounds = trigger.getBoundingClientRect();
      const hitTrigger = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (hitTrigger) {
        event.preventDefault();
        event.stopPropagation();
        open();
      }
    }
  }, true);
  selected = checkpoints.length;
  render();
  void refresh();
  setInterval(() => { if (!timeline.hidden) void refresh(); }, 3_000);
})();
