const elements = {
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  zoomComponent: document.getElementById('zoom-component'),
  zoomScreen: document.getElementById('zoom-screen'),
  componentField: document.getElementById('component-field'),
  componentSelect: document.getElementById('component-select'),
  stateSelect: document.getElementById('state-select'),
  instanceField: document.getElementById('instance-field'),
  instanceSelect: document.getElementById('instance-select'),
  profileSelect: document.getElementById('profile-select'),
  note: document.getElementById('note'),
  stageMessage: document.getElementById('stage-message'),
  stageItems: document.getElementById('stage-items'),
  filmstrip: document.getElementById('filmstrip'),
  filmstripSummary: document.getElementById('filmstrip-summary'),
};

const state = {
  summary: { states: [], components: [], profiles: [] },
  zoom: 'component',
  componentKey: '',
  stateId: '',
  occurrence: 0,
  profileId: '',
  records: [],
  items: [],
  selected: [],
  request: 0,
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const KIND_LABELS = { baseline: 'Baseline', agent_turn: 'Agent turn', unattributed_group: 'Grouped edits' };
const profileLabel = (id) => id ? id.charAt(0).toUpperCase() + id.slice(1) : 'All breakpoints';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

async function json(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function setOptions(select, options, selected) {
  select.replaceChildren(...options.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = options.some((option) => option.value === selected) ? selected : options[0]?.value ?? '';
  select.disabled = options.length < 2;
  return select.value;
}

function stateName(id) {
  const found = state.summary.states.find((item) => item.id === id);
  if (!found) return 'Unknown screen';
  return found.status === 'path_broken' ? `${found.label} (path needs a new visit)` : found.label;
}

function setZoom(zoom) {
  state.zoom = zoom;
  for (const [button, value] of [[elements.zoomComponent, 'component'], [elements.zoomScreen, 'screen']]) {
    button.classList.toggle('is-active', value === zoom);
    button.setAttribute('aria-pressed', String(value === zoom));
  }
  elements.componentField.hidden = zoom !== 'component';
  state.selected = [];
  void loadRecords();
}

function showNote(text) {
  elements.note.hidden = !text;
  elements.note.textContent = text ?? '';
}

async function loadSummary() {
  elements.status.textContent = 'Loading history';
  try {
    state.summary = await json('/api/history');
    const hasComponents = state.summary.components.length > 0;
    elements.zoomComponent.disabled = !hasComponents;
    if (!state.summary.states.length) {
      elements.status.textContent = 'No screen history yet';
      showNote('Screens appear here after the first update is captured. Open your app once with Rewindry running and keep working; capture happens in the background.');
      renderEmpty('No captured screens yet.');
      return;
    }
    showNote(hasComponents ? '' : 'Component zoom needs a React development build. Showing whole screens.');
    if (!hasComponents && state.zoom === 'component') state.zoom = 'screen';
    elements.status.textContent = 'History ready';
    setZoom(state.zoom);
  } catch {
    elements.status.textContent = 'History unavailable';
    renderEmpty('Could not load screen history. Try refreshing.');
  }
}

async function loadRecords() {
  const request = ++state.request;
  // Drop the previous selection's versions at once so nothing stale can be filtered or clicked meanwhile.
  state.records = [];
  renderEmpty('Loading versions…');
  if (state.zoom === 'component') {
    state.componentKey = setOptions(elements.componentSelect, state.summary.components.map((item) => ({
      value: item.key, label: `${item.component} · ${item.file} (${plural(item.changed, 'version')})`,
    })), state.componentKey);
    if (!state.componentKey) return renderEmpty('No components captured yet.');
    const { versions } = await json(`/api/history/components?key=${encodeURIComponent(state.componentKey)}`);
    if (request !== state.request) return;
    state.records = versions;
    // Where a component appears on several screens, default to the one where it changed in the most iterations.
    // Counted per instance and breakpoint, in iterations rather than rows, so a page that draws many copies
    // (a catalog) does not outrank real history. On a tie, prefer a screen that draws the component fewer times, then more captures.
    const screens = new Map();
    for (const version of versions) {
      const screen = screens.get(version.stateId) ?? { changed: new Map(), occurrences: new Set(), iterations: new Set() };
      screens.set(version.stateId, screen);
      screen.occurrences.add(version.occurrence);
      screen.iterations.add(version.checkpointId);
      if (version.unchangedFrom) continue;
      const series = `${version.occurrence}:${version.profileId}`;
      screen.changed.set(series, (screen.changed.get(series) ?? new Set()).add(version.checkpointId));
    }
    const score = (stateId) => {
      const screen = screens.get(stateId);
      return [Math.max(0, ...[...screen.changed.values()].map((changed) => changed.size)), -screen.occurrences.size, screen.iterations.size];
    };
    const states = [...screens.keys()].sort((a, b) => {
      const [left, right] = [score(a), score(b)];
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    });
    state.stateId = setOptions(elements.stateSelect, states.map((id) => ({ value: id, label: stateName(id) })),
      states.includes(state.stateId) ? state.stateId : states[0]);
  } else {
    state.stateId = setOptions(elements.stateSelect, state.summary.states.map((item) => ({
      value: item.id, label: `${stateName(item.id)} (${plural(item.changed, 'version')})`,
    })), state.stateId);
    const { frames } = await json(`/api/history/frames?state=${encodeURIComponent(state.stateId)}`);
    if (request !== state.request) return;
    state.records = frames;
  }
  updateInstances();
  updateProfiles();
  render();
}

// A component rendered more than once on a screen (list items, board cells) is followed one instance at a time,
// in page order, so its versions are one copy's history rather than every copy at the same iteration.
function updateInstances() {
  const occurrences = state.zoom === 'component'
    ? [...new Set(state.records.filter((record) => record.stateId === state.stateId).map((record) => record.occurrence))].sort((a, b) => a - b)
    : [];
  const selected = setOptions(elements.instanceSelect, occurrences.map((occurrence) => ({
    value: String(occurrence), label: `${occurrence + 1} of ${occurrences.length}`,
  })), String(state.occurrence));
  state.occurrence = Number(selected || 0);
  elements.instanceField.hidden = occurrences.length < 2;
}

// Breakpoints offered are the ones this screen (and component) actually has.
function updateProfiles() {
  const profiles = [...new Set(state.records.filter((record) => record.stateId === undefined || record.stateId === state.stateId).map((record) => record.profileId))];
  state.profileId = setOptions(elements.profileSelect, [{ value: '', label: 'All breakpoints' },
    ...state.summary.profiles.filter((id) => profiles.includes(id)).map((id) => ({ value: id, label: profileLabel(id) }))], state.profileId);
  elements.profileSelect.disabled = profiles.length < 2;
}

function render() {
  const inScope = state.records.filter((record) =>
    (state.zoom === 'screen' || (record.stateId === state.stateId && record.occurrence === state.occurrence)) &&
    (!state.profileId || record.profileId === state.profileId));
  const changed = inScope.filter((record) => record.imageUrl && !record.unchangedFrom);
  const unchanged = inScope.filter((record) => record.unchangedFrom).length;
  const broken = inScope.filter((record) => record.status === 'path_broken').length;
  const failed = inScope.filter((record) => record.status === 'failed').length;
  const skipped = inScope.filter((record) => record.status === 'skipped').length;
  state.items = changed.map((record) => ({ ...record, id: `${record.checkpointId}:${record.profileId}` }));
  const parts = [plural(state.items.length, 'version')];
  if (unchanged) parts.push(`${unchanged} unchanged ${unchanged === 1 ? 'update' : 'updates'} hidden`);
  if (broken) parts.push(`${broken} could not be reached`);
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  elements.filmstripSummary.textContent = parts.join(' · ');
  if (!state.items.length) return renderEmpty('No captured versions for this selection.');
  state.selected = state.selected.filter((id) => state.items.some((item) => item.id === id));
  if (!state.selected.length) state.selected = [state.items.at(-1).id];
  renderFilmstrip();
  renderStage();
}

function renderEmpty(message) {
  state.items = [];
  elements.filmstrip.replaceChildren();
  elements.stageItems.hidden = true;
  elements.stageItems.replaceChildren();
  elements.stageMessage.hidden = false;
  elements.stageMessage.textContent = message;
  if (!message.startsWith('No captured versions')) elements.filmstripSummary.textContent = '';
}

function caption(item) {
  const replayed = item.captureMode === 'replayed' ? ' · Replayed from saved source' : '';
  return `${profileLabel(item.profileId)} · ${dateFormat.format(new Date(item.createdAt))} · ${KIND_LABELS[item.kind] ?? 'Update'}${replayed}`;
}

function renderFilmstrip() {
  elements.filmstrip.replaceChildren(...state.items.map((item) => {
    const entry = document.createElement('li');
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'frame';
    card.dataset.id = item.id;
    const active = state.selected.includes(item.id);
    card.classList.toggle('is-selected', active);
    card.setAttribute('aria-pressed', String(active));
    const image = document.createElement('img');
    image.src = item.imageUrl;
    image.alt = '';
    image.loading = 'lazy';
    const title = document.createElement('span');
    title.textContent = `Iteration ${item.iteration}`;
    const meta = document.createElement('small');
    meta.textContent = caption(item);
    card.append(image, title, meta);
    card.addEventListener('click', () => select(item.id));
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = state.items.findIndex((candidate) => candidate.id === item.id) + (event.key === 'ArrowRight' ? 1 : -1);
      const next = state.items[index];
      if (next) {
        select(next.id);
        elements.filmstrip.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
      }
    });
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'compare-toggle';
    const comparing = state.selected.length === 2 && active;
    compare.textContent = comparing ? 'Comparing' : 'Compare';
    compare.setAttribute('aria-pressed', String(comparing));
    compare.setAttribute('aria-label', `Compare iteration ${item.iteration}, ${profileLabel(item.profileId)}`);
    compare.addEventListener('click', () => toggleCompare(item.id));
    entry.append(card, compare);
    return entry;
  }));
  elements.filmstrip.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function select(id) {
  state.selected = [id];
  renderFilmstrip();
  renderStage();
}

// Compare keeps at most two versions; adding a third replaces the older choice.
function toggleCompare(id) {
  if (state.selected.includes(id)) {
    if (state.selected.length > 1) state.selected = state.selected.filter((item) => item !== id);
  } else {
    state.selected = [...state.selected, id].slice(-2);
  }
  state.selected.sort((a, b) => state.items.findIndex((item) => item.id === a) - state.items.findIndex((item) => item.id === b));
  renderFilmstrip();
  renderStage();
}

function renderStage() {
  const items = state.selected.map((id) => state.items.find((item) => item.id === id)).filter(Boolean);
  elements.stageMessage.hidden = true;
  elements.stageItems.hidden = false;
  elements.stageItems.classList.toggle('is-compare', items.length === 2);
  elements.stageItems.replaceChildren(...items.map((item) => {
    const figure = document.createElement('figure');
    const frame = document.createElement('div');
    frame.className = 'stage-image';
    const image = document.createElement('img');
    image.src = item.imageUrl;
    image.alt = `Iteration ${item.iteration}, ${profileLabel(item.profileId)}`;
    frame.append(image);
    const figcaption = document.createElement('figcaption');
    const title = document.createElement('strong');
    title.textContent = `Iteration ${item.iteration}`;
    const meta = document.createElement('span');
    meta.textContent = caption(item);
    const code = document.createElement('a');
    code.href = `/#checkpoint=${encodeURIComponent(item.checkpointId)}`;
    code.textContent = 'Code at this iteration';
    figcaption.append(title, meta, code);
    if (item.captureMode === 'replayed') {
      const note = document.createElement('p');
      note.className = 'replay-note';
      note.textContent = 'Rendered later from this iteration\u2019s saved files. Omitted dependencies, environment, data and browser state can change pixels.';
      figcaption.append(note);
    }
    figure.append(frame, figcaption);
    return figure;
  }));
}

elements.zoomComponent.addEventListener('click', () => setZoom('component'));
elements.zoomScreen.addEventListener('click', () => setZoom('screen'));
elements.componentSelect.addEventListener('change', () => {
  state.componentKey = elements.componentSelect.value;
  state.occurrence = 0;
  state.selected = [];
  void loadRecords();
});
elements.stateSelect.addEventListener('change', () => {
  state.stateId = elements.stateSelect.value;
  state.occurrence = 0;
  state.selected = [];
  if (state.zoom === 'screen') return void loadRecords();
  updateInstances();
  updateProfiles();
  render();
});
elements.instanceSelect.addEventListener('change', () => {
  state.occurrence = Number(elements.instanceSelect.value);
  state.selected = [];
  render();
});
elements.profileSelect.addEventListener('change', () => {
  state.profileId = elements.profileSelect.value;
  state.selected = [];
  render();
});
elements.refresh.addEventListener('click', () => void loadSummary());

try {
  const events = new EventSource('/api/events');
  events.addEventListener('refresh', () => void loadSummary());
} catch { /* Manual refresh still works. */ }

void loadSummary();
