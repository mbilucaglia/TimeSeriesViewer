/*
  ============================================================
  FILE: plot.js

  This file controls the PLOT and PLOT INTERACTIONS.

  Main responsibilities:
  1. Draw Plotly traces.
  2. Draw the Plotly vertical time line.
  3. Move the custom HTML cursor over the lower rangeslider.
  4. Let the user click the main plot to seek the video.
  5. Let the user drag the lower cursor to seek the video.
  6. Keep Plotly updates efficient during video playback.

  Important:
  data.js owns the central time function:
  setCurrentTime()

  plot.js never directly changes video.currentTime.
  Instead, plot.js calls setCurrentTime(time, true).
  ============================================================
*/


/* ============================================================
   BLOCK 1: CURSOR UPDATE CONTROL

   Plotly.relayout() is heavier than moving a simple HTML element.

   So:
   - the HTML cursor updates immediately
   - the Plotly vertical line is throttled to about 30 fps
   ============================================================ */

let lastCursorRelayoutAt = 0;
let cursorRelayoutInFlight = false;
let pendingCursorRelayout = false;


/* ============================================================
   BLOCK 2: TIME LIMIT HELPERS
   ============================================================ */

/*
  Return the maximum signal time among selected subjects.

  Used by both:
  - plot.js for plot range
  - data.js for global synchronization duration
*/
function getSignalMaxTime(metric) {
  if (typeof getSelectedSubjects !== 'function' || typeof getSeries !== 'function') {
    return 0;
  }

  const selected = getSelectedSubjects();
  let maxT = 0;

  for (const subject of selected) {
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
  Return the maximum time the plot should represent.

  Usually this is the larger of:
  - video duration
  - signal duration

  getMaxPlayableTime() is defined in data.js.
*/
function getPlotMaxTime(metric) {
  const signalMax = getSignalMaxTime(metric) || 0;

  const playableMax =
    typeof getMaxPlayableTime === 'function'
      ? getMaxPlayableTime()
      : 0;

  return Math.max(signalMax, playableMax);
}


/*
  Keep time inside valid bounds.

  Example:
  - negative time becomes 0
  - time beyond max becomes max
*/
function clampTime(nextTime) {
  const maxT = getPlotMaxTime(state.selectedMetric);
  const numericTime = Number(nextTime) || 0;

  if (!Number.isFinite(maxT) || maxT <= 0) {
    return Math.max(0, numericTime);
  }

  return Math.max(0, Math.min(numericTime, maxT));
}


/* ============================================================
   BLOCK 3: PLOT GEOMETRY

   These functions translate between:
   - mouse/pointer x position in pixels
   - time in seconds

   This is necessary for:
   - clicking the main plot
   - dragging the lower cursor
   ============================================================ */

/*
  Read the pixel geometry of the Plotly plot.

  Plotly stores useful layout information in:
  gd._fullLayout.xaxis
  gd._fullLayout.yaxis

  gd = graph div = the DOM element where Plotly draws.
*/
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

    // Horizontal plotting area.
    leftPx: rect.left + xaxis._offset,
    rightPx: rect.left + xaxis._offset + xaxis._length,

    // Main y-axis plotting area.
    topPx: yaxis ? rect.top + yaxis._offset : rect.top,
    bottomPx: yaxis ? rect.top + yaxis._offset + yaxis._length : rect.bottom
  };
}


/*
  Convert a click in the visible main plot area to a time.

  This respects the current zoom.
  If the visible x-axis is [10, 20], clicking halfway means 15 seconds.
*/
function clientXToVisiblePlotTime(clientX) {
  const geometry = getPlotGeometry();

  if (!geometry) {
    return null;
  }

  const { xaxis, leftPx, rightPx } = geometry;

  if (clientX < leftPx || clientX > rightPx) {
    return null;
  }

  const x0 = Number(xaxis.range[0]);
  const x1 = Number(xaxis.range[1]);

  if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
    return null;
  }

  const fraction = (clientX - leftPx) / (rightPx - leftPx);
  return clampTime(x0 + fraction * (x1 - x0));
}


/*
  Convert pointer position over the lower timeline to a full-duration time.

  This ignores zoom and maps the full left-to-right width to:
  0 seconds -> max duration
*/
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


/*
  Convert current time to a pixel position inside plotWrap.

  Used to position the HTML draggable cursor.
*/
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

  /*
    xaxis._offset is relative to the Plotly div.
    Because plotCursor is inside plotWrap, this works as a left position.
  */
  return xaxis._offset + fraction * xaxis._length;
}


