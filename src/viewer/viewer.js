const elements = {
  status: document.getElementById('connection-status'),
  refresh: document.getElementById('refresh'),
  title: document.getElementById('point-title'),
  eyebrow: document.getElementById('point-eyebrow'),
  time: document.getElementById('point-time'),
  image: document.getElementById('visual-image'),
  liveFrame: document.getElementById('live-frame'),
  visualMessage: document.getElementById('visual-message'),
  timeline: document.getElementById('timeline'),
  position: document.getElementById('timeline-position'),
  previous: document.getElementById('previous'),
  next: document.getElementById('next'),
  play: document.getElementById('play'),
  codeToggle: document.getElementById('code-toggle'),
  codePanel: document.getElementById('code-panel'),
  codeClose: document.getElementById('code-close'),
  fileSelect: document.getElementById('file-select'),
  modeFile: document.getElementById('mode-file'),
  modeDiff: document.getElementById('mode-diff'),
  copy: document.getElementById('copy-content'),
  code: document.getElementById('code-content'),
  codeStatus: document.getElementById('code-status'),
  gitHistory: document.getElementById('git-history'),
  gitSummary: document.getElementById('git-summary'),
  gitProgress: document.getElementById('git-progress'),
  gitState: document.getElementById('git-state'),
  gitList: document.getElementById('git-list'),
};

const state = {
  checkpoints: [],
  live: { label: 'Current working state' },
  selected: 0,
  mode: 'file',
  files: [],
  content: '',
  request: 0,
  playing: null,
  renderedIndex: -1,
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : dateFormat.format(date);
}

function points() {
  return [...state.checkpoints, { id: '__live__', live: true, ...state.live }];
}

function selectedPoint() {
  return points()[state.selected];
}

function localUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin !== window.location.origin && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function stopPlayback() {
  if (state.playing !== null) window.clearInterval(state.playing);
  state.playing = null;
  elements.play.textContent = '▶';
  elements.play.title = 'Play history';
  elements.play.setAttribute('aria-label', 'Play history');
}

function setVisual(point) {
  const url = localUrl(point.live ? point.url : point.previewStatus === 'captured' ? point.previewUrl : null);
  elements.image.hidden = true;
  elements.image.removeAttribute('src');
  elements.liveFrame.hidden = true;
  elements.liveFrame.removeAttribute('src');
  elements.visualMessage.hidden = false;
  if (!url) {
    elements.visualMessage.textContent = point.live
      ? 'Live preview is unavailable.'
      : 'No visual was captured for this iteration. Historical code is available.';
    return;
  }
  elements.visualMessage.textContent = 'Loading visual…';
  if (point.live) {
    elements.visualMessage.textContent = 'Loading live preview…';
    elements.liveFrame.setAttribute('sandbox', new URL(url).origin === window.location.origin
      ? 'allow-scripts'
      : 'allow-scripts allow-same-origin');
    elements.liveFrame.onload = () => {
      elements.visualMessage.hidden = true;
      elements.liveFrame.hidden = false;
    };
    elements.liveFrame.onerror = () => {
      elements.visualMessage.textContent = 'Live preview is unavailable.';
    };
    elements.liveFrame.src = url;
    return;
  }
  elements.image.alt = point.live ? 'Current working state preview' : `Recorded preview from ${displayTime(point.createdAt)}`;
  elements.image.onload = () => {
    elements.visualMessage.hidden = true;
    elements.image.hidden = false;
  };
  elements.image.onerror = () => {
    elements.image.hidden = true;
    elements.visualMessage.hidden = false;
    elements.visualMessage.textContent = 'Visual unavailable. Historical code is still available.';
  };
  elements.image.src = url;
}

