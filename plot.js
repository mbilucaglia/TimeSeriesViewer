let lastCursorRelayoutAt = 0;
let cursorRelayoutInFlight = false;
let pendingCursorRelayout = false;

function getSignalMaxTime(metric) {
  if (typeof getSelectedSubjects !== 'function' || typeof getSeries !== 'function') {
    return 0;
  }

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
  const numericTime = Number(nextTime) || 0;

  if (!Number.isFinite(maxT) || maxT <= 0) {
    return Math.max(0, numericTime);
  }

  return Math.max(0, Math.min(numericTime, maxT));
}

function injectTimelineCursorStyles() {
  if (document.getElementById('timelineCursorAutoStyles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'timelineCursorAutoStyles';

  style.textContent = `
    .plot-wrap {
      position: relative;
      width: 100%;
    }

    .plot-timeline-cursor {
      position: absolute;
      left: 0;
      bottom: 34px;
      width: 86px;
      height: 96px;
      transform: translateX(-50%);
      z-index: 50;
      display: none;
      cursor: ew-resize;
      touch-action: none;
      user-select: none;
    }

    .plot-timeline-cursor.is-visible {
      display: block;
    }

    .plot-timeline-cursor-bar {
      position: absolute;
      top: 5px;
      bottom: 5px;
      left: 50%;
      width: 6px;
      transform: translateX(-50%);
      border-radius: 999px;
      background: #2563eb;
      box-shadow:
        0 0 0 4px rgba(37, 99, 235, 0.18),
        0 8px 22px rgba(37, 99, 235, 0.25);
    }

    .plot-timeline-cursor-handle {
      position: absolute;
      top: 50%;
      left: 50%;
      min-width: 72px;
      height: 38px;
      padding: 0 12px;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background: #2563eb;
      color: white;
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.38);
      pointer-events: none;
      white-space: nowrap;
    }

    .plot-timeline-cursor.is-dragging .plot-timeline-cursor-handle {
      transform: translate(-50%, -50%) scale(1.08);
    }
  `;

  document.head.appendChild(style);
}

function ensurePlotWrap() {
  const plot = document.getElementById('plot');

  if (!plot) {
    return null;
  }

  let plotWrap = document.getElementById('plotWrap');

  if (plotWrap) {
    return plotWrap;
  }

  plotWrap = document.createElement('div');
  plotWrap.id = 'plotWrap';
  plotWrap.className = 'plot-wrap';

  plot.parentNode.insertBefore(plotWrap, plot);
  plotWrap.appendChild(plot);

  return plotWrap;
}

function ensureTimelineCursor() {
  injectTimelineCursorStyles();

  const plotWrap = ensurePlotWrap();

  if (!plotWrap) {
    return null;
  }

  let cursor = document.getElementById('plotCursor');

  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'plotCursor';
    cursor.className = 'plot-timeline-cursor';
    cursor.setAttribute('role', 'slider');
    cursor.setAttribute('aria-label', 'Current video time');
    cursor.setAttribute('aria-valuemin', '0');
    cursor.setAttribute('aria-valuemax', '0');
    cursor.setAttribute('aria-valuenow', '0');
    cursor.setAttribute('tabindex', '0');
    cursor.setAttribute('title', 'Drag to change video time');

    cursor.innerHTML = `
      <div class="plot-timeline-cursor-bar"></div>
      <div class="plot-timeline-cursor-handle">0.00s</div>
    `;

    plotWrap.appendChild(cursor);
  } else {
    cursor.classList.add('plot-timeline-cursor');

    if (!cursor.querySelector('.plot-timeline-cursor-bar')) {
      cursor.innerHTML = `
        <div class="plot-timeline-cursor-bar"></div>
        <div class="plot-timeline-cursor-handle">0.00s</div>
      `;
    }
  }

  return cursor;
}

function getPlotGeometry() {
  const gd = document.getElementById('plot');
  const fullLayout = gd?._fullLayout;

  if (!gd || !fullLayout?.xaxis) {
    return null;
  }

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

  if (!geometry) {
    return null;
  }

  const { xaxis, leftPx, rightPx } = geometry;

  if (clientX < leftPx || clientX > rightPx) {
    return null;
  }

  const fraction = (clientX - leftPx) / (rightPx - leftPx);
  const x0 = Number(xaxis.range[0]);
  const x1 = Number(xaxis.range[1]);

  if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
    return null;
  }

  return clampTime(x0 + fraction * (x1 - x0));
}

