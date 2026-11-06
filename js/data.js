const TIME_HEADERS = new Set(['time', 'times', 'time_s', 'timesec', 'seconds', 'timestamp', 'tempo', 'tempos']);
const SUBJECT_HEADERS = new Set(['subject', 'subject_id', 'subjectid', 'participant', 'participant_id', 'participantid', 'soggetto', 'soggetto_id']);
let xlsxLoadPromise;

(function (global) {

async function readSignalFile(file, onProgress = () => {}) {
  const extension = file.name.split('.').pop().toLowerCase();

  if (extension === 'xlsx' || extension === 'xls') {
    return readWorkbook(file, onProgress);
  }

  return readDelimitedFile(file, onProgress);
}

function getMetrics(subjects) {
  return [...new Set(subjects.flatMap(subject => subject.metrics))].sort((a, b) => a.localeCompare(b));
}

function getConditions(subjects, metric) {
  const conditions = new Set();

  for (const subject of subjects) {
    for (const condition of Object.keys(subject.dataByMetric[metric] || {})) {
      conditions.add(condition);
    }
  }

  return [...conditions].sort((a, b) => a.localeCompare(b));
}

function getSeries(subject, metric, condition = '') {
  return subject?.dataByMetric?.[metric]?.[condition] || [];
}

function getOutlierFlags(subjects, metric, condition = '', method = 'iqr') {
  const minimumGroupSize = 5;
  const zThreshold = 3.5;
  const minimumDeviatingPoints = 3;
  const minimumDeviatingFraction = 0.1;
  const byTime = new Map();
  const flags = new Map(subjects.map(subject => [subject.id, { status: 'insufficient', tested: 0, deviating: 0 }]));

  if (method === 'none') {
    for (const flag of flags.values()) flag.status = 'disabled';
    return flags;
  }

  for (const subject of subjects) {
    for (const point of getSeries(subject, metric, condition)) {
      if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) continue;
      if (!byTime.has(point.time)) byTime.set(point.time, []);
      byTime.get(point.time).push({ subjectId: subject.id, value: point.value });
    }
  }

  for (const valuesAtTime of byTime.values()) {
    if (valuesAtTime.length < minimumGroupSize) continue;

    const values = valuesAtTime.map(item => item.value);
    const center = median(values);
    const mad = median(values.map(value => Math.abs(value - center)));
    const zeroScaleTolerance = Number.EPSILON * Math.max(1, Math.abs(center)) * 16;
    const firstQuartile = percentile(values, 0.25);
    const thirdQuartile = percentile(values, 0.75);
    const iqr = thirdQuartile - firstQuartile;
    const lowerFence = firstQuartile - 1.5 * iqr;
    const upperFence = thirdQuartile + 1.5 * iqr;

    for (const item of valuesAtTime) {
      const flag = flags.get(item.subjectId);
      flag.tested++;
      const deviation = Math.abs(item.value - center);
      const robustZ = mad > zeroScaleTolerance ? 0.6745 * deviation / mad : deviation > zeroScaleTolerance ? Infinity : 0;
      const isOutlier = method === 'mad'
        ? robustZ > zThreshold
        : item.value < lowerFence || item.value > upperFence;
      if (isOutlier) flag.deviating++;
    }
  }

  for (const flag of flags.values()) {
    const requiredPoints = Math.max(minimumDeviatingPoints, Math.ceil(flag.tested * minimumDeviatingFraction));
    flag.status = flag.tested < minimumDeviatingPoints
      ? 'insufficient'
      : flag.deviating >= requiredPoints
        ? 'flagged'
        : 'within';
    flag.fraction = flag.tested ? flag.deviating / flag.tested : 0;
  }

  return flags;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function computeAverage(subjects, metric, condition = '') {
  const seriesList = subjects
    .filter(subject => subject.selected)
    .map(subject => getSeries(subject, metric, condition))
    .filter(series => series.length > 0);

  if (!seriesList.length) return [];

  const valuesByTime = seriesList.map(series => new Map(series.map(point => [point.time, point.value])));
  const commonTimes = [...valuesByTime[0].keys()]
    .filter(time => valuesByTime.every(values => values.has(time)))
    .sort((a, b) => a - b);

  return commonTimes.map(time => {
    const values = valuesByTime.map(byTime => byTime.get(time));
    const value = values.reduce((sum, current) => sum + current, 0) / values.length;
    const squaredError = values.reduce((sum, current) => sum + (current - value) ** 2, 0);
    const standardError = values.length > 1
      ? Math.sqrt(squaredError / (values.length - 1) / values.length)
      : 0;
    const margin = standardError * tCritical95(values.length - 1);

    return {
      time,
      value,
      lower: values.length > 1 ? value - margin : null,
      upper: values.length > 1 ? value + margin : null,
      n: values.length
    };
  });
}

function tCritical95(degreesOfFreedom) {
  const criticalValues = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    2.021, 2.000, 1.980, 1.960
  ];
  const degrees = [...Array.from({ length: 30 }, (_, index) => index + 1), 40, 60, 120, Infinity];
  const index = degrees.findIndex(degree => degreesOfFreedom <= degree);
  return criticalValues[index === -1 ? criticalValues.length - 1 : index];
}

async function readDelimitedFile(file, onProgress) {
  onProgress('Lettura del file di testo…');
  const text = await file.text();
  const delimiter = detectDelimiter(text.slice(0, 5000), file.name);
  const rows = await parseDelimitedText(text, delimiter);

  if (rows.length < 2) {
    throw new Error('Il file deve contenere un’intestazione e almeno una riga di dati.');
  }

  const headers = rows[0].map(value => value.trim());
  const timeIndex = findHeader(headers, TIME_HEADERS);
  const subjectIndex = findHeader(headers, SUBJECT_HEADERS);

  if (timeIndex === -1 || subjectIndex === -1) {
    throw new Error('Il file deve essere in formato long e contenere time_s e subject_id.');
  }

  const metricIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ index }) => index !== timeIndex && index !== subjectIndex && headers[index]);

  if (!metricIndexes.length) {
    throw new Error('Non sono state trovate colonne metriche.');
  }

  const subjects = new Map();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    if (rowIndex > 1 && rowIndex % 1000 === 0) await yieldToBrowser();
    const row = rows[rowIndex];
    if (row.length !== headers.length) continue;

    const subjectId = String(row[subjectIndex] || '').trim();
    const time = parseTime(row[timeIndex]);
    if (!subjectId || !Number.isFinite(time)) continue;

    for (const { header: metric, index } of metricIndexes) {
      const value = parseNumber(row[index]);
      if (!Number.isFinite(value)) continue;
      addPoint(subjects, subjectId, metric, '', { time, value });
    }
  }

  return finalizeDataset(subjects, { format: 'long', sourceName: file.name });
}

