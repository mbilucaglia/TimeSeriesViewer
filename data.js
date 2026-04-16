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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function detectDelimiter(text, filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tsv')) return '\t';

  const commas = (text.match(/,/g) || []).length;
  const tabs = (text.match(/\t/g) || []).length;
  const semis = (text.match(/;/g) || []).length;

  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

function parseTable(text, delimiter) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) throw new Error('File needs a header row and at least one data row.');

  const headers = lines[0].split(delimiter).map(v => v.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map(v => v.trim());
    if (cols.length !== headers.length) continue;

    const row = {};
    headers.forEach((h, j) => row[h] = cols[j]);
    rows.push(row);
  }

  return { headers, rows };
}

function normalizeMetricName(name) {
  return String(name).trim();
}

function buildSubject(subjectId, filename, dataByMetric) {
  const metrics = Object.keys(dataByMetric);
  const firstMetric = metrics[0];
  const points = firstMetric ? dataByMetric[firstMetric].length : 0;
  const firstSeries = firstMetric ? dataByMetric[firstMetric] : [];

  return {
    id: crypto.randomUUID(),
    filename,
    subjectId,
    selected: true,
    metrics,
    dataByMetric,
    points,
    minT: firstSeries[0]?.time ?? '',
    maxT: firstSeries[firstSeries.length - 1]?.time ?? ''
  };
}

function parseLongFormat(headers, rows, filename) {
  const lowerMap = Object.fromEntries(headers.map(h => [h.toLowerCase(), h]));
  const timeCol = lowerMap['time_s'] || lowerMap['time'] || headers[0];
  const subjectCol = lowerMap['subject_id'] || lowerMap['subject'] || headers[1];
  if (!timeCol || !subjectCol) throw new Error('Long format needs time and subject_id columns.');

  const metricCols = headers.filter(h => h !== timeCol && h !== subjectCol);
  if (!metricCols.length) throw new Error('No metric columns found.');

  const grouped = new Map();

  for (const row of rows) {
    const subjectId = String(row[subjectCol] || '').trim();
    const t = Number(row[timeCol]);
    if (!subjectId || !Number.isFinite(t)) continue;

    if (!grouped.has(subjectId)) grouped.set(subjectId, {});
    const metricMap = grouped.get(subjectId);

    for (const metric of metricCols) {
      const val = Number(row[metric]);
      if (!Number.isFinite(val)) continue;
      if (!metricMap[metric]) metricMap[metric] = [];
      metricMap[metric].push({ time: t, value: val });
    }
  }

  const subjects = [];
  for (const [subjectId, dataByMetric] of grouped.entries()) {
    for (const metric of Object.keys(dataByMetric)) {
      dataByMetric[metric].sort((a, b) => a.time - b.time);
    }
    subjects.push(buildSubject(subjectId, filename, dataByMetric));
  }

  return subjects;
}

function parseWidePerSubject(headers, rows, filename) {
  const timeCol = headers[0];
  const metricCols = headers.slice(1).map(normalizeMetricName).filter(Boolean);
  if (!metricCols.length) throw new Error('Per-subject files need at least one metric column after time.');

  const dataByMetric = {};
  for (const metric of metricCols) dataByMetric[metric] = [];

  for (const row of rows) {
    const t = Number(row[timeCol]);
    if (!Number.isFinite(t)) continue;

    for (const metric of metricCols) {
      const val = Number(row[metric]);
      if (Number.isFinite(val)) dataByMetric[metric].push({ time: t, value: val });
    }
  }

  for (const metric of metricCols) {
    dataByMetric[metric].sort((a, b) => a.time - b.time);
  }

  const subjectId = filename.replace(/\.[^.]+$/, '');
  return [buildSubject(subjectId, filename, dataByMetric)];
}

async function readSignalFile(file) {
  const text = await file.text();
  const delimiter = detectDelimiter(text.slice(0, 2000), file.name);
  const { headers, rows } = parseTable(text, delimiter);
  const lowerHeaders = headers.map(h => h.toLowerCase());
  const isLong = lowerHeaders.includes('subject_id') || lowerHeaders.includes('subject');

  return isLong ? parseLongFormat(headers, rows, file.name) : parseWidePerSubject(headers, rows, file.name);
}

function getSelectedSubjects() {
  return state.subjects.filter(s => s.selected);
}

function getSeries(subject, metric) {
  return subject.dataByMetric[metric] || [];
}

