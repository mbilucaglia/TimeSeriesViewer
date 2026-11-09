(function (global) {
const { computeAverage, getConditions, getMetrics, getOutlierFlags, getSeries, readSignalFile } = global.TimeSeriesData;
const { createPlot } = global.TimeSeriesPlot;
const { run: runPermutationTest } = global.TimeSeriesPermutation;

const elements = Object.fromEntries([
  'signalFiles', 'video', 'errors', 'subjectsTable', 'metricSelect', 'conditionSelect',
  'conditionControl', 'conditionLabel', 'outlierMethodSelect', 'showIndividuals', 'showAverage', 'selectAllBtn', 'selectNoneBtn',
  'downloadAverageBtn', 'metaSubjects', 'metaMetrics', 'metaSelected', 'timeLabel', 'analysisTimeLabel', 'emptySubjects', 'plotPlaceholder',
  'loadingOverlay', 'loadingDialog', 'loadingMessage', 'viewerTab', 'analysisTab', 'viewerPanel', 'analysisPanel',
  'analysisTargets', 'nullValueControl', 'nullValue', 'permutationCount', 'groupAssignments', 'groupChips',
  'groupAssignmentRows', 'addGroupBtn', 'runAnalysisBtn', 'downloadAnalysisBtn', 'analysisStatus', 'analysisResults', 'analysisChart', 'significantOnly',
  'viewerVideoDockSlot', 'viewerSidebar', 'analysisSidebar', 'videoStimulusAssignments', 'stimulusVideoCard', 'stimulusVideoContent', 'toggleStimulusVideoBtn', 'activeStimulusVideoLabel', 'videoPlaceholderMessage', 'videoControls', 'videoSeek', 'videoPlayBtn', 'videoPlayIconPath',
  'signalDropZone', 'loadDemoBtn', 'dropStatus'
].map(id => [id, document.getElementById(id)]));

const state = {
  subjects: [],
  metrics: [],
  conditions: [],
  selectedMetric: '',
  selectedCondition: '',
  currentTime: 0,
  stimulusVideoExpanded: true,
  videoUrl: null,
  videoUrlsByStimulus: new Map(),
  showIndividuals: true,
  showAverage: true,
  outlierFlags: new Map(),
  outlierMethod: 'iqr',
  highlightedSubjectId: null,
  analysisGroups: [{ id: 'group-1', name: 'Gruppo 1' }, { id: 'group-2', name: 'Gruppo 2' }],
  subjectGroups: new Map(),
  analysisResults: []
};

let renderQueue = Promise.resolve();
let videoFrame = null;
let focusBeforeLoading = null;
let plotlyLoadPromise = null;
let analysisCursorRelayoutInFlight = false;
let analysisCursorUpdatePending = false;
let analysisCursorRelayoutAt = 0;
let analysisCursorTimer = null;

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
    .then(async () => {
      const hasChartContent = state.subjects.length > 0 || Boolean(state.videoUrl);
      if (!hasChartContent) {
        elements.plotPlaceholder.textContent = 'Carica un file di segnali per visualizzare il grafico.';
        elements.plotPlaceholder.hidden = false;
        showMessage('');
        return;
      }

      elements.plotPlaceholder.textContent = 'Caricamento del grafico…';
      elements.plotPlaceholder.hidden = false;
      await loadPlotly();
      await plot.render();
      elements.plotPlaceholder.hidden = true;
    })
    .catch(error => {
      elements.plotPlaceholder.textContent = 'Grafico non disponibile. Controlla la connessione e riprova.';
      elements.plotPlaceholder.hidden = false;
      showMessage(`Impossibile aggiornare il grafico: ${error.message}`);
    });
  return renderQueue;
}

function loadPlotly() {
  const isPlotlyAvailable = () => typeof globalThis.Plotly?.newPlot === 'function'
    && typeof globalThis.Plotly?.react === 'function';
  if (isPlotlyAvailable()) return Promise.resolve(globalThis.Plotly);
  if (plotlyLoadPromise) return plotlyLoadPromise;

  const sources = [
    'https://cdn.plot.ly/plotly-2.35.2.min.js',
    'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js'
  ];

  plotlyLoadPromise = new Promise((resolve, reject) => {
    let sourceIndex = 0;

    const loadNextSource = () => {
      if (sourceIndex >= sources.length) {
        plotlyLoadPromise = null;
        reject(new Error('Non è stato possibile caricare la libreria Plotly.'));
        return;
      }

      const script = document.createElement('script');
      script.src = sources[sourceIndex++];
      script.async = true;
      let completed = false;
      const timeout = setTimeout(() => {
        if (completed) return;
        completed = true;
        script.remove();
        loadNextSource();
      }, 10000);

      script.onload = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (isPlotlyAvailable()) resolve(globalThis.Plotly);
        else loadNextSource();
      };
      script.onerror = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        loadNextSource();
      };

      document.head.append(script);
    };

    loadNextSource();
  });

  return plotlyLoadPromise;
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
  elements.timeLabel.textContent = time.toFixed(2);
  elements.analysisTimeLabel.textContent = time.toFixed(2);
  if (Number.isFinite(elements.video.duration) && elements.video.duration > 0) {
    elements.videoSeek.value = String(Math.min(1000, Math.round(elements.video.currentTime / elements.video.duration * 1000)));
  }

  if (syncVideo && elements.video.currentSrc) {
    const videoTime = Number.isFinite(elements.video.duration)
      ? Math.min(time, elements.video.duration)
      : time;
    if (Math.abs(elements.video.currentTime - videoTime) > 0.002) elements.video.currentTime = videoTime;
  }

  plot.updateCursor();
  updateAnalysisCursor();
}

