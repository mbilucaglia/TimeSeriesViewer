const state = {
  subjects: [],
  videoUrl: null,
  currentTime: 0,
  metrics: [],
  selectedMetric: ''
};

const signalFilesInput = document.getElementById('signalFiles');
const videoFileInput = document.getElementById('videoFile');
const videoEl = document.getElementById('video');
const errorsEl = document.getElementById('errors');
const tbody = document.querySelector('#subjectsTable tbody');

const showIndividualsEl = document.getElementById('showIndividuals');
const showAverageEl = document.getElementById('showAverage');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectNoneBtn = document.getElementById('selectNoneBtn');
const downloadAverageBtn = document.getElementById('downloadAverageBtn');
const metricSelectEl = document.getElementById('metricSelect');

const metaSubjectsEl = document.getElementById('metaSubjects');
const metaMetricsEl = document.getElementById('metaMetrics');
const metaSelectedEl = document.getElementById('metaSelected');

const timeLabelEl = document.getElementById('timeLabel');

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `subject-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showError(message) {
  if (!errorsEl) return;
  errorsEl.textContent = message || '';
}

function safeMakePlot() {
  if (typeof makePlot === 'function') {
    makePlot();
  }
}

function safeUpdateCursor() {
  if (typeof updateCursor === 'function') {
    updateCursor();
  }
}

function detectDelimiter(text, filename) {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.tsv')) {
    return '\t';
  }

  const commas = (text.match(/,/g) || []).length;
  const tabs = (text.match(/\t/g) || []).length;
  const semicolons = (text.match(/;/g) || []).length;

  if (tabs > commas && tabs > semicolons) {
    return '\t';
  }

  if (semicolons > commas) {
    return ';';
  }

  return ',';
}

/*
  Lightweight CSV / TSV parser with support for quoted values.

  This is safer than row.split(delimiter), because it can read values like:
  "Subject, 01"
*/
function parseDelimitedText(text, delimiter) {
  const rows = [];
  let currentRow = [];
  let currentValue = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentValue += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }

      continue;
    }

    if (char === delimiter && !insideQuotes) {
      currentRow.push(currentValue.trim());
      currentValue = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }

      currentRow.push(currentValue.trim());

      if (currentRow.some(value => value.length > 0)) {
        rows.push(currentRow);
      }

      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += char;
  }

  currentRow.push(currentValue.trim());

  if (currentRow.some(value => value.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

function parseTable(text, delimiter) {
  const parsedRows = parseDelimitedText(text, delimiter);

  if (parsedRows.length < 2) {
    throw new Error('File needs a header row and at least one data row.');
  }

  const headers = parsedRows[0].map(header => header.trim());

  if (!headers.length || headers.some(header => !header)) {
    throw new Error('The header row has empty column names.');
  }

  const rows = [];

  for (let i = 1; i < parsedRows.length; i++) {
    const columns = parsedRows[i];

    if (columns.length !== headers.length) {
      continue;
    }

    const row = {};

    headers.forEach((header, index) => {
      row[header] = columns[index];
    });

    rows.push(row);
  }

  if (!rows.length) {
    throw new Error('No valid data rows were found.');
  }

  return { headers, rows };
}

function buildSubject(subjectId, dataByMetric) {
  const metrics = Object.keys(dataByMetric);

  let points = 0;
  let minT = Infinity;
  let maxT = -Infinity;

  for (const metric of metrics) {
    const series = dataByMetric[metric];

    points = Math.max(points, series.length);

    for (const point of series) {
      minT = Math.min(minT, point.time);
      maxT = Math.max(maxT, point.time);
    }
  }

  return {
    id: makeId(),
    subjectId,
    selected: true,
    metrics,
    dataByMetric,
    points,
    minT: Number.isFinite(minT) ? minT : '',
    maxT: Number.isFinite(maxT) ? maxT : ''
  };
}

function parseLongFormat(headers, rows) {
  const lowerMap = Object.fromEntries(
    headers.map(header => [header.toLowerCase(), header])
  );

  const timeCol = lowerMap.time_s || lowerMap.time || headers[0];
  const subjectCol = lowerMap.subject_id || lowerMap.subject || headers[1];

  if (!timeCol || !subjectCol) {
    throw new Error('Long format needs time_s and subject_id columns.');
  }

  const metricCols = headers.filter(
    header => header !== timeCol && header !== subjectCol
  );

  if (!metricCols.length) {
    throw new Error('No metric columns found.');
  }

  const grouped = new Map();

  for (const row of rows) {
    const subjectId = String(row[subjectCol] || '').trim();
    const time = Number(row[timeCol]);

    if (!subjectId || !Number.isFinite(time)) {
      continue;
    }

    if (!grouped.has(subjectId)) {
      grouped.set(subjectId, {});
    }

    const metricMap = grouped.get(subjectId);

    for (const metric of metricCols) {
      const value = Number(row[metric]);

      if (!Number.isFinite(value)) {
        continue;
      }

      if (!metricMap[metric]) {
        metricMap[metric] = [];
      }

      metricMap[metric].push({
        time,
        value
      });
    }
  }

  const subjects = [];

  for (const [subjectId, dataByMetric] of grouped.entries()) {
    for (const metric of Object.keys(dataByMetric)) {
      dataByMetric[metric].sort((a, b) => a.time - b.time);
    }

    subjects.push(buildSubject(subjectId, dataByMetric));
  }

  if (!subjects.length) {
    throw new Error('No valid subjects were found in the file.');
  }

  return subjects;
}

async function readSignalFile(file) {
  const text = await file.text();
  const delimiter = detectDelimiter(text.slice(0, 2000), file.name);
  const { headers, rows } = parseTable(text, delimiter);

  const lowerHeaders = headers.map(header => header.toLowerCase());
  const isLongFormat =
    lowerHeaders.includes('subject_id') || lowerHeaders.includes('subject');

  if (!isLongFormat) {
    throw new Error(
      'This version accepts only one long-format file with time_s, subject_id, and metric columns.'
    );
  }

  return parseLongFormat(headers, rows);
}

function getSelectedSubjects() {
  return state.subjects.filter(subject => subject.selected);
}

function getSeries(subject, metric) {
  if (!subject || !metric) return [];
  return subject.dataByMetric[metric] || [];
}

function intersectTimes(selected, metric) {
  const validSubjects = selected.filter(
    subject => getSeries(subject, metric).length
  );

  if (!validSubjects.length) {
    return [];
  }

  let commonTimes = new Set(
    getSeries(validSubjects[0], metric).map(point => point.time)
  );

  for (let i = 1; i < validSubjects.length; i++) {
    const subjectTimes = new Set(
      getSeries(validSubjects[i], metric).map(point => point.time)
    );

    commonTimes = new Set(
      [...commonTimes].filter(time => subjectTimes.has(time))
    );
  }

  return [...commonTimes].sort((a, b) => a - b);
}

function computeAverage(selected, metric) {
  const usableSubjects = selected.filter(
    subject => getSeries(subject, metric).length
  );

  if (!usableSubjects.length) {
    return [];
  }

  const times = intersectTimes(usableSubjects, metric);

  const lookupMaps = usableSubjects.map(subject => {
    const map = new Map();

    getSeries(subject, metric).forEach(point => {
      map.set(point.time, point.value);
    });

    return map;
  });

  return times.map(time => {
    let sum = 0;

    for (const map of lookupMaps) {
      sum += map.get(time);
    }

    return {
      time,
      value: sum / lookupMaps.length
    };
  });
}

function refreshMetrics() {
  const metricSet = new Set();

  state.subjects.forEach(subject => {
    subject.metrics.forEach(metric => metricSet.add(metric));
  });

  state.metrics = [...metricSet];

  if (!state.metrics.includes(state.selectedMetric)) {
    state.selectedMetric = state.metrics[0] || '';
  }

  if (!metricSelectEl) return;

  metricSelectEl.innerHTML = state.metrics
    .map(metric => {
      const selected = metric === state.selectedMetric ? 'selected' : '';

      return `
        <option value="${escapeAttr(metric)}" ${selected}>
          ${escapeHtml(metric)}
        </option>
      `;
    })
    .join('');
}

function refreshMeta() {
  if (metaSubjectsEl) {
    metaSubjectsEl.textContent = `Subjects: ${state.subjects.length}`;
  }

  if (metaMetricsEl) {
    metaMetricsEl.textContent = `Metrics: ${state.metrics.length}`;
  }

  if (metaSelectedEl) {
    metaSelectedEl.textContent = `Selected: ${getSelectedSubjects().length}`;
  }
}

function renderTable() {
  if (!tbody) return;

  tbody.innerHTML = '';

  state.subjects.forEach((subject, index) => {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td class="col-select">
        <input
          type="checkbox"
          data-action="toggle"
          data-index="${index}"
          ${subject.selected ? 'checked' : ''}
        />
      </td>

      <td class="col-subject">
        <input
          class="subject-name-input"
          type="text"
          data-action="rename"
          data-index="${index}"
          value="${escapeAttr(subject.subjectId)}"
        />
      </td>

      <td class="col-metrics">
        ${escapeHtml(subject.metrics.join(', '))}
      </td>

      <td class="col-points">
        ${subject.points}
      </td>

      <td class="col-range">
        ${subject.minT} – ${subject.maxT}
      </td>

      <td class="col-remove">
        <button
          type="button"
          class="danger-button"
          data-action="remove"
          data-index="${index}"
          title="Remove subject"
        >
          ✕
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });

  refreshMeta();
}

function downloadText(filename, text) {
  const blob = new Blob([text], {
    type: 'text/plain;charset=utf-8'
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

function exportAverage() {
  const selected = getSelectedSubjects();
  const metric = state.selectedMetric;

  if (!selected.length || !metric) {
    showError('Select at least one subject and one metric before exporting the average.');
    return;
  }

  const average = computeAverage(selected, metric);

  if (!average.length) {
    showError(
      'The selected subjects do not share matching time values for this metric, so no average could be exported.'
    );
    return;
  }

  const csv = [
    `time,mean_${metric}`,
    ...average.map(point => `${point.time},${point.value}`)
  ].join('\n');

  downloadText(`average_${metric}.csv`, csv);
  showError('');
}

function getDataMaxTime(metric) {
  let maxT = 0;

  for (const subject of getSelectedSubjects()) {
    const series = getSeries(subject, metric);

    if (!series.length) continue;

    const lastT = series[series.length - 1].time;

    if (Number.isFinite(lastT)) {
      maxT = Math.max(maxT, lastT);
    }
  }

  return maxT;
}

/*
  This is the global duration used by both video and plot.

  Important:
  - If the video is longer than the signal, the cursor can still follow the video.
  - If the signal is longer than the video, the plot still shows the whole signal.
*/
function getMaxPlayableTime() {
  const signalMax =
    typeof getSignalMaxTime === 'function'
      ? getSignalMaxTime(state.selectedMetric) || 0
      : getDataMaxTime(state.selectedMetric) || 0;

  const videoMax = Number.isFinite(videoEl?.duration)
    ? videoEl.duration
    : 0;

  return Math.max(signalMax, videoMax);
}

/*
  The central time function.

  Every time change should go through here:
  - video playback
  - plot click
  - draggable lower cursor
  - keyboard control
*/
function setCurrentTime(nextTime, syncVideo = true) {
  const maxTime = getMaxPlayableTime();
  const numericTime = Number(nextTime) || 0;
  const time = maxTime > 0
    ? Math.max(0, Math.min(numericTime, maxTime))
    : Math.max(0, numericTime);

  state.currentTime = time;

  if (syncVideo && videoEl && videoEl.currentSrc) {
    const videoTime = Number.isFinite(videoEl.duration)
      ? Math.min(time, videoEl.duration)
      : time;

    /*
      Avoid repeatedly assigning currentTime by tiny amounts.
      This prevents jitter while the video is playing.
    */
    if (Math.abs(videoEl.currentTime - videoTime) > 0.03) {
      videoEl.currentTime = videoTime;
    }
  }

  if (timeLabelEl) {
    timeLabelEl.textContent = `${time.toFixed(2)} s`;
  }

  safeUpdateCursor();
}

if (signalFilesInput) {
  signalFilesInput.addEventListener('change', async event => {
    showError('');

    const file = event.target.files[0];

    if (!file) {
      return;
    }

    try {
      const subjects = await readSignalFile(file);

      state.subjects = subjects;

      refreshMetrics();
      renderTable();
      safeMakePlot();
    } catch (error) {
      showError(`${file.name}: ${error.message}`);
    }

    signalFilesInput.value = '';
  });
}

if (videoFileInput) {
  videoFileInput.addEventListener('change', event => {
    const file = event.target.files[0];

    if (!file || !videoEl) {
      return;
    }

    if (state.videoUrl) {
      URL.revokeObjectURL(state.videoUrl);
    }

    state.videoUrl = URL.createObjectURL(file);
    videoEl.src = state.videoUrl;
    videoEl.load();
  });
}

if (videoEl) {
  videoEl.addEventListener('loadedmetadata', () => {
    setCurrentTime(state.currentTime, false);
    safeMakePlot();
  });

  videoEl.addEventListener('seeked', () => {
    setCurrentTime(videoEl.currentTime || 0, false);
  });

  videoEl.addEventListener('timeupdate', () => {
    setCurrentTime(videoEl.currentTime || 0, false);
  });
}

if (metricSelectEl) {
  metricSelectEl.addEventListener('change', () => {
    state.selectedMetric = metricSelectEl.value;
    safeMakePlot();
  });
}

if (tbody) {
  tbody.addEventListener('input', event => {
    const action = event.target.dataset.action;
    const index = Number(event.target.dataset.index);

    if (!Number.isInteger(index) || !state.subjects[index]) {
      return;
    }

    if (action === 'rename') {
      state.subjects[index].subjectId =
        event.target.value.trim() || `Subject ${index + 1}`;

      safeMakePlot();
    }
  });

  tbody.addEventListener('change', event => {
    const action = event.target.dataset.action;
    const index = Number(event.target.dataset.index);

    if (!Number.isInteger(index) || !state.subjects[index]) {
      return;
    }

    if (action === 'toggle') {
      state.subjects[index].selected = event.target.checked;

      refreshMeta();
      safeMakePlot();
    }
  });

  tbody.addEventListener('click', event => {
    const action = event.target.dataset.action;
    const index = Number(event.target.dataset.index);

    if (!Number.isInteger(index) || !state.subjects[index]) {
      return;
    }

    if (action === 'remove') {
      state.subjects.splice(index, 1);

      refreshMetrics();
      renderTable();
      safeMakePlot();
    }
  });
}

if (showIndividualsEl) {
  showIndividualsEl.addEventListener('change', safeMakePlot);
}

if (showAverageEl) {
  showAverageEl.addEventListener('change', safeMakePlot);
}

if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    state.subjects.forEach(subject => {
      subject.selected = true;
    });

    renderTable();
    safeMakePlot();
  });
}

if (selectNoneBtn) {
  selectNoneBtn.addEventListener('click', () => {
    state.subjects.forEach(subject => {
      subject.selected = false;
    });

    renderTable();
    safeMakePlot();
  });
}

if (downloadAverageBtn) {
  downloadAverageBtn.addEventListener('click', exportAverage);
}

/*
  Smooth video-to-plot synchronization.

  The video is the master clock while loaded.
  requestAnimationFrame keeps the cursor smoother than timeupdate alone.
*/
function tick() {
  if (videoEl && videoEl.currentSrc) {
    setCurrentTime(videoEl.currentTime || 0, false);
  } else {
    if (timeLabelEl) {
      timeLabelEl.textContent = `${state.currentTime.toFixed(2)} s`;
    }

    safeUpdateCursor();
  }

  requestAnimationFrame(tick);
}

refreshMetrics();
renderTable();
safeMakePlot();
tick();
