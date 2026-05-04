function getSignalMaxTime(metric) {
  const selected = getSelectedSubjects();
  let maxT = 0;

  for (const subject of selected) {
    const series = getSeries(subject, metric);
    if (!series.length) continue;

    const lastT = series[series.length - 1].time;
    if (Number.isFinite(lastT)) {
      maxT = Math.max(maxT, lastT);
    }
  }

  return maxT;
}

function getPlotMaxTime(metric) {
  const signalMax = getSignalMaxTime(metric) || 0;
  const playableMax =
    typeof getMaxPlayableTime === 'function'
      ? getMaxPlayableTime()
      : 0;

  return Math.max(signalMax, playableMax);
}

function clampTime(nextTime) {
  const maxT = getPlotMaxTime(state.selectedMetric);
  return Math.max(0, Math.min(Number(nextTime) || 0, maxT || 0));
}

function getPlotGeometry() {
  const gd = document.getElementById('plot');
  const fullLayout = gd?._fullLayout;

  if (!gd || !fullLayout?.xaxis) return null;

  const rect = gd.getBoundingClientRect();
  const xaxis = fullLayout.xaxis;
  const yaxis = fullLayout.yaxis;

  return {
    gd,
    rect,
    xaxis,
    yaxis,
    leftPx: rect.left + xaxis._offset,
    rightPx: rect.left + xaxis._offset + xaxis._length,
    topPx: yaxis ? rect.top + yaxis._offset : rect.top,
    bottomPx: yaxis ? rect.top + yaxis._offset + yaxis._length : rect.bottom
  };
}

function clientXToVisiblePlotTime(clientX) {
  const geometry = getPlotGeometry();
  if (!geometry) return null;

  const { xaxis, leftPx, rightPx } = geometry;

  if (clientX < leftPx || clientX > rightPx) return null;

  const fraction = (clientX - leftPx) / (rightPx - leftPx);
  const x0 = Number(xaxis.range[0]);
  const x1 = Number(xaxis.range[1]);

  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;

  return clampTime(x0 + fraction * (x1 - x0));
}

function clientXToFullTimelineTime(clientX) {
  const geometry = getPlotGeometry();
  if (!geometry) return null;

  const { leftPx, rightPx } = geometry;
  const maxT = getPlotMaxTime(state.selectedMetric);

  if (maxT <= 0) return 0;
  if (clientX < leftPx) return 0;
  if (clientX > rightPx) return maxT;

  const fraction = (clientX - leftPx) / (rightPx - leftPx);
  return clampTime(fraction * maxT);
}

function timeToFullTimelinePixel(time) {
  const geometry = getPlotGeometry();
  if (!geometry) return null;

  const { xaxis } = geometry;
  const maxT = getPlotMaxTime(state.selectedMetric);

  if (!Number.isFinite(maxT) || maxT <= 0) return null;

  const safeTime = Math.max(0, Math.min(time, maxT));
  const fraction = safeTime / maxT;

  return xaxis._offset + fraction * xaxis._length;
}

function updateHtmlCursor() {
  const cursor = document.getElementById('plotCursor');
  const handle = cursor?.querySelector('.plot-cursor-handle');

  if (!cursor || !handle) return;

  const maxT = getPlotMaxTime(state.selectedMetric);
  const pixelX = timeToFullTimelinePixel(state.currentTime);

  if (!Number.isFinite(pixelX) || maxT <= 0) {
    cursor.classList.remove('is-visible');
    return;
  }

  cursor.style.left = `${pixelX}px`;
  cursor.classList.add('is-visible');

  const label = `${state.currentTime.toFixed(2)}s`;
  handle.textContent = label;

  cursor.setAttribute('aria-valuemax', String(maxT));
  cursor.setAttribute('aria-valuenow', String(state.currentTime));
}

function attachPlotSeek(gd) {
  if (!gd || gd.__freeXSeekAttached) return;

  gd.addEventListener('click', (event) => {
    const cursor = document.getElementById('plotCursor');

    if (cursor && cursor.contains(event.target)) return;

    const geometry = getPlotGeometry();
    if (!geometry) return;

    const { topPx, bottomPx } = geometry;

    /*
      Clicking the main plot seeks the video.
      The lower Plotly rangeslider remains available for zooming.
    */
    if (event.clientY < topPx || event.clientY > bottomPx) return;

    const clickedTime = clientXToVisiblePlotTime(event.clientX);
    if (clickedTime === null) return;

    setCurrentTime(clickedTime, true);
  });

  gd.__freeXSeekAttached = true;
}