function intersectTimes(selected, metric) {
  const valid = selected.filter(s => getSeries(s, metric).length);
  if (!valid.length) return [];

  let common = new Set(valid[0].dataByMetric[metric].map(d => d.time));
  for (let i = 1; i < valid.length; i++) {
    const set = new Set(valid[i].dataByMetric[metric].map(d => d.time));
    common = new Set([...common].filter(t => set.has(t)));
  }

  return [...common].sort((a, b) => a - b);
}

function computeAverage(selected, metric) {
  const usable = selected.filter(s => getSeries(s, metric).length);
  const times = intersectTimes(usable, metric);

  return times.map(t => {
    let sum = 0;
    for (const subject of usable) {
      const point = subject.dataByMetric[metric].find(d => d.time === t);
      sum += point.value;
    }
    return { time: t, value: sum / usable.length };
  });
}

function refreshMetrics() {
  const metricSet = new Set();
  state.subjects.forEach(s => s.metrics.forEach(m => metricSet.add(m)));
  state.metrics = [...metricSet];

  if (!state.metrics.includes(state.selectedMetric)) {
    state.selectedMetric = state.metrics[0] || '';
  }

  metricSelectEl.innerHTML = state.metrics.map(m =>
    `<option value="${escapeAttr(m)}" ${m === state.selectedMetric ? 'selected' : ''}>${escapeHtml(m)}</option>`
  ).join('');
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
      <td><input type="checkbox" ${subject.selected ? 'checked' : ''} data-action="toggle" data-index="${index}" /></td>
      <td>${escapeHtml(subject.filename)}</td>
      <td><input type="text" value="${escapeAttr(subject.subjectId)}" data-action="rename" data-index="${index}" /></td>
      <td>${escapeHtml(subject.metrics.join(', '))}</td>
      <td>${subject.points}</td>
      <td>${subject.minT} – ${subject.maxT}</td>
      <td><button data-action="remove" data-index="${index}">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  refreshMeta();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportAverage() {
  const selected = getSelectedSubjects();
  const metric = state.selectedMetric;

  if (!selected.length || !metric) {
    errorsEl.textContent = 'Select at least one subject and one metric before exporting the average.';
    return;
  }

  const avg = computeAverage(selected, metric);
  if (!avg.length) {
    errorsEl.textContent = 'The selected subjects do not share matching time values for this metric, so no average could be exported in this draft.';
    return;
  }

  const csv = [`time,mean_${metric}`, ...avg.map(d => `${d.time},${d.value}`)].join('\n');
  downloadText(`average_${metric}.csv`, csv);
  errorsEl.textContent = '';
}

signalFilesInput.addEventListener('change', async (event) => {
  errorsEl.textContent = '';
  const files = [...event.target.files];
  const added = [];
  const errors = [];

  for (const file of files) {
    try {
      const result = await readSignalFile(file);
      added.push(...result);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  state.subjects.push(...added);
  refreshMetrics();
  renderTable();
  makePlot();

  errorsEl.textContent = errors.join('\n');
  signalFilesInput.value = '';
});

videoFileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  videoEl.src = state.videoUrl;
});

metricSelectEl.addEventListener('change', () => {
  state.selectedMetric = metricSelectEl.value;
  makePlot();
});

tbody.addEventListener('input', (event) => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);
  if (!Number.isInteger(index)) return;

  if (action === 'rename') {
    state.subjects[index].subjectId = event.target.value.trim() || state.subjects[index].filename;
    makePlot();
  }
});

tbody.addEventListener('change', (event) => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);
  if (!Number.isInteger(index)) return;

  if (action === 'toggle') {
    state.subjects[index].selected = event.target.checked;
    refreshMeta();
    makePlot();
  }
});

tbody.addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  const index = Number(event.target.dataset.index);
  if (!Number.isInteger(index)) return;

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
  state.subjects.forEach(s => s.selected = true);
  renderTable();
  makePlot();
});

selectNoneBtn.addEventListener('click', () => {
  state.subjects.forEach(s => s.selected = false);
  renderTable();
  makePlot();
});

downloadAverageBtn.addEventListener('click', exportAverage);

function tick() {
  state.currentTime = videoEl.currentTime || 0;
  updateCursor();
  requestAnimationFrame(tick);
}

refreshMetrics();
renderTable();
makePlot();
tick();