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
  errorsEl.textContent = message || '';
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
  Simple CSV/TSV parser with quote support.

  It is still intentionally lightweight, but this is safer than splitting
  rows with line.split(delimiter), because it can handle values like:
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
  const firstMetric = metrics[0];
  const firstSeries = firstMetric ? dataByMetric[firstMetric] : [];

  return {
    id: crypto.randomUUID(),
    subjectId,
    selected: true,
    metrics,
    dataByMetric,
    points: firstSeries.length,
    minT: firstSeries[0]?.time ?? '',
    maxT: firstSeries[firstSeries.length - 1]?.time ?? ''
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
    validSubjects[0].dataByMetric[metric].map(point => point.time)
  );

  for (let i = 1; i < validSubjects.length; i++) {
    const subjectTimes = new Set(
      validSubjects[i].dataByMetric[metric].map(point => point.time)
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

  const times = intersectTimes(usableSubjects, metric);

  return times.map(time => {
    let sum = 0;

    for (const subject of usableSubjects) {
      const point = subject.dataByMetric[metric].find(
        item => item.time === time
      );

      sum += point.value;
    }

    return {
      time,
      value: sum / usableSubjects.length
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
  metaSubjectsEl.textContent = `Subjects: ${state.subjects.length}`;
  metaMetricsEl.textContent = `Metrics: ${state.metrics.length}`;
  metaSelectedEl.textContent = `Selected: ${getSelectedSubjects().length}`;
}

function renderTable() {
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
      'The selected subjects do not share matching time values for this metric, so no average could be exported in this draft.'
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
    makePlot();
  } catch (error) {
    showError(`${file.name}: ${error.message}`);
  }

  signalFilesInput.value = '';
});

videoFileInput.addEventListener('change', event => {
  const file = event.target.files[0];

  if (!file) {
    return;
  }

  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
  }

  state.videoUrl = URL.createObjectURL(file);
  videoEl.src = state.videoUrl;
});

videoEl.addEventListener('loadedmetadata', () => {
  setCurrentTime(state.currentTime, false);
  makePlot();
});

metricSelectEl.addEventListener('change', () => {
  state.selectedMetric = metricSelectEl.value;
  makePlot();
});

tbody.addEventListener('input', event => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);

  if (!Number.isInteger(index)) {
    return;
  }

  if (action === 'rename') {
    state.subjects[index].subjectId =
      event.target.value.trim() || `Subject ${index + 1}`;

    makePlot();
  }
});

tbody.addEventListener('change', event => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);

  if (!Number.isInteger(index)) {
    return;
  }

  if (action === 'toggle') {
    state.subjects[index].selected = event.target.checked;

    refreshMeta();
    makePlot();
  }
});

tbody.addEventListener('click', event => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);

  if (!Number.isInteger(index)) {
    return;
  }

  if (action === 'remove') {
    state.subjects.splice(index, 1);

    refreshMetrics();
    renderTable();
    makePlot();
  }
});

showIndividualsEl.addEventListener('change', makePlot);
showAverageEl.addEventListener('change', makePlot);

selectAllBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => {
    subject.selected = true;
  });

  renderTable();
  makePlot();
});

selectNoneBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => {
    subject.selected = false;
  });

  renderTable();
  makePlot();
});

downloadAverageBtn.addEventListener('click', exportAverage);

function getMaxPlayableTime() {
  const signalMax =
    typeof getSignalMaxTime === 'function'
      ? getSignalMaxTime(state.selectedMetric) || 0
      : 0;

  const videoMax = Number.isFinite(videoEl.duration)
    ? videoEl.duration
    : 0;

  return Math.max(signalMax, videoMax);
}

function setCurrentTime(nextTime, syncVideo = true) {
  const maxTime = getMaxPlayableTime();
  const time = Math.max(0, Math.min(Number(nextTime) || 0, maxTime));

  state.currentTime = time;

  if (syncVideo && videoEl.currentSrc) {
    const videoTime = Number.isFinite(videoEl.duration)
      ? Math.min(time, videoEl.duration)
      : time;

    videoEl.currentTime = videoTime;
  }

  if (timeLabelEl) {
    timeLabelEl.textContent = `${time.toFixed(2)} s`;
  }

  updateCursor();
}

function tick() {
  /*
    If a video is loaded, the video is the master clock.
    If no video is loaded, keep the current plot cursor where the user placed it.
  */
  if (videoEl.currentSrc) {
    setCurrentTime(videoEl.currentTime || 0, false);
  } else {
    if (timeLabelEl) {
      timeLabelEl.textContent = `${state.currentTime.toFixed(2)} s`;
    }

    updateCursor();
  }

  requestAnimationFrame(tick);
}

refreshMetrics();
renderTable();
makePlot();
tick();