function clientXToFullTimelineTime(clientX) {
  const geometry = getPlotGeometry();

  if (!geometry) {
    return null;
  }

  const { leftPx, rightPx } = geometry;
  const maxT = getPlotMaxTime(state.selectedMetric);

  if (!Number.isFinite(maxT) || maxT <= 0) {
    return 0;
  }

  if (clientX <= leftPx) {
    return 0;
  }

  if (clientX >= rightPx) {
    return maxT;
  }

  const fraction = (clientX - leftPx) / (rightPx - leftPx);

  return clampTime(fraction * maxT);
}

function timeToFullTimelinePixel(time) {
  const geometry = getPlotGeometry();

  if (!geometry) {
    return null;
  }

  const { xaxis } = geometry;
  const maxT = getPlotMaxTime(state.selectedMetric);

  if (!Number.isFinite(maxT) || maxT <= 0) {
    return null;
  }

  const safeTime = Math.max(0, Math.min(time, maxT));
  const fraction = safeTime / maxT;

  return xaxis._offset + fraction * xaxis._length;
}

function updateHtmlTimelineCursor() {
  const cursor = ensureTimelineCursor();

  if (!cursor) {
    return;
  }

  const handle =
    cursor.querySelector('.plot-timeline-cursor-handle') ||
    cursor.querySelector('.plot-cursor-handle');

  const maxT = getPlotMaxTime(state.selectedMetric);
  const pixelX = timeToFullTimelinePixel(state.currentTime);

  if (!Number.isFinite(pixelX) || !Number.isFinite(maxT) || maxT <= 0) {
    cursor.classList.remove('is-visible');
    return;
  }

  cursor.style.left = `${pixelX}px`;
  cursor.classList.add('is-visible');

  const label = `${state.currentTime.toFixed(2)}s`;

  if (handle) {
    handle.textContent = label;
  }

  cursor.setAttribute('aria-valuemax', String(maxT));
  cursor.setAttribute('aria-valuenow', String(state.currentTime));
}

function attachMainPlotSeek(gd) {
  if (!gd || gd.__timeSeriesMainPlotSeekAttached) {
    return;
  }

  gd.addEventListener('click', event => {
    const cursor = document.getElementById('plotCursor');

    if (cursor && cursor.contains(event.target)) {
      return;
    }

    const geometry = getPlotGeometry();

    if (!geometry) {
      return;
    }

    const { topPx, bottomPx } = geometry;

    /*
      Only clicks in the main plot seek the video.
      The lower Plotly rangeslider remains free for zooming.
    */
    if (event.clientY < topPx || event.clientY > bottomPx) {
      return;
    }

    const clickedTime = clientXToVisiblePlotTime(event.clientX);

    if (clickedTime === null) {
      return;
    }

    if (typeof setCurrentTime === 'function') {
      setCurrentTime(clickedTime, true);
    }
  });

  gd.__timeSeriesMainPlotSeekAttached = true;
}

