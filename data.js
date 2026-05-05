/*
  ============================================================
  FILE: data.js

  This file controls DATA and USER INTERACTIONS.

  Main responsibilities:
  1. Store the app state.
  2. Read the uploaded signal file.
  3. Parse CSV/TXT/TSV data.
  4. Build the subject table.
  5. Compute the average trace.
  6. Handle video upload.
  7. Keep video time and plot time synchronized.

  Important idea:
  ALL time changes go through setCurrentTime().
  ============================================================
*/


/* ============================================================
   BLOCK 1: GLOBAL APP STATE

   This object stores the current situation of the app.

   Other functions read/write this object.
   ============================================================ */

const state = {
  // Array of subject objects created after reading the signal file.
  subjects: [],

  // Browser object URL for the uploaded video.
  videoUrl: null,

  // Current synchronized time in seconds.
  currentTime: 0,

  // List of metric names detected in the signal file.
  metrics: [],

  // Metric currently selected in the dropdown.
  selectedMetric: ''
};


/* ============================================================
   BLOCK 2: HTML ELEMENT REFERENCES

   These variables connect JavaScript to elements in index.html.

   Example:
   videoEl points to <video id="video"></video>
   ============================================================ */

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


/* ============================================================
   BLOCK 3: SMALL HELPER FUNCTIONS
   ============================================================ */

/*
  Create a unique ID for each subject row.

  crypto.randomUUID() is modern and good.
  The fallback keeps the app working in older browsers.
*/
function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/*
  Escape text before inserting it into HTML.

  This prevents broken HTML if a subject name contains characters like:
  <, >, &, ", '
*/
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/*
  Same idea as escapeHtml().
  Kept separate because it makes the code easier to understand.
*/
function escapeAttr(value) {
  return escapeHtml(value);
}

/*
  Show or clear an error message.
*/
function showError(message) {
  errorsEl.textContent = message || '';
}


/* ============================================================
   BLOCK 4: FILE FORMAT DETECTION

   The signal file can be:
   - CSV: comma-separated
   - TSV: tab-separated
   - TXT: comma, tab, or semicolon-separated

   This function guesses the delimiter.
   ============================================================ */

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


/* ============================================================
   BLOCK 5: CSV / TSV PARSER

   This parser reads rows and columns.

   Why not just use line.split(",")?
   Because CSV files can contain quoted values such as:
   "Subject, 01"

   This simple parser supports:
   - commas / tabs / semicolons
   - quoted values
   - escaped quotes inside quoted values
   ============================================================ */