function updateVideoPlayButton() {
  const isPlaying = !elements.video.paused && !elements.video.ended;
  const label = isPlaying ? 'Pausa video' : 'Riproduci video';
  elements.videoPlayIconPath.setAttribute('d', isPlaying
    ? 'M6 5h4v14H6zM14 5h4v14h-4z'
    : 'M8 5v14l11-7z');
  elements.videoPlayBtn.setAttribute('aria-label', label);
  elements.videoPlayBtn.title = label;
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
  refreshAnalysisTargets();
  refreshGroupAssignments();
  refreshVideoAssignments();
  refreshActiveVideo();
}

function getAnalysisTargets() {
  if (!state.selectedMetric || !state.metrics.includes(state.selectedMetric)) return [];
  const condition = state.selectedCondition;
  return selectedSubjects().some(subject => getSeries(subject, state.selectedMetric, condition).length)
    ? [{ metric: state.selectedMetric, condition }]
    : [];
}

function refreshAnalysisTargets() {
  const targets = getAnalysisTargets();
  const target = targets[0];
  if (state.analysisResults.length && (state.analysisResults[0].metric !== state.selectedMetric || state.analysisResults[0].condition !== state.selectedCondition)) {
    invalidateAnalysisResults();
  }
  elements.analysisTargets.textContent = target
    ? `${target.metric} · ${target.condition || 'Serie principale'}`
    : !state.subjects.length
      ? 'Carica i dati e seleziona una metrica e uno stimolo nel Viewer.'
      : !state.selectedMetric
        ? 'Seleziona una metrica e uno stimolo nel Viewer.'
        : 'I soggetti selezionati non hanno dati per la combinazione corrente.';
  elements.analysisTargets.classList.toggle('is-empty', !target);
  updateAnalysisAvailability();
}