function attachTimelineCursorDrag(gd) {
  const cursor = ensureTimelineCursor();

  if (!gd || !cursor || cursor.__timeSeriesCursorDragAttached) {
    return;
  }

  let dragging = false;

  function seekFromPointer(event) {
    const nextTime = clientXToFullTimelineTime(event.clientX);

    if (nextTime === null) {
      return;
    }

    if (typeof setCurrentTime === 'function') {
      setCurrentTime(nextTime, true);
    }
  }

  cursor.addEventListener('pointerdown', event => {
    event.preventDefault();

    dragging = true;
    cursor.classList.add('is-dragging');
    cursor.setPointerCapture(event.pointerId);

    seekFromPointer(event);
  });

  cursor.addEventListener('pointermove', event => {
    if (!dragging) {
      return;
    }

    event.preventDefault();
    seekFromPointer(event);
  });

  cursor.addEventListener('pointerup', event => {
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

  cursor.addEventListener('keydown', event => {
    const smallStep = 0.1;
    const largeStep = 1.0;
    const step = event.shiftKey ? largeStep : smallStep;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();

      if (typeof setCurrentTime === 'function') {
        setCurrentTime(state.currentTime - step, true);
      }
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();

      if (typeof setCurrentTime === 'function') {
        setCurrentTime(state.currentTime + step, true);
      }
    }
  });

  if (typeof gd.on === 'function') {
    gd.on('plotly_relayout', () => {
      updateHtmlTimelineCursor();
    });
  }

  cursor.__timeSeriesCursorDragAttached = true;
}

function buildTraces() {
  const selected = getSelectedSubjects();
  const metric = state.selectedMetric;
  const traces = [];

  const showIndividuals = showIndividualsEl?.checked ?? true;
  const showAverage = showAverageEl?.checked ?? true;

  if (metric && showIndividuals) {
    for (const subject of selected) {
      const series = getSeries(subject, metric);

      if (!series.length) {
        continue;
      }

      traces.push({
        x: series.map(point => point.time),
        y: series.map(point => point.value),
        mode: 'lines',
        type: 'scatter',
        name: subject.subjectId,
        opacity: 0.45
      });
    }
  }

  if (metric && showAverage) {
    const average = computeAverage(selected, metric);

    if (average.length) {
      traces.push({
        x: average.map(point => point.time),
        y: average.map(point => point.value),
        mode: 'lines',
        type: 'scatter',
        name: `${metric} average`,
        line: {
          width: 4
        }
      });
    }
  }

  return traces;
}

function makePlot() {
  const plot = document.getElementById('plot');

  if (!plot) {
    return;
  }

  ensureTimelineCursor();

  const metric = state.selectedMetric;
  const traces = buildTraces();
  const maxT = getPlotMaxTime(metric);

  state.currentTime = clampTime(state.currentTime);

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
        thickness: 0.18
      }
    },

    yaxis: {
      title: metric || 'Value',
      fixedrange: true
    },

    hovermode: 'x unified',

    shapes: [
      {
        type: 'line',
        x0: state.currentTime,
        x1: state.currentTime,
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
      b: 78
    }
  };

  const config = {
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
  };

  Plotly.newPlot(plot, traces, layout, config).then(gd => {
    attachMainPlotSeek(gd);
    attachTimelineCursorDrag(gd);
    updateCursor(true);
  });
}

function computeCursorRelayoutUpdate() {
  const gd = document.getElementById('plot');

  if (!gd || !gd._fullLayout) {
    return null;
  }

  const xaxis = gd._fullLayout.xaxis;
  const metric = state.selectedMetric;
  const maxT = getPlotMaxTime(metric);
  const time = clampTime(state.currentTime);

  state.currentTime = time;

  const relayoutUpdate = {
    'shapes[0].x0': time,
    'shapes[0].x1': time
  };

  /*
    If the user zoomed the main plot using the lower rangeslider,
    keep the visible main plot following the video cursor.
  */
  if (xaxis && Array.isArray(xaxis.range) && maxT > 0) {
    let x0 = Number(xaxis.range[0]);
    let x1 = Number(xaxis.range[1]);

    if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
      const windowSize = x1 - x0;
      const isZoomed = windowSize < maxT - 0.001;

      if (isZoomed && (time < x0 || time > x1)) {
        let newX0 = time - windowSize / 2;
        let newX1 = time + windowSize / 2;

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

  return relayoutUpdate;
}

function runCursorRelayout(force = false) {
  const now = performance.now();

  /*
    Plotly relayout is heavier than moving the HTML cursor.
    Limit it to about 30 fps unless forced.
  */
  if (!force && now - lastCursorRelayoutAt < 33) {
    pendingCursorRelayout = true;
    return;
  }

  if (cursorRelayoutInFlight) {
    pendingCursorRelayout = true;
    return;
  }

  const relayoutUpdate = computeCursorRelayoutUpdate();

  if (!relayoutUpdate) {
    return;
  }

  lastCursorRelayoutAt = now;
  cursorRelayoutInFlight = true;

  Plotly.relayout('plot', relayoutUpdate)
    .catch(() => {})
    .finally(() => {
      cursorRelayoutInFlight = false;

      if (pendingCursorRelayout) {
        pendingCursorRelayout = false;
        runCursorRelayout(true);
      }
    });
}

function updateCursor(force = false) {
  updateHtmlTimelineCursor();
  runCursorRelayout(force);
}