/* ============================================================
   BLOCK 4: HTML DRAGGABLE CURSOR

   This cursor is defined in index.html:

   <div id="plotCursor" class="plot-cursor">
     <div class="plot-cursor-bar"></div>
     <div class="plot-cursor-handle">0.00s</div>
   </div>
   ============================================================ */

function updateHtmlTimelineCursor() {
  const cursor = document.getElementById('plotCursor');

  if (!cursor) {
    return;
  }

  const handle = cursor.querySelector('.plot-cursor-handle');
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


/* ============================================================
   BLOCK 5: PLOT -> VIDEO INTERACTIONS

   These listeners let the plot control the video.

   1. Click main plot:
      seek video to clicked time.

   2. Drag lower cursor:
      seek video continuously.
   ============================================================ */

function attachMainPlotSeek(gd) {
  if (!gd || gd.__timeSeriesMainPlotSeekAttached) {
    return;
  }

  gd.addEventListener('click', event => {
    const cursor = document.getElementById('plotCursor');

    // Ignore clicks on the draggable cursor itself.
    if (cursor && cursor.contains(event.target)) {
      return;
    }

    const geometry = getPlotGeometry();

    if (!geometry) {
      return;
    }

    const { topPx, bottomPx } = geometry;

    /*
      Only clicks inside the main plot seek the video.
      The lower Plotly rangeslider remains available for zooming.
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
  const cursor = document.getElementById('plotCursor');

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

  /*
    Keyboard support:
    - ArrowLeft / ArrowRight = move 0.1 second
    - Shift + ArrowLeft / ArrowRight = move 1 second
  */
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

  /*
    When the user zooms using Plotly's lower rangeslider,
    update the cursor position.
  */
  if (typeof gd.on === 'function') {
    gd.on('plotly_relayout', () => {
      updateHtmlTimelineCursor();
    });
  }

  cursor.__timeSeriesCursorDragAttached = true;
}


/* ============================================================
   BLOCK 6: BUILD PLOTLY TRACES

   A trace is one line in Plotly.

   The app can draw:
   - one line per selected subject
   - one thicker average line
   ============================================================ */

function buildTraces() {
  const selected = getSelectedSubjects();
  const metric = state.selectedMetric;
  const traces = [];

  const showIndividuals = showIndividualsEl?.checked ?? true;
  const showAverage = showAverageEl?.checked ?? true;

  /*
    Individual subject traces.
  */
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

  /*
    Average trace.
  */
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


/* ============================================================
   BLOCK 7: CREATE / REDRAW THE PLOT

   makePlot() is called when:
   - the page first loads
   - data is uploaded
   - metric changes
   - selected subjects change
   - display options change
   ============================================================ */

function makePlot() {
  const plot = document.getElementById('plot');

  if (!plot) {
    return;
  }

  const metric = state.selectedMetric;
  const traces = buildTraces();
  const maxT = getPlotMaxTime(metric);

  state.currentTime = clampTime(state.currentTime);

  const layout = {
    title: metric ? `Metric: ${metric}` : 'Load data to begin',

    template: 'plotly_white',

    /*
      dragmode false avoids accidental zoom/pan in the main plot.
      Users can still zoom with the lower rangeslider.
    */
    dragmode: false,

    /*
      uirevision tells Plotly to preserve some UI state between redraws.
    */
    uirevision: metric || 'empty',

    xaxis: {
      title: 'Time',
      range: maxT > 0 ? [0, maxT] : undefined,
      fixedrange: false,

      /*
        This is Plotly's built-in lower zoomable plot.
      */
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

    /*
      Plotly vertical line.
      This follows state.currentTime.
    */
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

    /*
      Remove modebar buttons we do not need.
      The lower rangeslider is the intended zoom control.
    */
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


/* ============================================================
   BLOCK 8: UPDATE THE PLOTLY VERTICAL LINE

   The HTML cursor is light and moves immediately.
   Plotly.relayout is heavier, so it is throttled.
   ============================================================ */

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
    If the user zoomed into a smaller time window using the lower
    Plotly rangeslider, keep the main visible plot following the cursor.
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
    Limit Plotly cursor redraws to roughly 30 fps unless forced.
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
    .catch(() => {
      /*
        Ignore relayout errors.

        They can happen briefly while the plot is being recreated.
      */
    })
    .finally(() => {
      cursorRelayoutInFlight = false;

      if (pendingCursorRelayout) {
        pendingCursorRelayout = false;
        runCursorRelayout(true);
      }
    });
}


/*
  Public function used by data.js.

  This updates:
  - custom HTML cursor
  - Plotly vertical line
*/
function updateCursor(force = false) {
  updateHtmlTimelineCursor();
  runCursorRelayout(force);
}