function parseDelimitedText(text, delimiter) {
  const rows = [];

  let currentRow = [];
  let currentValue = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    // Handle quote characters.
    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Two quotes inside quoted text mean one literal quote.
        currentValue += '"';
        i++;
      } else {
        // Enter or exit quoted mode.
        insideQuotes = !insideQuotes;
      }

      continue;
    }

    // Handle delimiter, but only when not inside quotes.
    if (char === delimiter && !insideQuotes) {
      currentRow.push(currentValue.trim());
      currentValue = '';
      continue;
    }

    // Handle new line, but only when not inside quotes.
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

  // Add the final value and final row.
  currentRow.push(currentValue.trim());

  if (currentRow.some(value => value.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}


/*
  Convert parsed rows into:
  - headers: array of column names
  - rows: array of objects

  Example output row:
  {
    time_s: "0.01",
    subject_id: "S01",
    speed: "1.23"
  }
*/
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

    // Skip malformed rows.
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


/* ============================================================
   BLOCK 6: CONVERT TABLE DATA INTO SUBJECT DATA

   Expected long-format file:

   time_s,subject_id,speed,angle
   0.00,S01,1.2,35
   0.01,S01,1.3,36
   0.00,S02,1.1,34
   0.01,S02,1.2,35

   The app converts this into subjects:

   subject S01:
     speed: [{time: 0, value: 1.2}, ...]
     angle: [{time: 0, value: 35}, ...]

   subject S02:
     speed: ...
     angle: ...
   ============================================================ */

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
  /*
    Make column names easier to find.

    Example:
    "time_s" -> original column name
    "subject_id" -> original column name
  */
  const lowerMap = Object.fromEntries(
    headers.map(header => [header.toLowerCase(), header])
  );

  const timeCol = lowerMap.time_s || lowerMap.time || headers[0];
  const subjectCol = lowerMap.subject_id || lowerMap.subject || headers[1];

  if (!timeCol || !subjectCol) {
    throw new Error('Long format needs time_s and subject_id columns.');
  }

  // Every column except time and subject is treated as a metric.
  const metricCols = headers.filter(
    header => header !== timeCol && header !== subjectCol
  );

  if (!metricCols.length) {
    throw new Error('No metric columns found.');
  }

  /*
    grouped is a Map.

    Structure:
    grouped.get("S01") = {
      speed: [{time, value}, ...],
      angle: [{time, value}, ...]
    }
  */
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
    // Sort every metric by time.
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


/*
  Read one uploaded signal file and return subject objects.
*/
async function readSignalFile(file) {
  const text = await file.text();
  const delimiter = detectDelimiter(text.slice(0, 2000), file.name);
  const { headers, rows } = parseTable(text, delimiter);

  const lowerHeaders = headers.map(header => header.toLowerCase());

  const isLongFormat =
    lowerHeaders.includes('subject_id') ||
    lowerHeaders.includes('subject');

  if (!isLongFormat) {
    throw new Error(
      'This version accepts only one long-format file with time_s, subject_id, and metric columns.'
    );
  }

  return parseLongFormat(headers, rows);
}


/* ============================================================
   BLOCK 7: DATA ACCESS HELPERS

   These functions are also used by plot.js.
   ============================================================ */

function getSelectedSubjects() {
  return state.subjects.filter(subject => subject.selected);
}


function getSeries(subject, metric) {
  if (!subject || !metric) {
    return [];
  }

  return subject.dataByMetric[metric] || [];
}


/* ============================================================
   BLOCK 8: AVERAGE CALCULATION

   Current limitation:
   The average uses only time points that exist in all selected subjects.

   Example:
   S01: 0.00, 0.01, 0.02
   S02: 0.00, 0.01, 0.02
   OK.

   But:
   S01: 0.00, 0.01, 0.02
   S02: 0.005, 0.015, 0.025
   No exact shared times, so average is empty.

   Later improvement:
   Add interpolation.
   ============================================================ */

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

  /*
    Create lookup maps so we do not repeatedly search arrays.
    This is faster than calling .find() for every point.
  */
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


/* ============================================================
   BLOCK 9: UI REFRESH FUNCTIONS

   These functions update the visible page after data changes.
   ============================================================ */

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


/*
  Rebuild the subject table.

  This is called after:
  - loading data
  - selecting all
  - selecting none
  - removing a subject
*/
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


/* ============================================================
   BLOCK 10: EXPORT AVERAGE CSV
   ============================================================ */

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


/* ============================================================
   BLOCK 11: TIME / SYNCHRONIZATION FUNCTIONS

   This is one of the most important blocks.

   Design rule:
   Every time change goes through setCurrentTime().

   Video -> plot:
   setCurrentTime(video.currentTime, false)

   Plot -> video:
   setCurrentTime(clickedOrDraggedTime, true)
   ============================================================ */

/*
  Fallback duration based on the loaded signal data.

  plot.js also has getSignalMaxTime().
  This fallback keeps data.js robust.
*/
function getDataMaxTime(metric) {
  let maxT = 0;

  for (const subject of getSelectedSubjects()) {
    const series = getSeries(subject, metric);

    if (!series.length) {
      continue;
    }

    const lastT = series[series.length - 1].time;

    if (Number.isFinite(lastT)) {
      maxT = Math.max(maxT, lastT);
    }
  }

  return maxT;
}


/*
  This is the maximum duration used for synchronization.

  It uses the larger of:
  - signal duration
  - video duration

  This prevents the plot cursor from freezing if the video is longer
  than the signal.
*/
function getMaxPlayableTime() {
  const signalMax =
    typeof getSignalMaxTime === 'function'
      ? getSignalMaxTime(state.selectedMetric) || 0
      : getDataMaxTime(state.selectedMetric) || 0;

  const videoMax = Number.isFinite(videoEl.duration)
    ? videoEl.duration
    : 0;

  return Math.max(signalMax, videoMax);
}


/*
  Central synchronized time setter.

  Parameters:
  - nextTime: new time in seconds
  - syncVideo:
      true  = also seek the video
      false = do not seek the video, only update app/plot state

  Why syncVideo can be false:
  When the video is already playing, we read video.currentTime.
  We should not immediately set video.currentTime to the same value again.
*/
function setCurrentTime(nextTime, syncVideo = true) {
  const maxTime = getMaxPlayableTime();
  const numericTime = Number(nextTime) || 0;

  const time = maxTime > 0
    ? Math.max(0, Math.min(numericTime, maxTime))
    : Math.max(0, numericTime);

  state.currentTime = time;

  /*
    Plot -> video.

    This happens when:
    - user clicks the main plot
    - user drags the lower cursor
    - user presses arrow keys while cursor is focused
  */
  if (syncVideo && videoEl.currentSrc) {
    const videoTime = Number.isFinite(videoEl.duration)
      ? Math.min(time, videoEl.duration)
      : time;

    /*
      Avoid tiny repeated currentTime assignments.
      This prevents jitter.
    */
    if (Math.abs((videoEl.currentTime || 0) - videoTime) > 0.002) {
      videoEl.currentTime = videoTime;
    }
  }

  // Update the visible time label.
  timeLabelEl.textContent = `${time.toFixed(2)} s`;

  // Ask plot.js to update both the HTML cursor and Plotly vertical line.
  if (typeof updateCursor === 'function') {
    updateCursor();
  }
}


/* ============================================================
   BLOCK 12: VIDEO SYNCHRONIZATION LOOP

   The browser's timeupdate event is not always smooth enough for
   an animated cursor, so while the video is playing we use
   requestAnimationFrame().
   ============================================================ */

let videoSyncAnimationId = null;


function startVideoSyncLoop() {
  if (videoSyncAnimationId !== null) {
    return;
  }

  function frame() {
    /*
      Video -> plot.

      The video is already moving, so syncVideo is false.
    */
    setCurrentTime(videoEl.currentTime || 0, false);

    if (!videoEl.paused && !videoEl.ended) {
      videoSyncAnimationId = requestAnimationFrame(frame);
    } else {
      videoSyncAnimationId = null;
    }
  }

  videoSyncAnimationId = requestAnimationFrame(frame);
}


function stopVideoSyncLoop() {
  if (videoSyncAnimationId !== null) {
    cancelAnimationFrame(videoSyncAnimationId);
    videoSyncAnimationId = null;
  }
}


/* ============================================================
   BLOCK 13: EVENT LISTENERS - FILE UPLOADS
   ============================================================ */

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
    setCurrentTime(state.currentTime, false);
  } catch (error) {
    showError(`${file.name}: ${error.message}`);
  }

  /*
    Reset input value so the same file can be selected again later.
  */
  signalFilesInput.value = '';
});