async function readWorkbook(file, onProgress) {
  onProgress('Caricamento del lettore Excel…');
  const xlsx = await loadSheetJs();

  let workbook;
  try {
    onProgress('Apertura del workbook…');
    await yieldToBrowser();
    const bytes = new Uint8Array(await file.arrayBuffer());
    workbook = xlsx.read(bytes, { type: 'array', cellDates: false });
  } catch {
    throw new Error('Il file Excel non è valido o non può essere letto.');
  }

  const subjects = new Map();
  const skippedSheets = [];

  for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex++) {
    const sheetName = workbook.SheetNames[sheetIndex];
    if (sheetIndex % 2 === 0) {
      onProgress(`Analisi dei fogli: ${sheetIndex + 1} di ${workbook.SheetNames.length}…`);
      await yieldToBrowser();
    }
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false
    });

    const headerIndex = rows.findIndex(row => findHeader(row, TIME_HEADERS) !== -1);
    if (headerIndex === -1) {
      if (rows.some(row => row.some(value => value !== null && value !== ''))) skippedSheets.push(sheetName);
      continue;
    }

    const headers = rows[headerIndex];
    const timeIndex = findHeader(headers, TIME_HEADERS);
    const subjectColumns = headers
      .map((header, index) => ({ header: String(header ?? '').trim(), index }))
      .filter(({ header, index }) => header && index !== timeIndex);

    if (!subjectColumns.length) {
      skippedSheets.push(sheetName);
      continue;
    }

    const { metric, condition } = parseSheetName(sheetName);
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
      if (rowIndex > headerIndex + 1 && rowIndex % 500 === 0) await yieldToBrowser();
      const row = rows[rowIndex];
      const time = parseTime(row[timeIndex]);
      if (!Number.isFinite(time)) continue;

      for (const { header: subjectId, index } of subjectColumns) {
        const value = parseNumber(row[index]);
        if (!Number.isFinite(value)) continue;
        addPoint(subjects, subjectId, metric, condition, { time, value });
      }
    }
  }

  if (!subjects.size) {
    const detail = skippedSheets.length
      ? ` Nessun foglio contiene una colonna tempo riconoscibile (per esempio “Time [s]”).`
      : '';
    throw new Error(`Non sono state trovate serie temporali valide nel workbook.${detail}`);
  }

  onProgress('Finalizzazione delle serie…');
  await yieldToBrowser();
  return finalizeDataset(subjects, {
    format: 'workbook',
    sourceName: file.name,
    skippedSheets
  });
}

