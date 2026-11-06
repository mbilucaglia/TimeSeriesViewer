(function (global) {
const { computeAverage, getConditions, getMetrics, getOutlierFlags, getSeries, readSignalFile } = global.TimeSeriesData;
const { createPlot } = global.TimeSeriesPlot;

const elements = Object.fromEntries([
  'signalFiles', 'videoFile', 'video', 'errors', 'subjectsTable', 'metricSelect', 'conditionSelect',
  'conditionControl', 'conditionLabel', 'outlierMethodSelect', 'showIndividuals', 'showAverage', 'selectAllBtn', 'selectNoneBtn',
  'downloadAverageBtn', 'metaSubjects', 'metaMetrics', 'metaSelected', 'timeLabel', 'emptySubjects',
  'loadingOverlay', 'loadingDialog', 'loadingMessage'
].map(id => [id, document.getElementById(id)]));

const state = {
  subjects: [],
  metrics: [],
  conditions: [],
  selectedMetric: '',
  selectedCondition: '',
  currentTime: 0,
  videoUrl: null,
  showIndividuals: true,
  showAverage: true,
  outlierFlags: new Map(),
  outlierMethod: 'iqr',
  highlightedSubjectId: null
};

let renderQueue = Promise.resolve();
let videoFrame = null;
let focusBeforeLoading = null;

const selectedSubjects = () => state.subjects.filter(subject => subject.selected);
const maxSignalTime = () => selectedSubjects().reduce((maximum, subject) => {
  const series = getSeries(subject, state.selectedMetric, state.selectedCondition);
  return series.length ? Math.max(maximum, series.at(-1).time) : maximum;
}, 0);

const plot = createPlot({
  element: document.getElementById('plot'),
  getState: () => state,
  getSubjects: () => state.subjects,
  getSelectedSubjects: selectedSubjects,
  getMaxPlayableTime: () => Math.max(maxSignalTime(), Number.isFinite(elements.video.duration) ? elements.video.duration : 0),
  setCurrentTime
});

function showMessage(message = '') {
  elements.errors.textContent = message;
}

function renderPlot() {
  renderQueue = renderQueue
    .then(() => plot.render())
    .catch(error => showMessage(`Impossibile aggiornare il grafico: ${error.message}`));
  return renderQueue;
}

function clearHighlightedSubject() {
  if (!state.highlightedSubjectId) return;
  state.highlightedSubjectId = null;
  refreshIsolationButtons();
  void renderPlot();
}

function refreshIsolationButtons() {
  for (const button of elements.subjectsTable.querySelectorAll('[data-action="isolate"]')) {
    const subject = state.subjects.find(item => item.id === button.dataset.id);
    const isActive = state.highlightedSubjectId === button.dataset.id;
    button.setAttribute('aria-pressed', String(isActive));
    button.title = subject?.selected
      ? `${isActive ? 'Ripristina' : 'Isola'} la curva di ${subject.subjectId}`
      : 'Seleziona il soggetto per isolare la curva';
  }
}

function setCurrentTime(nextTime, syncVideo = true) {
  const upperBound = Math.max(maxSignalTime(), Number.isFinite(elements.video.duration) ? elements.video.duration : 0);
  const numericTime = Number(nextTime);
  const time = Number.isFinite(numericTime)
    ? upperBound > 0 ? Math.max(0, Math.min(numericTime, upperBound)) : Math.max(0, numericTime)
    : 0;

  state.currentTime = time;
  elements.timeLabel.textContent = `${time.toFixed(2)} s`;

  if (syncVideo && elements.video.currentSrc) {
    const videoTime = Number.isFinite(elements.video.duration)
      ? Math.min(time, elements.video.duration)
      : time;
    if (Math.abs(elements.video.currentTime - videoTime) > 0.002) elements.video.currentTime = videoTime;
  }

  plot.updateCursor();
}

function refreshSelectors() {
  const previousMetric = state.selectedMetric;
  state.metrics = getMetrics(state.subjects);
  state.selectedMetric = state.metrics.includes(previousMetric) ? previousMetric : state.metrics[0] || '';
  replaceOptions(elements.metricSelect, state.metrics, state.selectedMetric);

  state.conditions = getConditions(state.subjects, state.selectedMetric);
  const previousCondition = state.selectedCondition;
  state.selectedCondition = state.conditions.includes(previousCondition)
    ? previousCondition
    : state.conditions[0] || '';
  replaceOptions(elements.conditionSelect, state.conditions, state.selectedCondition);

  const hasConditions = state.conditions.some(condition => condition !== '');
  elements.conditionControl.hidden = !hasConditions;
  elements.conditionLabel.hidden = !hasConditions;
  state.outlierFlags = getOutlierFlags(state.subjects, state.selectedMetric, state.selectedCondition, state.outlierMethod);
}

function replaceOptions(select, options, selectedValue) {
  const fragment = document.createDocumentFragment();

  for (const optionValue of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue || 'Serie principale';
    option.selected = optionValue === selectedValue;
    fragment.append(option);
  }

  select.replaceChildren(fragment);
  select.disabled = options.length === 0;
}

function refreshMetadata() {
  elements.metaSubjects.textContent = `Soggetti: ${state.subjects.length}`;
  elements.metaMetrics.textContent = `Metriche: ${state.metrics.length}`;
  elements.metaSelected.textContent = `Selezionati: ${selectedSubjects().length}`;
  elements.selectAllBtn.disabled = state.subjects.length === 0;
  elements.selectNoneBtn.disabled = state.subjects.length === 0;
  elements.downloadAverageBtn.disabled = !selectedSubjects().length || !state.selectedMetric;
}

function renderSubjectTable() {
  const body = elements.subjectsTable.tBodies[0];
  const fragment = document.createDocumentFragment();

  for (const subject of state.subjects) {
    const row = document.createElement('tr');
    row.dataset.subjectId = subject.id;
    const selectionCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = subject.selected;
    checkbox.dataset.action = 'toggle';
    checkbox.dataset.id = subject.id;
    checkbox.setAttribute('aria-label', `Seleziona ${subject.subjectId}`);
    selectionCell.append(checkbox);

    const nameCell = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = subject.subjectId;
    nameInput.dataset.action = 'rename';
    nameInput.dataset.id = subject.id;
    nameInput.setAttribute('aria-label', `Nome soggetto ${subject.subjectId}`);
    const nameWrap = document.createElement('div');
    nameWrap.className = 'subject-name-wrap';
    const isolateButton = document.createElement('button');
    isolateButton.type = 'button';
    isolateButton.className = 'trace-isolate-button';
    isolateButton.textContent = '◎';
    isolateButton.title = subject.selected
      ? `Isola la curva di ${subject.subjectId}`
      : 'Seleziona il soggetto per isolare la curva';
    isolateButton.setAttribute('aria-label', `Isola traccia ${subject.subjectId}`);
    isolateButton.setAttribute('aria-pressed', String(state.highlightedSubjectId === subject.id));
    isolateButton.disabled = !subject.selected;
    isolateButton.dataset.action = 'isolate';
    isolateButton.dataset.id = subject.id;
    nameWrap.append(nameInput, isolateButton);
    nameCell.append(nameWrap);

    const pointsCell = document.createElement('td');
    pointsCell.textContent = String(subject.points);

    const outlierCell = document.createElement('td');
    const outlierFlag = state.outlierFlags.get(subject.id);
    const outlierBadge = document.createElement('span');
    outlierBadge.className = `outlier-badge outlier-${outlierFlag?.status || 'insufficient'}`;
    outlierBadge.textContent = outlierFlag?.status === 'flagged'
      ? 'Possibile'
      : outlierFlag?.status === 'within' ? 'No' : outlierFlag?.status === 'disabled' ? 'Off' : 'N/D';
    outlierBadge.title = describeOutlierFlag(outlierFlag, state.outlierMethod);
    outlierCell.append(outlierBadge);

    const removeCell = document.createElement('td');
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = 'Rimuovi soggetto';
    removeButton.setAttribute('aria-label', `Rimuovi ${subject.subjectId}`);
    removeButton.dataset.action = 'remove';
    removeButton.dataset.id = subject.id;
    removeCell.append(removeButton);

    row.append(selectionCell, nameCell, pointsCell, outlierCell, removeCell);
    fragment.append(row);
  }

  body.replaceChildren(fragment);
  elements.emptySubjects.hidden = state.subjects.length > 0;
  refreshMetadata();
}

function describeOutlierFlag(flag, method) {
  if (flag?.status === 'disabled') return 'Rilevamento automatico disattivato. La selezione dei soggetti resta manuale.';
  if (!flag || flag.status === 'insufficient') {
    return 'Non valutabile: servono almeno 3 istanti confrontabili con almeno 5 soggetti.';
  }
  const methodName = method === 'mad' ? 'z-score robusto > 3,5' : 'limiti di 1,5 × IQR';
  if (flag.status === 'flagged') {
    return `Possibile outlier (${methodName}): ${flag.deviating} di ${flag.tested} istanti oltre la soglia (${(flag.fraction * 100).toFixed(1)}%). Non viene escluso automaticamente.`;
  }
  return `Nessuna segnalazione (${methodName}): ${flag.deviating} di ${flag.tested} istanti oltre la soglia. Il soggetto resta incluso se selezionato.`;
}

function refreshApp({ renderTable = true } = {}) {
  refreshSelectors();
  if (renderTable) renderSubjectTable();
  else refreshMetadata();
  setCurrentTime(state.currentTime, false);
  return renderPlot();
}

function exportAverage() {
  const selected = selectedSubjects();
  if (!selected.length || !state.selectedMetric) {
    showMessage('Seleziona almeno un soggetto e una metrica prima di esportare.');
    return;
  }

  const average = computeAverage(selected, state.selectedMetric, state.selectedCondition);
  if (!average.length) {
    showMessage('I soggetti selezionati non condividono tempi coincidenti per la serie scelta.');
    return;
  }

  const rows = [
    ['time_s', `mean_${state.selectedMetric}`],
    ...average.map(point => [point.time, point.value])
  ];
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `media_${safeFilename(state.selectedMetric)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  showMessage('');
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeFilename(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'segnali';
}

async function handleSignalFile(file) {
  showMessage('');
  setLoading(true, 'Apertura del file…');

  try {
    await yieldToBrowser();
    const dataset = await readSignalFile(file, message => setLoading(true, message));
    state.subjects = dataset.subjects;
    state.metrics = [];
    state.conditions = [];
    state.selectedMetric = '';
    state.selectedCondition = '';
    state.currentTime = 0;
    setLoading(true, 'Aggiornamento del grafico…');
    await yieldToBrowser();
    await refreshApp();

    if (dataset.skippedSheets?.length) {
      showMessage(`Importati i dati validi; ignorati ${dataset.skippedSheets.length} fogli senza una colonna tempo riconoscibile.`);
    }
  } catch (error) {
    showMessage(`${file.name}: ${error.message}`);
  } finally {
    elements.signalFiles.value = '';
    setLoading(false);
  }
}

function setLoading(visible, message = '') {
  if (visible && elements.loadingOverlay.hidden) {
    focusBeforeLoading = document.activeElement;
    document.querySelector('.wrap').inert = true;
  }

  elements.loadingOverlay.hidden = !visible;
  elements.loadingMessage.textContent = message;
  document.body.setAttribute('aria-busy', String(visible));

  if (visible) elements.loadingDialog.focus();
  else {
    document.querySelector('.wrap').inert = false;
    focusBeforeLoading?.focus?.();
    focusBeforeLoading = null;
  }
}

function yieldToBrowser() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function handleVideoFile(file) {
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  elements.video.src = state.videoUrl;
  elements.video.load();
  showMessage('');
}

function startVideoSync() {
  if (videoFrame !== null) return;

  const frame = () => {
    setCurrentTime(elements.video.currentTime || 0, false);
    videoFrame = !elements.video.paused && !elements.video.ended
      ? requestAnimationFrame(frame)
      : null;
  };

  videoFrame = requestAnimationFrame(frame);
}

function stopVideoSync() {
  if (videoFrame !== null) cancelAnimationFrame(videoFrame);
  videoFrame = null;
}

elements.signalFiles.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) void handleSignalFile(file);
});

elements.videoFile.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) handleVideoFile(file);
  elements.videoFile.value = '';
});

elements.metricSelect.addEventListener('change', () => {
  state.selectedMetric = elements.metricSelect.value;
  state.selectedCondition = '';
  void refreshApp();
});

elements.conditionSelect.addEventListener('change', () => {
  state.selectedCondition = elements.conditionSelect.value;
  void refreshApp();
});

elements.outlierMethodSelect.addEventListener('change', () => {
  state.outlierMethod = elements.outlierMethodSelect.value;
  state.outlierFlags = getOutlierFlags(state.subjects, state.selectedMetric, state.selectedCondition, state.outlierMethod);
  renderSubjectTable();
});

elements.showIndividuals.addEventListener('change', () => {
  state.showIndividuals = elements.showIndividuals.checked;
  void renderPlot();
});

elements.showAverage.addEventListener('change', () => {
  state.showAverage = elements.showAverage.checked;
  void renderPlot();
});

elements.selectAllBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => { subject.selected = true; });
  renderSubjectTable();
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});

elements.selectNoneBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => { subject.selected = false; });
  renderSubjectTable();
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});

elements.downloadAverageBtn.addEventListener('click', exportAverage);

elements.subjectsTable.tBodies[0].addEventListener('input', event => {
  const control = event.target.closest('[data-action="rename"]');
  if (!control) return;

  const subject = state.subjects.find(item => item.id === control.dataset.id);
  if (!subject) return;
  subject.subjectId = control.value.trim() || 'Soggetto';
  void renderPlot();
});

elements.subjectsTable.tBodies[0].addEventListener('change', event => {
  const control = event.target.closest('[data-action="toggle"]');
  if (!control) return;

  const subject = state.subjects.find(item => item.id === control.dataset.id);
  if (!subject) return;
  subject.selected = control.checked;
  if (!subject.selected && state.highlightedSubjectId === subject.id) state.highlightedSubjectId = null;
  renderSubjectTable();
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});

elements.subjectsTable.tBodies[0].addEventListener('click', event => {
  const isolateControl = event.target.closest('[data-action="isolate"]');
  if (isolateControl) {
    const subject = state.subjects.find(item => item.id === isolateControl.dataset.id);
    if (!subject?.selected) return;
    state.highlightedSubjectId = state.highlightedSubjectId === subject.id ? null : subject.id;
    refreshIsolationButtons();
    void renderPlot();
    return;
  }

  const control = event.target.closest('[data-action="remove"]');
  if (control) {
    clearHighlightedSubject();
    state.subjects = state.subjects.filter(item => item.id !== control.dataset.id);
    void refreshApp();
    return;
  }

  clearHighlightedSubject();
});

document.addEventListener('click', event => {
  if (event.composedPath().includes(elements.subjectsTable.tBodies[0])) return;
  clearHighlightedSubject();
});

elements.video.addEventListener('loadedmetadata', () => {
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});
elements.video.addEventListener('timeupdate', () => setCurrentTime(elements.video.currentTime || 0, false));
elements.video.addEventListener('seeked', () => setCurrentTime(elements.video.currentTime || 0, false));
elements.video.addEventListener('play', startVideoSync);
elements.video.addEventListener('pause', () => {
  stopVideoSync();
  setCurrentTime(elements.video.currentTime || 0, false);
});
elements.video.addEventListener('ended', () => {
  stopVideoSync();
  setCurrentTime(elements.video.currentTime || 0, false);
});

window.addEventListener('pagehide', () => {
  stopVideoSync();
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
});

refreshApp();
})(globalThis);
