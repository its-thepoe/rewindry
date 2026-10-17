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
    <button class="trigger" type="button" title="Open Rewindry timeline" aria-label="Open Rewindry timeline" aria-expanded="false">●</button>
    <section class="review" hidden aria-label="Recorded visual">
      <div class="capture-controls" hidden>
        <label>Screen/component<select class="target-select" aria-label="Screen or component"></select></label>
        <label>Viewport<select class="viewport-select" aria-label="Viewport"></select></label>
      </div>
      <div class="visual"><img alt="" hidden><p class="missing" hidden>No visual was captured for this iteration.</p></div>
      <time class="time"></time>
    </section>
    <nav class="timeline" hidden aria-label="Rewindry iteration timeline">
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
  const captureControls = root.querySelector('.capture-controls');
  const targetSelect = root.querySelector('.target-select');
  const viewportSelect = root.querySelector('.viewport-select');
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
  let selectedTargetId = null;
  let selectedViewportId = null;

  const targetOptions = () => {
    const seen = new Set();
    return checkpoints.flatMap((point) => Array.isArray(point.targets) ? point.targets : []).filter((target) => {
      if (typeof target.targetId !== 'string' || seen.has(target.targetId)) return false;
      seen.add(target.targetId);
      return true;
    });
  };
  const viewportOptions = (targetId) => {
    const seen = new Set();
    return checkpoints.flatMap((point) => Array.isArray(point.targets) ? point.targets : [])
      .filter((target) => target.targetId === targetId && typeof target.viewportId === 'string')
      .filter((target) => {
        if (seen.has(target.viewportId)) return false;
        seen.add(target.viewportId);
        return true;
      });
  };
  const updateOptions = (select, options, valueKey, labelKey, value) => {
    const current = [...select.options].map((option) => [option.value, option.textContent]);
    const next = options.map((option) => [option[valueKey], option[labelKey]]);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      select.replaceChildren(...options.map((option) => new Option(option[labelKey], option[valueKey])));
    }
    select.value = value ?? '';
    select.disabled = options.length < 2;
  };
  const selectedVisual = (point) => {
    if (!Array.isArray(point.targets)) return point.previewStatus === 'captured' ? { imageUrl: point.previewUrl, targetLabel: 'Recorded page' } : null;
    return point.targets.find((target) => target.targetId === selectedTargetId && target.viewportId === selectedViewportId) ?? null;
  };
  const updateCaptureControls = (point) => {
    const targets = targetOptions();
    captureControls.hidden = point.live || targets.length === 0;
    if (point.live || !targets.length) return;
    if (!targets.some((target) => target.targetId === selectedTargetId)) selectedTargetId = targets[0].targetId;
    const viewports = viewportOptions(selectedTargetId);
    if (!viewports.some((viewport) => viewport.viewportId === selectedViewportId)) selectedViewportId = viewports[0]?.viewportId ?? null;
    const uniqueTargets = targets.filter((target, index) => targets.findIndex((item) => item.targetId === target.targetId) === index);
    updateOptions(targetSelect, uniqueTargets, 'targetId', 'targetLabel', selectedTargetId);
    updateOptions(viewportSelect, viewports, 'viewportId', 'viewportLabel', selectedViewportId);
  };

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
    const capture = selectedVisual(entry);
    const imageUrl = capture?.status === 'captured' ? capture.imageUrl : capture?.imageUrl;
    peekImage.hidden = !imageUrl;
    if (imageUrl) peekImage.src = imageUrl;
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
      updateCaptureControls(point);
      const capture = selectedVisual(point);
      const imageUrl = capture?.status === 'captured' ? capture.imageUrl : capture?.imageUrl;
      image.hidden = !imageUrl;
      missing.hidden = Boolean(imageUrl);
      if (imageUrl) image.src = imageUrl;
      else image.removeAttribute('src');
      if (!imageUrl && Array.isArray(point.targets)) {
        missing.textContent = `${capture?.targetLabel ?? 'Selected screen/component'} · ${capture?.viewportLabel ?? 'Selected viewport'} ${capture?.status === 'captured' ? 'is unavailable' : 'was not captured'}${capture?.reason ? ` (${capture.reason})` : ''} for this iteration.`;
      } else {
        missing.textContent = 'No visual was captured for this iteration.';
      }
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
  const hide = () => {
    stop();
    hidePeek();
    timeline.hidden = true;
    trigger.hidden = false;
    trigger.setAttribute('aria-expanded', 'false');
    selected = checkpoints.length;
    render();
    trigger.focus();
  };
  trigger.addEventListener('click', () => {
    trigger.hidden = true;
    timeline.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    selected = checkpoints.length;
    void refresh();
    close.focus();
  });
  close.addEventListener('click', hide);
  targetSelect.addEventListener('change', () => {
    selectedTargetId = targetSelect.value;
    selectedViewportId = null;
    render();
  });
  viewportSelect.addEventListener('change', () => {
    selectedViewportId = viewportSelect.value;
    render();
  });
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
  selected = checkpoints.length;
  render();
  void refresh();
  setInterval(() => { if (!timeline.hidden) void refresh(); }, 3_000);
})();