function renderTimeline(rebuild = false) {
  const items = points();
  if (rebuild || elements.timeline.children.length !== items.length) {
    const fragment = document.createDocumentFragment();
    items.forEach((point, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `point-button${point.live ? ' is-live' : ''}${point.overlap ? ' is-overlap' : ''}${!point.live && point.previewStatus !== 'captured' ? ' is-source-only' : ''}`;
      button.setAttribute('aria-label', point.live ? 'Current working state' : `Iteration ${index + 1}, ${displayTime(point.createdAt)}${point.overlap ? ', overlapping activity' : ''}${point.previewStatus === 'captured' ? '' : ', source only'}`);
      button.setAttribute('aria-current', 'false');
      button.title = point.live ? 'Current working state' : displayTime(point.createdAt);
      button.addEventListener('click', () => select(index));
      fragment.append(button);
    });
    elements.timeline.replaceChildren(fragment);
    state.renderedIndex = -1;
  }
  const previous = elements.timeline.children[state.renderedIndex];
  previous?.classList.remove('is-selected');
  previous?.setAttribute('aria-current', 'false');
  const current = elements.timeline.children[state.selected];
  current?.classList.add('is-selected');
  current?.setAttribute('aria-current', 'step');
  state.renderedIndex = state.selected;
  elements.position.textContent = `${state.selected + 1}/${items.length}`;
  elements.previous.disabled = state.selected === 0;
  elements.next.disabled = state.selected === items.length - 1;
  elements.play.disabled = items.length < 2;
  current?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function renderPoint(rebuildTimeline = false) {
  const point = selectedPoint();
  elements.eyebrow.textContent = point.live ? 'Live state' : point.overlap ? 'Overlapping activity' : 'Recorded state';
  elements.title.textContent = point.live ? point.label || 'Current working state' : `Iteration ${state.selected + 1}`;
  elements.time.textContent = point.live ? 'Live' : displayTime(point.createdAt);
  if (point.live) elements.time.removeAttribute('datetime');
  else elements.time.setAttribute('datetime', point.createdAt);
  setVisual(point);
  elements.codeToggle.hidden = point.live;
  if (point.live) closeCode();
  else if (!elements.codePanel.hidden) loadFiles();
  renderTimeline(rebuildTimeline);
}

function select(index) {
  if (index < 0 || index >= points().length) return;
  state.selected = index;
  renderPoint();
}

function togglePlayback() {
  if (state.playing !== null) {
    stopPlayback();
    return;
  }
  if (state.selected === points().length - 1) select(0);
  elements.play.textContent = 'Ⅱ';
  elements.play.title = 'Pause history';
  elements.play.setAttribute('aria-label', 'Pause history');
  state.playing = window.setInterval(() => {
    if (state.selected === points().length - 1) {
      stopPlayback();
    } else {
      select(state.selected + 1);
    }
  }, 1400);
}

function closeCode() {
  elements.codePanel.hidden = true;
  elements.codeToggle.setAttribute('aria-expanded', 'false');
  state.request += 1;
}

function openCode() {
  if (selectedPoint().live) return;
  elements.codePanel.hidden = false;
  elements.codeToggle.setAttribute('aria-expanded', 'true');
  loadFiles();
}

async function responseText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.text();
}

async function loadFiles() {
  const point = selectedPoint();
  if (point.live || elements.codePanel.hidden) return;
  const request = ++state.request;
  elements.fileSelect.disabled = true;
  elements.fileSelect.replaceChildren(new Option('Loading files'));
  elements.code.textContent = 'Loading files…';
  elements.copy.disabled = true;
  elements.codeStatus.textContent = '';
  try {
    const raw = await responseText(`/api/checkpoints/${encodeURIComponent(point.id)}/files`);
    const result = JSON.parse(raw);
    if (request !== state.request) return;
    state.files = Array.isArray(result.files) ? result.files.filter((file) => typeof file.path === 'string') : [];
    if (!state.files.length) {
      elements.fileSelect.replaceChildren(new Option('No files recorded'));
      elements.code.textContent = 'No historical files are available for this iteration.';
      return;
    }
    elements.fileSelect.replaceChildren(...state.files.map((file) => new Option(file.path, file.path)));
    elements.fileSelect.disabled = false;
    loadContent();
  } catch {
    if (request !== state.request) return;
    elements.fileSelect.replaceChildren(new Option('Files unavailable'));
    elements.code.textContent = 'Historical files could not be loaded.';
  }
}

async function loadContent() {
  const point = selectedPoint();
  const path = elements.fileSelect.value;
  if (point.live || !path) return;
  const request = ++state.request;
  const endpoint = state.mode === 'file' ? 'file' : 'diff';
  elements.code.textContent = 'Loading code…';
  elements.copy.disabled = true;
  elements.codeStatus.textContent = '';
  try {
    const text = await responseText(`/api/checkpoints/${encodeURIComponent(point.id)}/${endpoint}?path=${encodeURIComponent(path)}`);
    if (request !== state.request) return;
    state.content = text;
    elements.code.textContent = text || (state.mode === 'diff' ? 'No differences for this file.' : 'This file is empty.');
    elements.copy.disabled = false;
  } catch {
    if (request !== state.request) return;
    state.content = '';
    elements.code.textContent = 'Historical code could not be loaded.';
  }
}

function setMode(mode) {
  state.mode = mode;
  elements.modeFile.classList.toggle('is-active', mode === 'file');
  elements.modeDiff.classList.toggle('is-active', mode === 'diff');
  elements.modeFile.setAttribute('aria-pressed', String(mode === 'file'));
  elements.modeDiff.setAttribute('aria-pressed', String(mode === 'diff'));
  elements.copy.textContent = mode === 'file' ? 'Copy file' : 'Copy diff';
  loadContent();
}