videoFileInput.addEventListener('change', event => {
  const file = event.target.files[0];

  if (!file) {
    return;
  }

  /*
    If a previous video was loaded, release its object URL.
  */
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
  }

  state.videoUrl = URL.createObjectURL(file);
  videoEl.src = state.videoUrl;
});


/* ============================================================
   BLOCK 14: EVENT LISTENERS - VIDEO

   These keep the plot synchronized when the user uses native
   video controls such as play, pause, scrub, or seek.
   ============================================================ */

videoEl.addEventListener('loadedmetadata', () => {
  setCurrentTime(state.currentTime, false);
  makePlot();
});


videoEl.addEventListener('timeupdate', () => {
  setCurrentTime(videoEl.currentTime || 0, false);
});


videoEl.addEventListener('seeked', () => {
  setCurrentTime(videoEl.currentTime || 0, false);
});


videoEl.addEventListener('play', () => {
  startVideoSyncLoop();
});


videoEl.addEventListener('pause', () => {
  stopVideoSyncLoop();
  setCurrentTime(videoEl.currentTime || 0, false);
});


videoEl.addEventListener('ended', () => {
  stopVideoSyncLoop();
  setCurrentTime(videoEl.currentTime || 0, false);
});


/* ============================================================
   BLOCK 15: EVENT LISTENERS - CONTROLS
   ============================================================ */

metricSelectEl.addEventListener('change', () => {
  state.selectedMetric = metricSelectEl.value;
  makePlot();
  setCurrentTime(state.currentTime, false);
});


showIndividualsEl.addEventListener('change', () => {
  makePlot();
  setCurrentTime(state.currentTime, false);
});


showAverageEl.addEventListener('change', () => {
  makePlot();
  setCurrentTime(state.currentTime, false);
});


selectAllBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => {
    subject.selected = true;
  });

  renderTable();
  makePlot();
  setCurrentTime(state.currentTime, false);
});


selectNoneBtn.addEventListener('click', () => {
  state.subjects.forEach(subject => {
    subject.selected = false;
  });

  renderTable();
  makePlot();
  setCurrentTime(state.currentTime, false);
});


downloadAverageBtn.addEventListener('click', exportAverage);


/* ============================================================
   BLOCK 16: EVENT LISTENERS - SUBJECT TABLE

   The table uses event delegation:
   instead of adding a listener to every row/button/input,
   we listen once on tbody and inspect data-action.
   ============================================================ */

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
    setCurrentTime(state.currentTime, false);
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
    setCurrentTime(state.currentTime, false);
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
    setCurrentTime(state.currentTime, false);
  }
});


/* ============================================================
   BLOCK 17: INITIAL APP SETUP

   This runs once when the page loads.
   ============================================================ */

refreshMetrics();
renderTable();
makePlot();
setCurrentTime(0, false);