function loadSheetJs() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  if (xlsxLoadPromise) return xlsxLoadPromise;

  xlsxLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    script.onload = () => {
      if (globalThis.XLSX) resolve(globalThis.XLSX);
      else {
        xlsxLoadPromise = null;
        reject(new Error('Il lettore XLSX non è stato inizializzato.'));
      }
    };
    script.onerror = () => {
      xlsxLoadPromise = null;
      reject(new Error('Non è stato possibile caricare il lettore XLSX. Controlla la connessione e riprova.'));
    };
    document.head.append(script);
  });

  return xlsxLoadPromise;
}

function parseSheetName(sheetName) {
  const separator = sheetName.indexOf('@');
  if (separator === -1) return { metric: sheetName.trim(), condition: '' };

  const metric = sheetName.slice(0, separator).trim();
  const condition = sheetName
    .slice(separator + 1)
    .trim()
    .replace(/^['“”"]|['“”"]$/g, '')
    .trim();

  return { metric, condition };
}

function addPoint(subjects, subjectId, metric, condition, point) {
  if (!subjects.has(subjectId)) {
    subjects.set(subjectId, {
      id: makeId(),
      subjectId,
      selected: true,
      dataByMetric: Object.create(null)
    });
  }

  const subject = subjects.get(subjectId);
  subject.dataByMetric[metric] ??= Object.create(null);
  subject.dataByMetric[metric][condition] ??= [];
  subject.dataByMetric[metric][condition].push(point);
}

function finalizeDataset(subjectMap, metadata) {
  const subjects = [...subjectMap.values()];

  for (const subject of subjects) {
    subject.metrics = Object.keys(subject.dataByMetric).sort((a, b) => a.localeCompare(b));
    const allSeries = Object.values(subject.dataByMetric).flatMap(byCondition => Object.values(byCondition));
    subject.points = Math.max(0, ...allSeries.map(series => series.length));
    const times = allSeries.flatMap(series => series.map(point => point.time));
    subject.minT = times.length ? Math.min(...times) : '';
    subject.maxT = times.length ? Math.max(...times) : '';

    for (const byCondition of Object.values(subject.dataByMetric)) {
      for (const series of Object.values(byCondition)) {
        series.sort((a, b) => a.time - b.time);
      }
    }
  }

  if (!subjects.length) throw new Error('Non sono stati trovati dati validi nel file.');
  return { subjects, ...metadata };
}

function findHeader(headers, candidates) {
  return headers.findIndex(header => candidates.has(normalizeHeader(header)));
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function parseTime(value) {
  return parseNumber(value);
}

function detectDelimiter(text, filename) {
  if (filename.toLowerCase().endsWith('.tsv')) return '\t';

  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', '\t', ';'].map(delimiter => countOutsideQuotes(firstLine, delimiter));
  const index = counts.indexOf(Math.max(...counts));
  return [',', '\t', ';'][index];
}

function countOutsideQuotes(text, delimiter) {
  let count = 0;
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (text[index] === delimiter && !quoted) {
      count++;
    }
  }

  return count;
}

async function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    if (index > 0 && index % 100000 === 0) await yieldToBrowser();
    const character = text[index];
    const next = text[index + 1];

    if (character === '"') {
      if (quoted && next === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index++;
      row.push(value.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  row.push(value.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `subject-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function yieldToBrowser() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

global.TimeSeriesData = Object.freeze({ readSignalFile, getMetrics, getConditions, getSeries, getOutlierFlags, computeAverage });
})(globalThis);