async function copyContent() {
  try {
    await navigator.clipboard.writeText(state.content);
    elements.codeStatus.textContent = state.mode === 'file' ? 'File copied.' : 'Diff copied.';
  } catch {
    elements.codeStatus.textContent = 'Copy failed. Select the text to copy it manually.';
  }
}

async function refresh() {
  stopPlayback();
  const previous = selectedPoint()?.id;
  elements.status.textContent = 'Loading history';
  try {
    const raw = await responseText('/api/checkpoints');
    const result = JSON.parse(raw);
    if (!Array.isArray(result.checkpoints)) throw new Error('Invalid history');
    state.checkpoints = result.checkpoints.filter((point) => typeof point.id === 'string');
    state.live = result.live && typeof result.live === 'object' ? result.live : { label: 'Current working state' };
    const oldIndex = points().findIndex((point) => point.id === previous);
    state.selected = oldIndex >= 0 ? oldIndex : points().length - 1;
    elements.status.textContent = state.checkpoints.length ? 'History ready' : 'No recorded iterations yet';
    renderPoint(true);
    void loadGit();
  } catch {
    elements.status.textContent = 'History unavailable';
    elements.title.textContent = 'History unavailable';
    elements.time.textContent = '';
    elements.visualMessage.textContent = 'Could not load recorded iterations. Try refreshing.';
    elements.image.hidden = true;
    elements.timeline.replaceChildren();
    elements.position.textContent = '';
    elements.previous.disabled = true;
    elements.next.disabled = true;
    elements.play.disabled = true;
    elements.codeToggle.hidden = true;
    closeCode();
  }
}

async function loadGit() {
  elements.gitHistory.hidden = false;
  elements.gitSummary.textContent = 'Indexing Git history';
  elements.gitProgress.hidden = false;
  elements.gitState.textContent = '';
  elements.gitList.replaceChildren();
  try {
    const result = JSON.parse(await responseText('/api/git'));
    if (!result.available || !Array.isArray(result.commits)) {
      elements.gitHistory.hidden = true;
      elements.gitProgress.hidden = true;
      return;
    }
    elements.gitProgress.hidden = true;
    elements.gitHistory.hidden = false;
    elements.gitSummary.textContent = `Git history · ${result.commits.length}${result.truncated ? '+' : ''} commits`;
    elements.gitState.textContent = [
      result.shallow ? 'Shallow clone: older parents may be unavailable.' : '',
      result.truncated ? 'Showing the newest 2,000 reachable commits.' : '',
    ].filter(Boolean).join(' ');
    const fragment = document.createDocumentFragment();
    for (const commit of result.commits) {
      const row = document.createElement('li');
      const id = document.createElement('code');
      id.textContent = commit.id.slice(0, 8);
      id.title = commit.id;
      const subject = document.createElement('span');
      subject.textContent = commit.subject;
      const parents = document.createElement('small');
      parents.textContent = commit.parents.length
        ? `Parent${commit.parents.length === 1 ? '' : 's'} ${commit.parents.map((parent) => parent.slice(0, 8)).join(', ')}`
        : 'Root commit';
      row.append(id, subject, parents);
      fragment.append(row);
    }
    elements.gitList.replaceChildren(fragment);
  } catch {
    elements.gitProgress.hidden = true;
    elements.gitHistory.hidden = false;
    elements.gitSummary.textContent = 'Git history';
    elements.gitState.textContent = 'Git history could not be loaded.';
    elements.gitList.replaceChildren();
  }
}

elements.refresh.addEventListener('click', refresh);
elements.previous.addEventListener('click', () => select(state.selected - 1));
elements.next.addEventListener('click', () => select(state.selected + 1));
elements.play.addEventListener('click', togglePlayback);
elements.codeToggle.addEventListener('click', () => elements.codePanel.hidden ? openCode() : closeCode());
elements.codeClose.addEventListener('click', () => { closeCode(); elements.codeToggle.focus(); });
elements.fileSelect.addEventListener('change', loadContent);
elements.modeFile.addEventListener('click', () => setMode('file'));
elements.modeDiff.addEventListener('click', () => setMode('diff'));
elements.copy.addEventListener('click', copyContent);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    stopPlayback();
    if (!elements.codePanel.hidden) closeCode();
    return;
  }
  if (event.target instanceof HTMLElement && (
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || elements.codePanel.contains(event.target)
  )) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); select(state.selected - 1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); select(state.selected + 1); }
  if (event.key === 'Home') { event.preventDefault(); select(0); }
  if (event.key === 'End') { event.preventDefault(); select(points().length - 1); }
  if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); togglePlayback(); }
});

refresh();
const events = new EventSource('/api/events');
events.addEventListener('refresh', () => { void refresh(); });
events.addEventListener('unavailable', () => { elements.status.textContent = 'History temporarily unavailable'; });