function refreshGroupAssignments() {
  const subjects = selectedSubjects();
  for (const subject of subjects) if (!state.subjectGroups.has(subject.id)) state.subjectGroups.set(subject.id, state.analysisGroups[0]?.id);
  const chipFragment = document.createDocumentFragment();
  state.analysisGroups.forEach((group, index) => {
    const chip = document.createElement('div');
    chip.className = 'group-chip';
    const name = document.createElement('input');
    name.value = group.name;
    name.setAttribute('aria-label', `Nome ${group.name}`);
    name.addEventListener('change', () => { group.name = name.value.trim() || `Gruppo ${index + 1}`; refreshGroupAssignments(); });
    chip.append(name);
    if (state.analysisGroups.length > 2) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.title = `Rimuovi ${group.name}`;
      remove.addEventListener('click', () => {
        state.analysisGroups = state.analysisGroups.filter(item => item.id !== group.id);
        for (const subject of state.subjects) if (state.subjectGroups.get(subject.id) === group.id) state.subjectGroups.set(subject.id, state.analysisGroups[0].id);
        invalidateAnalysisResults();
        refreshGroupAssignments();
      });
      chip.append(remove);
    }
    chipFragment.append(chip);
  });
  elements.groupChips.replaceChildren(chipFragment);

  const rowFragment = document.createDocumentFragment();
  for (const subject of subjects) {
    const row = document.createElement('label');
    row.className = 'group-assignment';
    const name = document.createElement('span'); name.textContent = subject.subjectId;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Gruppo per ${subject.subjectId}`);
    for (const group of state.analysisGroups) {
      const option = document.createElement('option'); option.value = group.id; option.textContent = group.name;
      option.selected = state.subjectGroups.get(subject.id) === group.id; select.append(option);
    }
    select.addEventListener('change', () => { state.subjectGroups.set(subject.id, select.value); invalidateAnalysisResults(); });
    row.append(name, select); rowFragment.append(row);
  }
  elements.groupAssignmentRows.replaceChildren(rowFragment);
  elements.groupAssignments.hidden = document.querySelector('input[name="analysisMode"]:checked')?.value !== 'multi';
  updateAnalysisAvailability();
}

function updateAnalysisAvailability() {
  const selectedCount = selectedSubjects().length;
  const targetsSelected = getAnalysisTargets().length;
  elements.runAnalysisBtn.disabled = selectedCount < 2 || !targetsSelected;
  if (!state.analysisResults.length) {
    if (!state.subjects.length) elements.analysisStatus.textContent = 'Seleziona i soggetti nel Viewer.';
    else if (selectedCount < 2) elements.analysisStatus.textContent = 'Servono almeno 2 soggetti selezionati.';
    else if (!targetsSelected) elements.analysisStatus.textContent = 'Seleziona una metrica × stimolo nel Viewer.';
    else elements.analysisStatus.textContent = `${selectedCount} soggetti · ${targetsSelected} serie selezionate.`;
  }
}

function invalidateAnalysisResults() {
  state.analysisResults = [];
  renderAnalysisResults();
  updateAnalysisAvailability();
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
  refreshAnalysisTargets();
  refreshGroupAssignments();
}

function describeOutlierFlag(flag, method) {
  if (flag?.status === 'disabled') return 'Rilevamento automatico disattivato. La selezione dei soggetti resta manuale.';
  if (!flag || flag.status === 'insufficient') {
    if (method === 'mean-iqr') return 'Non valutabile: servono almeno 5 soggetti con almeno due istanti distinti.';
    return 'Non valutabile: servono almeno 3 istanti confrontabili con almeno 5 soggetti.';
  }
  if (method === 'mean-iqr') {
    const mean = flag.temporalMean.toPrecision(4);
    const fences = `[${flag.lowerFence.toPrecision(4)}, ${flag.upperFence.toPrecision(4)}]`;
    return flag.status === 'flagged'
      ? `Possibile outlier: media temporale ${mean}, fuori dai limiti IQR ${fences}. Non viene escluso automaticamente.`
      : `Nessuna segnalazione: media temporale ${mean}, entro i limiti IQR ${fences}. Il soggetto resta incluso se selezionato.`;
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

function setActiveTab(tab) {
  const analysis = tab === 'analysis';
  elements.viewerPanel.hidden = analysis;
  elements.analysisPanel.hidden = !analysis;
  elements.viewerTab.classList.toggle('is-active', !analysis);
  elements.analysisTab.classList.toggle('is-active', analysis);
  elements.viewerTab.setAttribute('aria-selected', String(!analysis));
  elements.analysisTab.setAttribute('aria-selected', String(analysis));
  syncVideoDock(analysis ? 'analysis' : 'viewer');
  syncVideoPlayerCard();
  if (analysis && globalThis.Plotly?.Plots?.resize && elements.analysisChart._fullLayout) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      globalThis.Plotly.Plots.resize(elements.analysisChart);
      updateAnalysisCursor();
    }));
  }
}

function syncVideoPlayerCard() {
  const analysis = !elements.analysisPanel.hidden;
  const hasVideo = Boolean(state.videoUrl);
  elements.stimulusVideoCard.hidden = false;
  elements.stimulusVideoCard.classList.toggle('is-collapsed', !state.stimulusVideoExpanded);
  elements.activeStimulusVideoLabel.hidden = !hasVideo;
  elements.stimulusVideoContent.hidden = !state.stimulusVideoExpanded;
  elements.toggleStimulusVideoBtn.textContent = state.stimulusVideoExpanded ? '−' : '+';
  elements.toggleStimulusVideoBtn.setAttribute('aria-expanded', String(state.stimulusVideoExpanded));
  elements.toggleStimulusVideoBtn.setAttribute('aria-label', `${state.stimulusVideoExpanded ? 'Minimizza' : 'Espandi'} video dello stimolo`);
  elements.toggleStimulusVideoBtn.title = `${state.stimulusVideoExpanded ? 'Minimizza' : 'Espandi'} video dello stimolo`;
  elements.videoPlaceholderMessage.hidden = hasVideo;
  elements.video.hidden = !hasVideo;
  elements.videoControls.hidden = !hasVideo;
  elements.videoPlaceholderMessage.textContent = getStimulusOptions().length
    ? 'Nessun video associato allo stimolo selezionato. Collegalo dal Viewer.'
    : 'Carica un file segnali per visualizzare il video dello stimolo.';
  updateVideoPlayButton();
  (analysis ? elements.analysisSidebar : elements.viewerSidebar).prepend(elements.stimulusVideoCard);
}

function syncVideoDock() {
  elements.viewerVideoDockSlot.append(document.getElementById('videoDock'));
}

function getStimulusOptions() {
  const conditions = [...new Set(state.metrics.flatMap(metric => getConditions(state.subjects, metric)))];
  return conditions.length ? conditions.sort((a, b) => a.localeCompare(b)) : state.subjects.length ? [''] : [];
}

function refreshVideoAssignments() {
  const fragment = document.createDocumentFragment();
  const stimuli = getStimulusOptions();
  if (!stimuli.length) {
    const note = document.createElement('p');
    note.className = 'empty-state';
    note.textContent = 'Carica i dati per associare un video a ciascuno stimolo.';
    elements.videoStimulusAssignments.replaceChildren(note);
    return;
  }
  for (const stimulus of stimuli) {
    const row = document.createElement('div');
    row.className = 'video-assignment';
    const name = document.createElement('span');
    name.className = 'video-assignment-name';
    name.textContent = stimulus || 'Serie principale';
    const assignment = state.videoUrlsByStimulus.get(stimulus);
    const actions = document.createElement('div');
    actions.className = 'video-assignment-actions';
    if (assignment) {
      const fileName = document.createElement('span');
      fileName.className = 'video-assigned-file';
      fileName.textContent = assignment.name;
      fileName.title = assignment.name;
      actions.append(fileName);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'video-remove-button'; remove.textContent = '×';
      remove.title = `Rimuovi video da ${stimulus || 'Serie principale'}`;
      remove.dataset.action = 'remove-video'; remove.dataset.stimulus = stimulus;
      actions.append(remove);
    }
    const label = document.createElement('label');
    label.className = 'file video-assignment-file';
    label.textContent = assignment ? 'Sostituisci' : '＋ Scegli video';
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'video/*';
    input.dataset.action = 'assign-video'; input.dataset.stimulus = stimulus;
    input.setAttribute('aria-label', `Carica video per ${stimulus || 'Serie principale'}`);
    label.append(input); actions.append(label);
    row.append(name, actions); fragment.append(row);
  }
  elements.videoStimulusAssignments.replaceChildren(fragment);
}

function refreshActiveVideo() {
  const nextUrl = state.videoUrlsByStimulus.get(state.selectedCondition)?.url || null;
  const stimulusName = state.selectedCondition || 'Serie principale';
  elements.activeStimulusVideoLabel.textContent = nextUrl ? `Stimolo: ${stimulusName}` : '';
  if (nextUrl === state.videoUrl) {
    syncVideoPlayerCard();
    return;
  }
  if (!elements.video.paused) elements.video.pause();
  state.videoUrl = nextUrl;
  if (nextUrl) elements.video.src = nextUrl;
  else elements.video.removeAttribute('src');
  elements.video.load();
  setCurrentTime(state.currentTime, false);
  syncVideoPlayerCard();
  void renderPlot();
}

function sharedSeries(subjects, metric, condition) {
  const available = subjects.map(subject => ({ subject, series: getSeries(subject, metric, condition) }))
    .filter(item => item.series.length > 0);
  if (!available.length) return null;
  const maps = available.map(item => new Map(item.series.filter(point => Number.isFinite(point.time) && Number.isFinite(point.value)).map(point => [point.time, point.value])));
  const times = [...maps[0].keys()].filter(time => maps.every(map => map.has(time))).sort((a, b) => a - b);
  if (!times.length) return null;
  return { times, subjects: available.map((item, index) => ({ subject: item.subject, values: times.map(time => maps[index].get(time)) })) };
}

function renderAnalysisResults() {
  if (!state.analysisResults.length) {
    elements.analysisResults.replaceChildren();
    elements.downloadAnalysisBtn.disabled = true;
    elements.significantOnly.closest('label').hidden = true;
    if (globalThis.Plotly?.purge) globalThis.Plotly.purge(elements.analysisChart);
    elements.analysisChart.replaceChildren();
    return;
  }
  elements.downloadAnalysisBtn.disabled = false;
  elements.significantOnly.closest('label').hidden = false;
  const allRows = state.analysisResults.flatMap(item => item.points.map(point => ({ item, point })));
  const shownRows = elements.significantOnly.checked ? allRows.filter(({ point }) => point.pAdjusted <= 0.05) : allRows;
  const fragment = document.createDocumentFragment();
  const summary = document.createElement('div');
  summary.className = 'analysis-summary';
  summary.textContent = `${shownRows.length} di ${allRows.length} istanti mostrati. La fascia verde nel grafico marca quelli significativi dopo correzione max-T (p ≤ 0,05); le bande colorate mostrano l’IC 95%.`;
  fragment.append(summary);
  const wrap = document.createElement('div'); wrap.className = 'analysis-table-wrap';
  const table = document.createElement('table'); table.className = 'analysis-table';
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  for (const title of ['Metrica', 'Stimolo', 'Tempo (s)', 'Statistica', 'p non corretta', 'p max-T']) {
    const th = document.createElement('th'); th.textContent = title; header.append(th);
  }
  head.append(header);
  const body = document.createElement('tbody');
  for (const { item, point } of shownRows) {
    const row = document.createElement('tr');
    const values = [item.metric, item.condition || 'Serie principale', point.time.toPrecision(6), point.statistic.toPrecision(5), point.pUncorrected.toPrecision(4), point.pAdjusted.toPrecision(4)];
    values.forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value;
      if (index === 5 && point.pAdjusted <= 0.05) cell.className = 'significant';
      row.append(cell);
    });
    body.append(row);
  }
  if (!shownRows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 6; cell.className = 'empty-state'; cell.textContent = 'Nessun istante significativo con il filtro attivo.';
    row.append(cell); body.append(row);
  }
  table.append(head, body); wrap.append(table); fragment.append(wrap);
  elements.analysisResults.replaceChildren(fragment);
  void renderAnalysisChart(state.analysisResults[0]);
}

function tCritical95(degreesOfFreedom) {
  const values = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    2.021, 2.000, 1.980, 1.960];
  const degrees = [...Array.from({ length: 30 }, (_, index) => index + 1), 40, 60, 120, Infinity];
  const index = degrees.findIndex(degree => degreesOfFreedom <= degree);
  return values[index === -1 ? values.length - 1 : index];
}

function summarizeGroup(subjects, times, label) {
  return {
    label,
    points: times.map((time, timeIndex) => {
      const values = subjects.map(subject => subject.values[timeIndex]);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const sumSquares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
      const standardError = values.length > 1 ? Math.sqrt(sumSquares / (values.length - 1) / values.length) : 0;
      const margin = values.length > 1 ? standardError * tCritical95(values.length - 1) : 0;
      return { time, mean, lower: mean - margin, upper: mean + margin, n: values.length };
    })
  };
}

async function renderAnalysisChart(result) {
  const { times, points, groups, mode } = result;
  if (!times?.length || !points?.length) return;
  try {
    await loadPlotly();
    const palette = ['#312b79', '#13736d', '#b27638', '#9a4e77', '#4169a1', '#728b38'];
    const traces = [];
    groups.forEach((group, groupIndex) => {
      const color = palette[groupIndex % palette.length];
      const x = group.points.map(point => point.time);
      const rgba = color === '#312b79' ? 'rgba(49,43,121,0.17)' : color === '#13736d' ? 'rgba(19,115,109,0.16)' : `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},0.15)`;
      traces.push({ x, y: group.points.map(point => point.lower), mode: 'lines', line: { color, width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: `group-${groupIndex}` });
      traces.push({ x, y: group.points.map(point => point.upper), mode: 'lines', line: { color, width: 0 }, fill: 'tonexty', fillcolor: rgba, hoverinfo: 'skip', showlegend: false, legendgroup: `group-${groupIndex}` });
      traces.push({ x, y: group.points.map(point => point.mean), mode: 'lines', type: 'scatter', name: `${group.label} · media ± IC 95%`, line: { color, width: 2.5 }, legendgroup: `group-${groupIndex}`, hovertemplate: `${group.label}<br>%{x:.3f} s<br>%{y:.4g}<extra></extra>` });
    });
    traces.push({ x: [null], y: [null], mode: 'markers', type: 'scatter', name: 'Significativo (max-T ≤ 0,05)', marker: { color: '#198754', size: 9, symbol: 'square' }, hoverinfo: 'skip' });

    const significantIndexes = points.map((point, index) => point.pAdjusted <= 0.05 ? index : -1).filter(index => index >= 0);
    const shapes = significantIndexes.map(index => {
      const halfStep = times.length > 1 ? (times[1] - times[0]) / 2 : 0.005;
      const left = index === 0 ? times[index] - (times[index + 1] !== undefined ? (times[index + 1] - times[index]) / 2 : halfStep) : (times[index - 1] + times[index]) / 2;
      const right = index === times.length - 1 ? times[index] + (times[index - 1] !== undefined ? (times[index] - times[index - 1]) / 2 : halfStep) : (times[index] + times[index + 1]) / 2;
      return { type: 'rect', xref: 'x', yref: 'paper', x0: left, x1: right, y0: 0, y1: 1, fillcolor: 'rgba(25,135,84,0.14)', line: { width: 0 }, layer: 'below' };
    });
    const cursorShapeIndex = shapes.length;
    shapes.push({
      type: 'line', xref: 'x', yref: 'paper', x0: state.currentTime, x1: state.currentTime, y0: 0, y1: 1,
      editable: true, layer: 'above', line: { color: '#312b79', width: 2, dash: 'dot' }
    });
    elements.analysisChart.dataset.cursorShapeIndex = String(cursorShapeIndex);
    const target = `${result.metric}${result.condition ? ` · ${result.condition}` : ''}`;
    const layout = {
      title: `${target} · ${mode === 'one' ? 'test a un campione' : 'confronto tra gruppi'}`,
      template: 'plotly_white', hovermode: 'x unified', shapes, autosize: true,
      xaxis: { title: 'Tempo (s)', range: [0, Math.max(times.at(-1), Number.isFinite(elements.video.duration) ? elements.video.duration : 0)], gridcolor: '#e7e5f1' },
      yaxis: { title: result.metric, gridcolor: '#e7e5f1' },
      legend: { orientation: 'h', y: -0.22 },
      margin: { l: 65, r: 20, t: 55, b: 95 }, height: 470,
      annotations: significantIndexes.length ? [] : [{ text: 'Nessun istante significativo con correzione max-T (α = 0,05)', xref: 'paper', yref: 'paper', x: 0.5, y: 1, showarrow: false, yshift: 14, font: { color: '#686887', size: 11 } }]
    };
    const config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };
    if (elements.analysisChart._fullLayout) await globalThis.Plotly.react(elements.analysisChart, traces, layout, config);
    else await globalThis.Plotly.newPlot(elements.analysisChart, traces, layout, config);
    attachAnalysisChartInteractions();
    if (!elements.analysisChart.__analysisResizeObserver && globalThis.ResizeObserver) {
      elements.analysisChart.__analysisResizeObserver = new ResizeObserver(() => {
        if (!elements.analysisPanel.hidden && elements.analysisChart._fullLayout) globalThis.Plotly.Plots.resize(elements.analysisChart);
      });
      elements.analysisChart.__analysisResizeObserver.observe(elements.analysisChart.closest('.analysis-plot-panel'));
    }
    if (!elements.analysisPanel.hidden) {
      requestAnimationFrame(() => requestAnimationFrame(() => globalThis.Plotly.Plots.resize(elements.analysisChart)));
    }
    updateAnalysisCursor();
  } catch (error) {
    elements.analysisChart.textContent = `Grafico non disponibile: ${error.message}`;
  }
}

function attachAnalysisChartInteractions() {
  const chart = elements.analysisChart;
  if (chart.__analysisSyncAttached || typeof chart.on !== 'function') return;
  chart.on('plotly_click', event => {
    const time = Number(event.points?.[0]?.x);
    if (Number.isFinite(time)) setCurrentTime(time, true);
  });
  chart.on('plotly_relayout', update => {
    const index = Number(chart.dataset.cursorShapeIndex);
    const time = update[`shapes[${index}].x0`] ?? update[`shapes[${index}].x1`];
    if (Number.isFinite(Number(time)) && Math.abs(Number(time) - state.currentTime) > 0.002) setCurrentTime(Number(time), true);
  });
  chart.__analysisSyncAttached = true;
}

function updateAnalysisCursor() {
  const chart = elements.analysisChart;
  if (!chart?._fullLayout || !globalThis.Plotly?.relayout) return;
  if (analysisCursorRelayoutInFlight) {
    analysisCursorUpdatePending = true;
    return;
  }
  const elapsed = performance.now() - analysisCursorRelayoutAt;
  if (elapsed < 33) {
    analysisCursorUpdatePending = true;
    if (analysisCursorTimer === null) {
      analysisCursorTimer = setTimeout(() => {
        analysisCursorTimer = null;
        analysisCursorUpdatePending = false;
        updateAnalysisCursor();
      }, 33 - elapsed);
    }
    return;
  }
  const index = Number(chart.dataset.cursorShapeIndex);
  if (!Number.isInteger(index)) return;
  const time = state.currentTime;
  analysisCursorRelayoutAt = performance.now();
  analysisCursorRelayoutInFlight = true;
  globalThis.Plotly.relayout(chart, { [`shapes[${index}].x0`]: time, [`shapes[${index}].x1`]: time })
    .catch(() => {})
    .finally(() => {
      analysisCursorRelayoutInFlight = false;
      if (analysisCursorUpdatePending) {
        if (analysisCursorTimer !== null) clearTimeout(analysisCursorTimer);
        analysisCursorTimer = null;
        analysisCursorUpdatePending = false;
        updateAnalysisCursor();
      }
    });
}

async function runAnalysis() {
  const mode = document.querySelector('input[name="analysisMode"]:checked')?.value || 'one';
  const permutations = Number(elements.permutationCount.value);
  const nullValue = Number(elements.nullValue.value);
  if (!Number.isInteger(permutations) || permutations < 100 || permutations > 50000 || (mode === 'one' && !Number.isFinite(nullValue))) {
    elements.analysisStatus.textContent = 'Controlla il valore nullo e imposta 100–50.000 permutazioni.';
    return;
  }
  const targets = getAnalysisTargets();
  const selected = selectedSubjects();
  const groups = state.analysisGroups;
  const groupIndexById = new Map(groups.map((group, index) => [group.id, index]));
  if (mode === 'multi') {
    const counts = groups.map(group => selected.filter(subject => state.subjectGroups.get(subject.id) === group.id).length);
    if (counts.some(count => count < 2)) {
      elements.analysisStatus.textContent = 'Assegna almeno 2 soggetti a ciascun gruppo.';
      return;
    }
  }

  elements.runAnalysisBtn.disabled = true;
  elements.analysisStatus.textContent = 'Preparazione dei test…';
  elements.analysisResults.replaceChildren();
  state.analysisResults = [];
  if (globalThis.Plotly?.purge) globalThis.Plotly.purge(elements.analysisChart);
  elements.analysisChart.replaceChildren();
  const results = [];
  let failureMessage = '';
  try {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex];
      const shared = sharedSeries(selected, target.metric, target.condition);
      if (!shared) throw new Error(`Nessun tempo condiviso per ${target.metric}${target.condition ? ` · ${target.condition}` : ''}.`);
      let analysisSubjects = shared.subjects;
      if (mode === 'multi') {
        analysisSubjects = analysisSubjects.map(item => ({ ...item, groupIndex: groupIndexById.get(state.subjectGroups.get(item.subject.id)) }));
        const counts = groups.map((_, index) => analysisSubjects.filter(item => item.groupIndex === index).length);
        if (counts.some(count => count < 2)) throw new Error(`Dati incompleti: uno o più gruppi hanno meno di 2 soggetti con serie valida per ${target.metric}.`);
      }
      elements.analysisStatus.textContent = `Analisi ${targetIndex + 1}/${targets.length}: ${target.metric}${target.condition ? ` · ${target.condition}` : ''}…`;
      const points = await runPermutationTest({
        subjects: analysisSubjects.map(item => ({ values: item.values, groupIndex: item.groupIndex })),
        times: shared.times, mode, nullValue, permutations,
        onProgress: (done, total) => { elements.analysisStatus.textContent = `Analisi ${targetIndex + 1}/${targets.length}: ${done.toLocaleString('it-IT')}/${total.toLocaleString('it-IT')} permutazioni…`; }
      });
      const summaryGroups = mode === 'one'
        ? [summarizeGroup(analysisSubjects, shared.times, 'Soggetti selezionati')]
        : groups.map((group, groupIndex) => summarizeGroup(analysisSubjects.filter(item => item.groupIndex === groupIndex), shared.times, group.name));
      results.push({ metric: target.metric, condition: target.condition, points, times: shared.times, groups: summaryGroups, mode });
    }
    state.analysisResults = results;
    renderAnalysisResults();
    const significant = results.reduce((count, result) => count + result.points.filter(point => point.pAdjusted <= 0.05).length, 0);
    elements.analysisStatus.textContent = `Completato: ${results.length} serie, ${significant} istanti con p max-T ≤ 0,05.`;
  } catch (error) {
    failureMessage = error.message;
    elements.analysisStatus.textContent = failureMessage;
    state.analysisResults = results;
    renderAnalysisResults();
  } finally {
    updateAnalysisAvailability();
    if (failureMessage) elements.analysisStatus.textContent = failureMessage;
  }
}

function exportAnalysis() {
  if (!state.analysisResults.length) return;
  const rows = [['metric', 'stimulus', 'time_s', 'statistic', 'p_uncorrected', 'p_maxT']];
  for (const item of state.analysisResults) for (const point of item.points) {
    if (elements.significantOnly.checked && point.pAdjusted > 0.05) continue;
    rows.push([item.metric, item.condition, point.time, point.statistic, point.pUncorrected, point.pAdjusted]);
  }
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = blobUrl; link.download = 'analisi_permutation_mass_univariate.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
}

async function handleSignalFile(file) {
  showMessage('');
  setLoading(true, 'Apertura del file…');
  let loaded = false;

  try {
    await yieldToBrowser();
    const dataset = await readSignalFile(file, message => setLoading(true, message));
    state.subjects = dataset.subjects;
    state.metrics = [];
    state.conditions = [];
    state.selectedMetric = '';
    state.selectedCondition = '';
    state.currentTime = 0;
    state.analysisGroups = [{ id: 'group-1', name: 'Gruppo 1' }, { id: 'group-2', name: 'Gruppo 2' }];
    state.subjectGroups = new Map();
    state.analysisResults = [];
    renderAnalysisResults();
    setLoading(true, 'Aggiornamento del grafico…');
    await yieldToBrowser();
    await refreshApp();
    loaded = true;

    if (dataset.skippedSheets?.length) {
      showMessage(`Importati i dati validi; ignorati ${dataset.skippedSheets.length} fogli senza una colonna tempo riconoscibile.`);
    }
  } catch (error) {
    showMessage(`${file.name}: ${error.message}`);
  } finally {
    elements.signalFiles.value = '';
    setLoading(false);
  }
  return loaded;
}

function normalizedStimulus(value) {
  return String(value).toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function findStimulusForVideo(file, allowCurrentFallback) {
  const name = normalizedStimulus(file.name.replace(/\.[^.]+$/, ''));
  const matches = getStimulusOptions().filter(stimulus => {
    const key = normalizedStimulus(stimulus);
    return key && name.includes(key);
  }).sort((a, b) => normalizedStimulus(b).length - normalizedStimulus(a).length);
  if (matches.length) return matches[0];
  if (allowCurrentFallback && getStimulusOptions().includes(state.selectedCondition)) return state.selectedCondition;
  return null;
}

async function importDroppedFiles(fileList) {
  const files = [...fileList];
  const signalExtensions = /\.(csv|txt|tsv|xlsx|xls)$/i;
  const videoExtensions = /\.(mp4|webm|ogg|mov|m4v|avi)$/i;
  const signals = files.filter(file => signalExtensions.test(file.name));
  const videos = files.filter(file => file.type.startsWith('video/') || videoExtensions.test(file.name));
  let loadedSignal = true;
  if (signals.length) {
    elements.dropStatus.textContent = `Caricamento di ${signals[0].name}…`;
    loadedSignal = await handleSignalFile(signals[0]);
    if (!loadedSignal) return;
  }
  if (!state.subjects.length && videos.length) {
    elements.dropStatus.textContent = 'Carica prima un file segnali, poi abbina i video agli stimoli.';
    return;
  }
  const unmatched = [];
  videos.forEach((file, index) => {
    const stimulus = findStimulusForVideo(file, videos.length === 1);
    if (stimulus === null) unmatched.push(file.name);
    else assignVideoFile(stimulus, file);
  });
  const extras = signals.length > 1 ? ` Caricato ${signals[0].name}; gli altri file segnali non sono stati importati.` : '';
  elements.dropStatus.textContent = unmatched.length
    ? `Stimolo non riconosciuto per: ${unmatched.join(', ')}. Rinomina il video includendo il nome dello stimolo.${extras}`
    : `${signals.length ? `Caricato ${signals[0].name}` : ''}${videos.length ? `${signals.length ? ' · ' : ''}abbinati ${videos.length-unmatched.length} video` : ''}${extras}` || 'Nessun file selezionato.';
}

async function loadDemoExample() {
  if (!globalThis.TimeSeriesDemoAssets?.workbookBase64) {
    elements.dropStatus.textContent = 'I file demo non sono disponibili.';
    return;
  }
  elements.loadDemoBtn.disabled = true;
  elements.dropStatus.textContent = 'Caricamento dell’esempio con due stimoli…';
  try {
    const binary = atob(globalThis.TimeSeriesDemoAssets.workbookBase64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const workbook = new File([bytes], 'EEG_TimeSeries_demo_sintetico_2_stimoli.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const loaded = await handleSignalFile(workbook);
    if (!loaded) throw new Error('Non è stato possibile caricare il workbook demo.');
    for (const previous of state.videoUrlsByStimulus.values()) if (previous.objectUrl) URL.revokeObjectURL(previous.url);
    state.videoUrlsByStimulus.clear();
    for (const item of globalThis.TimeSeriesDemoAssets.videos) {
      state.videoUrlsByStimulus.set(item.stimulus, { url: new URL(item.path, location.href).href, name: item.name, objectUrl: false });
    }
    refreshVideoAssignments();
    refreshActiveVideo();
    syncVideoDock(elements.analysisPanel.hidden ? 'viewer' : 'analysis');
    elements.dropStatus.textContent = 'Esempio caricato: 8 metriche, 2 stimoli e i relativi video.';
  } catch (error) {
    elements.dropStatus.textContent = `Esempio non caricato: ${error.message}`;
  } finally {
    elements.loadDemoBtn.disabled = false;
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

function assignVideoFile(stimulus, file) {
  const previous = state.videoUrlsByStimulus.get(stimulus);
  if (previous?.objectUrl) URL.revokeObjectURL(previous.url);
  state.videoUrlsByStimulus.set(stimulus, { url: URL.createObjectURL(file), name: file.name, objectUrl: true });
  refreshVideoAssignments();
  refreshActiveVideo();
  syncVideoDock(elements.analysisPanel.hidden ? 'viewer' : 'analysis');
  showMessage('');
}

function removeVideoAssignment(stimulus) {
  const assignment = state.videoUrlsByStimulus.get(stimulus);
  if (assignment?.objectUrl) URL.revokeObjectURL(assignment.url);
  state.videoUrlsByStimulus.delete(stimulus);
  refreshVideoAssignments();
  refreshActiveVideo();
  syncVideoDock(elements.analysisPanel.hidden ? 'viewer' : 'analysis');
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
  if (file) {
    elements.dropStatus.textContent = `Caricamento di ${file.name}…`;
    void handleSignalFile(file).then(loaded => { if (loaded) elements.dropStatus.textContent = `Caricato ${file.name}`; });
  }
});

elements.videoStimulusAssignments.addEventListener('change', event => {
  const input = event.target.closest('[data-action="assign-video"]');
  const file = input?.files?.[0];
  if (input && file) assignVideoFile(input.dataset.stimulus, file);
  if (input) input.value = '';
});
elements.videoStimulusAssignments.addEventListener('click', event => {
  const button = event.target.closest('[data-action="remove-video"]');
  if (button) removeVideoAssignment(button.dataset.stimulus);
});
elements.loadDemoBtn.addEventListener('click', () => void loadDemoExample());
for (const type of ['dragenter', 'dragover']) elements.signalDropZone.addEventListener(type, event => {
  event.preventDefault(); elements.signalDropZone.classList.add('is-dragging');
});
for (const type of ['dragleave', 'drop']) elements.signalDropZone.addEventListener(type, event => {
  event.preventDefault(); elements.signalDropZone.classList.remove('is-dragging');
});
elements.signalDropZone.addEventListener('drop', event => void importDroppedFiles(event.dataTransfer?.files || []));

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
  invalidateAnalysisResults();
  renderSubjectTable();
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});

elements.selectNoneBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => { subject.selected = false; });
  invalidateAnalysisResults();
  renderSubjectTable();
  setCurrentTime(state.currentTime, false);
  void renderPlot();
});

elements.downloadAverageBtn.addEventListener('click', exportAverage);

elements.viewerTab.addEventListener('click', () => setActiveTab('viewer'));
elements.analysisTab.addEventListener('click', () => setActiveTab('analysis'));
document.querySelectorAll('input[name="analysisMode"]').forEach(input => input.addEventListener('change', () => {
  const multi = input.value === 'multi' && input.checked;
  elements.nullValueControl.hidden = multi;
  elements.groupAssignments.hidden = !multi;
  invalidateAnalysisResults();
}));
elements.addGroupBtn.addEventListener('click', () => {
  const index = state.analysisGroups.length + 1;
  const id = `group-${Date.now()}-${index}`;
  state.analysisGroups.push({ id, name: `Gruppo ${index}` });
  invalidateAnalysisResults();
  refreshGroupAssignments();
});
elements.runAnalysisBtn.addEventListener('click', () => void runAnalysis());
elements.downloadAnalysisBtn.addEventListener('click', exportAnalysis);
elements.significantOnly.addEventListener('change', renderAnalysisResults);

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
  invalidateAnalysisResults();
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
    invalidateAnalysisResults();
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
  const time = Number.isFinite(elements.video.duration) ? Math.min(state.currentTime, elements.video.duration) : state.currentTime;
  if (Number.isFinite(time)) elements.video.currentTime = time;
  setCurrentTime(time, false);
  void renderPlot();
});
elements.video.addEventListener('timeupdate', () => setCurrentTime(elements.video.currentTime || 0, false));
elements.video.addEventListener('seeked', () => setCurrentTime(elements.video.currentTime || 0, false));
elements.video.addEventListener('play', () => {
  updateVideoPlayButton();
  startVideoSync();
});
elements.video.addEventListener('pause', () => {
  updateVideoPlayButton();
  stopVideoSync();
  setCurrentTime(elements.video.currentTime || 0, false);
});
elements.video.addEventListener('ended', () => {
  updateVideoPlayButton();
  stopVideoSync();
  setCurrentTime(elements.video.currentTime || 0, false);
});
elements.videoPlayBtn.addEventListener('click', () => {
  if (elements.video.paused) void elements.video.play().catch(() => {});
  else elements.video.pause();
});
elements.videoSeek.addEventListener('input', () => {
  if (!Number.isFinite(elements.video.duration)) return;
  const time = elements.video.duration * Number(elements.videoSeek.value) / 1000;
  elements.video.currentTime = time;
  setCurrentTime(time, false);
});
elements.toggleStimulusVideoBtn.addEventListener('click', () => {
  state.stimulusVideoExpanded = !state.stimulusVideoExpanded;
  if (!state.stimulusVideoExpanded && !elements.video.paused) elements.video.pause();
  syncVideoPlayerCard();
});

window.addEventListener('pagehide', () => {
  stopVideoSync();
  for (const assignment of state.videoUrlsByStimulus.values()) if (assignment.objectUrl) URL.revokeObjectURL(assignment.url);
});

refreshApp();
})(globalThis);
