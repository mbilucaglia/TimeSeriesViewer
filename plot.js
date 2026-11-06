(function (global) {
const { computeAverage, getSeries } = global.TimeSeriesData;

function createPlot({ element, getState, getSelectedSubjects, getMaxPlayableTime, setCurrentTime }) {
  let relayoutAt = 0;
  let relayoutInFlight = false;
  let relayoutPending = false;

  const selectedMaxTime = () => getSelectedSubjects().reduce((maxTime, subject) => {
    const series = getSeries(subject, getState().selectedMetric, getState().selectedCondition);
    return series.length ? Math.max(maxTime, series.at(-1).time) : maxTime;
  }, 0);

  const maxTime = () => Math.max(selectedMaxTime(), getMaxPlayableTime());

  function clampTime(value) {
    const time = Number(value);
    if (!Number.isFinite(time)) return 0;
    const upperBound = maxTime();
    return upperBound > 0 ? Math.max(0, Math.min(time, upperBound)) : Math.max(0, time);
  }

  function buildTraces() {
    const state = getState();
    const subjects = getSelectedSubjects();
    const traces = [];

    if (state.showIndividuals) {
      for (const subject of subjects) {
        const series = getSeries(subject, state.selectedMetric, state.selectedCondition);
        if (!series.length) continue;

        traces.push({
          x: series.map(point => point.time),
          y: series.map(point => point.value),
          mode: 'lines',
          type: 'scattergl',
          name: subject.subjectId,
          opacity: 0.42,
          legendgroup: `subject-${subject.id}`
        });
      }
    }

    if (state.showAverage) {
      const average = computeAverage(subjects, state.selectedMetric, state.selectedCondition);
      const confidencePoints = average.filter(point => point.lower !== null && point.upper !== null);

      if (confidencePoints.length) {
        const x = confidencePoints.map(point => point.time);
        const boundary = { color: '#312b79', width: 2, dash: 'dot' };
        traces.push({
          x,
          y: confidencePoints.map(point => point.lower),
          mode: 'lines',
          type: 'scatter',
          line: boundary,
          hoverinfo: 'skip',
          showlegend: false,
          legendgroup: 'summary',
          zorder: 10
        });
        traces.push({
          x,
          y: confidencePoints.map(point => point.upper),
          mode: 'lines',
          type: 'scatter',
          line: boundary,
          fill: 'tonexty',
          fillcolor: 'rgba(49, 43, 121, 0.24)',
          name: 'IC 95%',
          hoverinfo: 'skip',
          showlegend: true,
          legendgroup: 'summary',
          zorder: 10
        });
      }

      if (average.length) {
        traces.push({
          x: average.map(point => point.time),
          y: average.map(point => point.value),
          mode: 'lines',
          type: 'scatter',
          name: 'Media',
          line: { color: '#312b79', width: 3.5 },
          legendgroup: 'summary',
          zorder: 11
        });
      }
    }

    return traces;
  }

  function getGeometry() {
    const fullLayout = element._fullLayout;
    if (!fullLayout?.xaxis || !fullLayout?.yaxis) return null;

    const rect = element.getBoundingClientRect();
    const xaxis = fullLayout.xaxis;
    const yaxis = fullLayout.yaxis;
    return {
      xaxis,
      left: rect.left + xaxis._offset,
      right: rect.left + xaxis._offset + xaxis._length,
      top: rect.top + yaxis._offset,
      bottom: rect.top + yaxis._offset + yaxis._length
    };
  }

  function seekFromPlotClick(event) {
    if (event.target.closest('.rangeslider-container, .shapelayer')) return;
    const geometry = getGeometry();
    if (!geometry || event.clientY < geometry.top || event.clientY > geometry.bottom) return;
    if (event.clientX < geometry.left || event.clientX > geometry.right) return;

    const [x0, x1] = geometry.xaxis.range.map(Number);
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || geometry.right <= geometry.left) return;
    const fraction = (event.clientX - geometry.left) / (geometry.right - geometry.left);
    setCurrentTime(clampTime(x0 + fraction * (x1 - x0)), true);
  }

  function handleRelayout(update) {
    const shapeTime = update['shapes[0].x0'] ?? update['shapes[0].x1'];
    if (Number.isFinite(Number(shapeTime)) && Math.abs(Number(shapeTime) - getState().currentTime) > 0.002) {
      setCurrentTime(Number(shapeTime), true);
    }
  }

  function attachInteractions() {
    if (element.__timeSeriesInteractionsAttached) return;
    element.addEventListener('click', seekFromPlotClick);
    element.on('plotly_relayout', handleRelayout);
    element.__timeSeriesInteractionsAttached = true;
  }

  async function render() {
    const state = getState();
    const duration = maxTime();
    const safeTime = clampTime(state.currentTime);
    if (safeTime !== state.currentTime) state.currentTime = safeTime;

    const layout = {
      title: state.selectedMetric
        ? `${state.selectedMetric}${state.selectedCondition ? ` — ${state.selectedCondition}` : ''}`
        : 'Carica un file di segnali per iniziare',
      template: 'plotly_white',
      colorway: ['#7470aa', '#355f95', '#13736d', '#9a6e8e', '#b27638'],
      font: { family: 'Inter, Segoe UI, Arial, sans-serif', color: '#4e4c70' },
      hovermode: 'x unified',
      dragmode: false,
      uirevision: `${state.selectedMetric}:${state.selectedCondition}`,
      xaxis: {
        title: 'Tempo (s)',
        range: duration > 0 ? [0, duration] : undefined,
        rangeslider: { visible: true, thickness: 0.16 },
        gridcolor: '#e7e5f1'
      },
      yaxis: { title: state.selectedMetric || 'Valore', fixedrange: true, gridcolor: '#e7e5f1' },
      shapes: [{
        type: 'line',
        x0: safeTime,
        x1: safeTime,
        y0: 0,
        y1: 1,
        yref: 'paper',
        editable: true,
        line: { color: '#312b79', width: 2, dash: 'dot' }
      }],
      height: 500,
      margin: { l: 60, r: 20, t: 52, b: 78 }
    };

    const config = {
      responsive: true,
      displaylogo: false,
      scrollZoom: false,
      edits: { shapePosition: true },
      modeBarButtonsToRemove: [
        'zoom2d', 'pan2d', 'select2d', 'lasso2d', 'zoomIn2d', 'zoomOut2d', 'autoScale2d', 'resetScale2d'
      ]
    };

    if (element._fullLayout) {
      await globalThis.Plotly.react(element, buildTraces(), layout, config);
    } else {
      await globalThis.Plotly.newPlot(element, buildTraces(), layout, config);
    }

    attachInteractions();
  }

  function cursorUpdate() {
    const state = getState();
    const duration = maxTime();
    if (!element._fullLayout || duration <= 0) return null;

    const time = clampTime(state.currentTime);
    const update = {
      'shapes[0].x0': time,
      'shapes[0].x1': time
    };
    const xaxis = element._fullLayout.xaxis;
    const range = xaxis?.range?.map(Number);

    if (range && range[1] > range[0]) {
      const windowSize = range[1] - range[0];
      if (windowSize < duration - 0.001 && (time < range[0] || time > range[1])) {
        const start = Math.max(0, Math.min(time - windowSize / 2, duration - windowSize));
        update['xaxis.range[0]'] = start;
        update['xaxis.range[1]'] = start + windowSize;
      }
    }

    return update;
  }

  function updateCursor(force = false) {
    const now = performance.now();
    if (!force && now - relayoutAt < 33) {
      relayoutPending = true;
      return;
    }
    if (relayoutInFlight) {
      relayoutPending = true;
      return;
    }

    const update = cursorUpdate();
    if (!update) return;
    relayoutAt = now;
    relayoutInFlight = true;

    globalThis.Plotly.relayout(element, update)
      .catch(() => {})
      .finally(() => {
        relayoutInFlight = false;
        if (relayoutPending) {
          relayoutPending = false;
          updateCursor(true);
        }
      });
  }

  return { render, updateCursor, clampTime };
}

global.TimeSeriesPlot = Object.freeze({ createPlot });
})(globalThis);
