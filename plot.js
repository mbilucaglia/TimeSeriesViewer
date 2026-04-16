function getSignalMaxTime(metric) {
  const selected = getSelectedSubjects();
  let maxT = 0;

  for (const subject of selected) {
    const series = getSeries(subject, metric);
    if (!series.length) continue;
    const lastT = series[series.length - 1].time;
    if (Number.isFinite(lastT)) maxT = Math.max(maxT, lastT);
  }

  return maxT;
}

function attachPlotSeek(gd) {
  if (!gd || gd.__freeXSeekAttached) return;

  gd.addEventListener('click', (event) => {
    const fullLayout = gd._fullLayout;
    if (!fullLayout || !fullLayout.xaxis) return;

    const xaxis = fullLayout.xaxis;
    const plotRect = gd.getBoundingClientRect();

    const leftPx = plotRect.left + xaxis._offset;
    const rightPx = leftPx + xaxis._length;

    const mouseX = event.clientX;
    if (mouseX < leftPx || mouseX > rightPx) return;

    const fraction = (mouseX - leftPx) / (rightPx - leftPx);
    const x0 = Number(xaxis.range[0]);
    const x1 = Number(xaxis.range[1]);
    const clickedTime = x0 + fraction * (x1 - x0);

    const maxT = getSignalMaxTime(state.selectedMetric);
    const safeTime = Math.max(0, Math.min(clickedTime, maxT || 0));

    state.currentTime = safeTime;
    videoEl.currentTime = safeTime;
    updateCursor();
  });

  gd.__freeXSeekAttached = true;
}

function makePlot() {
  const selected = getSelectedSubjects();
  const metric = state.selectedMetric;
  const traces = [];
  const showIndividuals = showIndividualsEl.checked;
  const showAverage = showAverageEl.checked;

  if (metric && showIndividuals) {
    for (const subject of selected) {
      const series = getSeries(subject, metric);
      if (!series.length) continue;

      traces.push({
        x: series.map(d => d.time),
        y: series.map(d => d.value),
        mode: 'lines',
        type: 'scatter',
        name: subject.subjectId,
        opacity: 0.45
      });
    }
  }

  if (metric && showAverage) {
    const avg = computeAverage(selected, metric);
    if (avg.length) {
      traces.push({
        x: avg.map(d => d.time),
        y: avg.map(d => d.value),
        mode: 'lines',
        type: 'scatter',
        name: `${metric} average`,
        line: { width: 4 }
      });
    }
  }

  const maxT = getSignalMaxTime(metric);
  const clampedTime = Math.max(0, Math.min(state.currentTime, maxT || 0));
  state.currentTime = clampedTime;

  const layout = {
    title: metric ? `Metric: ${metric}` : 'Load data to begin',
    template: 'plotly_white',

    // This is the missing pan configuration
    dragmode: false,

    xaxis: {
  title: 'Time',
  rangeslider: { visible: true },
  fixedrange: true
},
yaxis: {
  title: metric || 'Value',
  fixedrange: true
},
    hovermode: 'x unified',
    shapes: [{
      type: 'line',
      x0: clampedTime,
      x1: clampedTime,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: { width: 2, dash: 'dot' }
    }],
    margin: { l: 60, r: 20, t: 50, b: 55 }
  };

  Plotly.newPlot('plot', traces, layout, {
    responsive: true,
    displaylogo: false,
    scrollZoom: false,
    doubleClick: false,
    modeBarButtonsToRemove: [
    'zoom2d',
    'pan2d',
    'select2d',
    'lasso2d',
    'zoomIn2d',
    'zoomOut2d',
    'autoScale2d',
    'resetScale2d'
  ]
  }).then((gd) => {
    attachPlotSeek(gd);
  });
}

function updateCursor() {
  const gd = document.getElementById('plot');
  const xaxis = gd?._fullLayout?.xaxis;
  const metric = state.selectedMetric;
  const maxT = getSignalMaxTime(metric);

  const t = Math.max(0, Math.min(state.currentTime, maxT || 0));
  state.currentTime = t;

  const relayoutUpdate = {
    'shapes[0].x0': t,
    'shapes[0].x1': t
  };

  if (xaxis && Array.isArray(xaxis.range)) {
    let x0 = Number(xaxis.range[0]);
    let x1 = Number(xaxis.range[1]);

    if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
      const windowSize = x1 - x0;
      const isZoomed = windowSize < (maxT || 0);

      if (isZoomed) {
        let newX0 = t - windowSize / 2;
        let newX1 = t + windowSize / 2;

        if (newX0 < 0) {
          newX0 = 0;
          newX1 = Math.min(windowSize, maxT);
        }

        if (newX1 > maxT) {
          newX1 = maxT;
          newX0 = Math.max(0, maxT - windowSize);
        }

        relayoutUpdate['xaxis.range[0]'] = newX0;
        relayoutUpdate['xaxis.range[1]'] = newX1;
      }
    }
  }

  Plotly.relayout('plot', relayoutUpdate).catch(() => {});
}