function attachTimelineCursor(gd) {
  const cursor = document.getElementById('plotCursor');
  if (!gd || !cursor || cursor.__timelineCursorAttached) return;

  let dragging = false;

  function seekFromPointer(event) {
    const nextTime = clientXToFullTimelineTime(event.clientX);
    if (nextTime === null) return;

    setCurrentTime(nextTime, true);
  }

  cursor.addEventListener('pointerdown', (event) => {
    event.preventDefault();

    dragging = true;
    cursor.classList.add('is-dragging');
    cursor.setPointerCapture(event.pointerId);

    seekFromPointer(event);
  });

  cursor.addEventListener('pointermove', (event) => {
    if (!dragging) return;

    event.preventDefault();
    seekFromPointer(event);
  });

  cursor.addEventListener('pointerup', (event) => {
    dragging = false;
    cursor.classList.remove('is-dragging');

    if (cursor.hasPointerCapture(event.pointerId)) {
      cursor.releasePointerCapture(event.pointerId);
    }
  });

  cursor.addEventListener('lostpointercapture', () => {
    dragging = false;
    cursor.classList.remove('is-dragging');
  });

  cursor.addEventListener('keydown', (event) => {
    const smallStep = 0.1;
    const largeStep = 1.0;
    const step = event.shiftKey ? largeStep : smallStep;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCurrentTime(state.currentTime - step, true);
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCurrentTime(state.currentTime + step, true);
    }
  });

  gd.on('plotly_relayout', () => {
    updateHtmlCursor();
  });

  cursor.__timelineCursorAttached = true;
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
        line: {
          width: 4
        }
      });
    }
  }

  const maxT = getPlotMaxTime(metric);
  const clampedTime = clampTime(state.currentTime);
  state.currentTime = clampedTime;

  const layout = {
    title: metric ? `Metric: ${metric}` : 'Load data to begin',
    template: 'plotly_white',
    dragmode: false,
    uirevision: metric || 'empty',

    xaxis: {
      title: 'Time',
      range: maxT > 0 ? [0, maxT] : undefined,
      fixedrange: false,
      rangeslider: {
        visible: true,
        thickness: 0.17
      }
    },

    yaxis: {
      title: metric || 'Value',
      fixedrange: true
    },

    hovermode: 'x unified',

    /*
      This line is the sync cursor in the main plot.
      The big draggable cursor is a separate HTML overlay placed over
      the lower Plotly rangeslider.
    */
    shapes: [
      {
        type: 'line',
        x0: clampedTime,
        x1: clampedTime,
        y0: 0,
        y1: 1,
        yref: 'paper',
        line: {
          width: 2,
          dash: 'dot'
        }
      }
    ],

    margin: {
      l: 60,
      r: 20,
      t: 50,
      b: 70
    }
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
    attachTimelineCursor(gd);
    updateCursor();
  });
}

function updateCursor() {
  const gd = document.getElementById('plot');
  const xaxis = gd?._fullLayout?.xaxis;

  const metric = state.selectedMetric;
  const maxT = getPlotMaxTime(metric);
  const t = clampTime(state.currentTime);

  state.currentTime = t;

  const relayoutUpdate = {
    'shapes[0].x0': t,
    'shapes[0].x1': t
  };

  /*
    If the user has zoomed in using the lower rangeslider,
    keep the main plot centered around the moving video cursor.
  */
  if (xaxis && Array.isArray(xaxis.range) && maxT > 0) {
    let x0 = Number(xaxis.range[0]);
    let x1 = Number(xaxis.range[1]);

    if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
      const windowSize = x1 - x0;
      const isZoomed = windowSize < maxT;

      if (isZoomed && (t < x0 || t > x1)) {
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

  Plotly.relayout('plot', relayoutUpdate)
    .then(updateHtmlCursor)
    .catch(() => {
      updateHtmlCursor();
    });
}
