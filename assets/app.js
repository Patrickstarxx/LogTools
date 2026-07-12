(function () {
  const { parseUlogFile } = window.PX4UlogParser;
  const {
    buildTimeRange,
    buildTrackSummary,
    countTrackPointsAtOrBefore,
    chooseGlobalReference,
    computeLocalOriginOffsets,
    computeRelativeMetrics,
    findNearestAtOrBefore,
    computeSightlineVector,
    normalizeGlobalSamples,
    normalizeLocalSamples,
    quaternionToFrdAxes,
    resolveAttitudeConvention,
  } = window.PX4Trajectory;
  const { TrajectoryViewer3D } = window.PX4Viewer3D;

  const DRONE_A_LABEL = '无人机 A';
  const DRONE_B_LABEL = '无人机 B';
  const DEFAULT_SIGHTLINE_LENGTH = 5;

  const elements = {
    fileA: document.getElementById('fileA'),
    fileB: document.getElementById('fileB'),
    coordinateMode: document.getElementById('coordinateMode'),
    sightlineAngle: document.getElementById('sightlineAngle'),
    sightlineLength: document.getElementById('sightlineLength'),
    drawButton: document.getElementById('drawButton'),
    clearButton: document.getElementById('clearButton'),
    statusA: document.getElementById('statusA'),
    statusB: document.getElementById('statusB'),
    canvas: document.getElementById('trajectoryCanvas'),
    emptyState: document.getElementById('emptyState'),
    hoverReadout: document.getElementById('hoverReadout'),
    viewerSubtitle: document.getElementById('viewerSubtitle'),
    timeSlider: document.getElementById('timeSlider'),
    timeLabel: document.getElementById('timeLabel'),
    timelineHint: document.getElementById('timelineHint'),
    relativeDistance: document.getElementById('relativeDistance'),
    nedNorth: document.getElementById('nedNorth'),
    nedEast: document.getElementById('nedEast'),
    nedDown: document.getElementById('nedDown'),
    frdForward: document.getElementById('frdForward'),
    frdRight: document.getElementById('frdRight'),
    frdDown: document.getElementById('frdDown'),
    relativeReadoutHint: document.getElementById('relativeReadoutHint'),
  };

  const viewer = new TrajectoryViewer3D(elements.canvas, {
    readout: elements.hoverReadout,
    emptyState: elements.emptyState,
  });

  const state = {
    parsedLogs: { a: null, b: null },
    fullTracks: [],
    renderTracks: [],
    timeRange: { startUs: 0, endUs: 0, durationUs: 0 },
    currentTimeUs: 0,
    localOffsets: [],
    attitudeConventionA: { convention: 'body_to_ned', source: 'not resolved', confidence: 0 },
    sightlineAngleDegrees: 0,
    sightlineLengthMeters: DEFAULT_SIGHTLINE_LENGTH,
    currentRenderRequestId: 0,
  };

  elements.drawButton.addEventListener('click', () => {
    parseAndDraw().catch((error) => {
      renderError(elements.statusA, DRONE_A_LABEL, error);
      renderError(elements.statusB, DRONE_B_LABEL, error);
      viewer.clear();
      disableTimeline();
    }).finally(() => {
      elements.drawButton.disabled = false;
      elements.drawButton.textContent = '解析并绘制';
    });
  });

  elements.clearButton.addEventListener('click', clearAll);

  elements.coordinateMode.addEventListener('change', () => {
    if (state.parsedLogs.a || state.parsedLogs.b) {
      rebuildTracksForMode();
    }
  });

  elements.timeSlider.addEventListener('input', () => {
    state.currentTimeUs = state.timeRange.startUs + Number(elements.timeSlider.value) * 1e6;
    beginInteractiveRender();
    queueRenderCurrentTime();
  });

  elements.sightlineAngle.addEventListener('input', () => {
    state.sightlineAngleDegrees = parseSightlineAngle(elements.sightlineAngle.value);
    queueRenderCurrentTime();
  });

  elements.sightlineLength.addEventListener('input', () => {
    state.sightlineLengthMeters = parseSightlineLength(elements.sightlineLength.value);
    queueRenderCurrentTime();
  });

  async function parseAndDraw() {
    const fileA = elements.fileA.files[0];
    const fileB = elements.fileB.files[0];

    if (!fileA || !fileB) {
      if (!fileA) renderError(elements.statusA, DRONE_A_LABEL, new Error('请选择无人机 A 的 .ulg 文件。'));
      if (!fileB) renderError(elements.statusB, DRONE_B_LABEL, new Error('请选择无人机 B 的 .ulg 文件。'));
      return;
    }

    elements.drawButton.disabled = true;
    elements.drawButton.textContent = '解析中...';
    renderPending(elements.statusA, DRONE_A_LABEL, fileA.name);
    renderPending(elements.statusB, DRONE_B_LABEL, fileB.name);
    disableTimeline();

    const [resultA, resultB] = await Promise.allSettled([parseOne(fileA), parseOne(fileB)]);
    state.parsedLogs.a = unwrapResult(resultA, elements.statusA, DRONE_A_LABEL);
    state.parsedLogs.b = unwrapResult(resultB, elements.statusB, DRONE_B_LABEL);
    rebuildTracksForMode();
  }

  async function parseOne(file) {
    if (!file.name.toLowerCase().endsWith('.ulg')) {
      throw new Error('文件扩展名不是 .ulg。');
    }
    return parseUlogFile(file);
  }

  function unwrapResult(result, card, label) {
    if (result.status === 'rejected') {
      renderError(card, label, result.reason);
      return null;
    }
    return result.value;
  }

  function rebuildTracksForMode() {
    const mode = elements.coordinateMode.value;
    const entries = [
      state.parsedLogs.a ? { key: 'a', label: DRONE_A_LABEL, color: '#38bdf8', log: state.parsedLogs.a, card: elements.statusA } : null,
      state.parsedLogs.b ? { key: 'b', label: DRONE_B_LABEL, color: '#f97316', log: state.parsedLogs.b, card: elements.statusB } : null,
    ].filter(Boolean);

    if (entries.length === 0) {
      state.fullTracks = [];
      state.renderTracks = [];
      viewer.clear();
      disableTimeline();
      return;
    }

    const globalReference = mode === 'global'
      ? chooseGlobalReference(entries.map((entry) => ({ globalRaw: entry.log.globalRaw })))
      : null;
    const localOffsets = mode === 'local'
      ? computeLocalOriginOffsets(entries.map((entry) => entry.log))
      : entries.map(() => ({ x: 0, y: 0, z: 0, available: false }));
    state.localOffsets = localOffsets;

    state.fullTracks = entries.map((entry, index) => {
      const track = mode === 'local'
        ? normalizeLocalSamples(entry.log.localRaw, localOffsets[index])
        : normalizeGlobalSamples(entry.log.globalRaw, globalReference);
      track.name = entry.label;
      track.color = entry.color;
      track.key = entry.key;
      renderStatus(entry.card, entry.label, entry.log, mode, track, localOffsets[index]);
      return track;
    });

    state.attitudeConventionA = state.parsedLogs.a
      ? resolveAttitudeConvention(state.parsedLogs.a.attitudeRaw, state.parsedLogs.a.localRaw)
      : { convention: 'body_to_ned', source: 'not resolved', confidence: 0 };

    const trackAIndex = state.fullTracks.findIndex((track) => track.key === 'a');
    if (trackAIndex >= 0) {
      const entryA = entries.find((entry) => entry.key === 'a');
      renderStatus(
        elements.statusA,
        DRONE_A_LABEL,
        state.parsedLogs.a,
        mode,
        state.fullTracks[trackAIndex],
        localOffsets[trackAIndex],
        state.attitudeConventionA,
      );
      if (entryA && entryA.card !== elements.statusA) {
        renderStatus(entryA.card, entryA.label, entryA.log, mode, state.fullTracks[trackAIndex], localOffsets[trackAIndex], state.attitudeConventionA);
      }
    }

    state.renderTracks = state.fullTracks.filter((track) => track.points.length >= 2);
    if (state.renderTracks.length === 0) {
      viewer.clear();
      disableTimeline();
      elements.emptyState.classList.remove('hidden');
      elements.emptyState.textContent = '当前坐标模式下没有足够的轨迹点。请切换坐标模式或检查日志 topic。';
      return;
    }

    state.timeRange = buildTimeRange(state.renderTracks);
    state.currentTimeUs = state.timeRange.endUs;
    viewer.setTracks(state.renderTracks, {
      axisLabels: getAxisLabels(mode),
      preserveView: false,
    });
    setupTimeline(state.timeRange);
    queueRenderCurrentTime();

    elements.viewerSubtitle.textContent = mode === 'local'
      ? '当前显示本地坐标：PX4 NED 的 z 已转换为向上高度；若两份日志有全球坐标，会自动校正不同本地原点。'
      : '当前显示全球坐标：经纬高已转换为相对参考原点的 ENU 米制坐标。';
  }

  function getAxisLabels(mode) {
    return mode === 'local'
      ? { x: 'X', y: 'Y', z: '高度 (-z)' }
      : { x: 'East', y: 'North', z: 'Up' };
  }

  function setupTimeline(range) {
    elements.timeSlider.disabled = false;
    elements.timeSlider.min = '0';
    elements.timeSlider.max = String(Math.max(0, range.durationUs / 1e6));
    elements.timeSlider.step = '0.01';
    elements.timeSlider.value = elements.timeSlider.max;
    elements.timelineHint.textContent = '拖动时间轴，轨迹会绘制到当前时间；无人机 A 会显示当前 FRD 机体坐标轴。';
  }

  function disableTimeline() {
    elements.timeSlider.disabled = true;
    elements.timeSlider.min = '0';
    elements.timeSlider.max = '0';
    elements.timeSlider.value = '0';
    elements.timeLabel.textContent = '—';
    elements.timelineHint.textContent = '加载日志后可拖动时间轴，轨迹会随当前时间逐步绘制。';
    resetRelativeReadout();
  }

  function renderCurrentTime() {
    if (!state.renderTracks.length) {
      return;
    }
    const currentSeconds = (state.currentTimeUs - state.timeRange.startUs) / 1e6;
    elements.timeLabel.textContent = `${formatSeconds(currentSeconds)} / ${formatSeconds(state.timeRange.durationUs / 1e6)}`;
    const visibleCounts = state.renderTracks.map((track) => countTrackPointsAtOrBefore(track, state.currentTimeUs));
    const axesA = getCurrentAxesA();
    viewer.setVisiblePointCounts(visibleCounts);
    viewer.setOverlays(
      buildCurrentMarkers(state.renderTracks, visibleCounts),
      buildBodyAxesOverlay(state.renderTracks, visibleCounts, axesA),
    );
    updateRelativeReadout(axesA);
  }

  function beginInteractiveRender() {
    if (typeof viewer.setInteractive === 'function') {
      viewer.setInteractive(true);
    }
    if (typeof viewer.scheduleInteractiveRelease === 'function') {
      viewer.scheduleInteractiveRelease();
    }
  }

  function queueRenderCurrentTime() {
    state.currentRenderRequestId += 1;
    const requestId = state.currentRenderRequestId;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 16);
    schedule(() => {
      if (requestId !== state.currentRenderRequestId) {
        return;
      }
      renderCurrentTime();
    });
  }

  function buildCurrentMarkers(tracks, visibleCounts) {
    return tracks
      .map((track, index) => {
        const visibleCount = visibleCounts[index] || 0;
        if (visibleCount <= 0) {
          return null;
        }
        return {
          name: track.name,
          color: track.color,
          point: track.points[visibleCount - 1],
        };
      })
      .filter(Boolean);
  }

  function getCurrentAxesA() {
    const logA = state.parsedLogs.a;
    if (!logA || !logA.attitudeRaw || logA.attitudeRaw.length === 0) {
      return null;
    }
    const attitude = findNearestAtOrBefore(logA.attitudeRaw, state.currentTimeUs);
    return attitude
      ? quaternionToFrdAxes(attitude.q, state.attitudeConventionA.convention)
      : null;
  }

  function buildBodyAxesOverlay(tracks, visibleCounts, axes) {
    const trackAIndex = tracks.findIndex((track) => track.key === 'a');
    const trackA = trackAIndex >= 0 ? tracks[trackAIndex] : null;
    if (!trackA || !axes) {
      return null;
    }
    const visibleCount = visibleCounts[trackAIndex] || 0;
    if (visibleCount <= 0) {
      return null;
    }
    const currentPoint = trackA.points[visibleCount - 1];
    if (!currentPoint || !axes) {
      return null;
    }
    const axisLength = Math.max(1, (viewer.bounds && viewer.bounds.span ? viewer.bounds.span : 20) * 0.08);
    const sightline = computeSightlineVector(axes, state.sightlineAngleDegrees);
    return {
      origin: currentPoint,
      axes,
      sightline,
      sightlineLength: state.sightlineLengthMeters,
      length: axisLength,
    };
  }

  function updateRelativeReadout(axesA) {
    const pointA = getCurrentPoint('a');
    const pointB = getCurrentPoint('b');
    const metrics = computeRelativeMetrics(pointA, pointB, axesA);
    if (!metrics) {
      resetRelativeReadout('当前时刻需要无人机 A、B 均有位置数据。');
      return;
    }

    elements.relativeDistance.textContent = formatMetric(metrics.euclideanDistance);
    elements.nedNorth.textContent = formatMetric(metrics.ned.north, true);
    elements.nedEast.textContent = formatMetric(metrics.ned.east, true);
    elements.nedDown.textContent = formatMetric(metrics.ned.down, true);
    if (metrics.frd) {
      elements.frdForward.textContent = formatMetric(metrics.frd.forward, true);
      elements.frdRight.textContent = formatMetric(metrics.frd.right, true);
      elements.frdDown.textContent = formatMetric(metrics.frd.down, true);
      elements.relativeReadoutHint.textContent = '投影为 B − A 的有符号距离；正值表示 B 位于对应正轴方向。';
    } else {
      clearFrdReadout();
      elements.relativeReadoutHint.textContent = 'NED 已更新；当前时刻缺少无人机 A 姿态，无法计算 FRD 投影。';
    }
  }

  function getCurrentPoint(key) {
    const track = state.fullTracks.find((candidate) => candidate.key === key);
    if (!track) {
      return null;
    }
    const count = countTrackPointsAtOrBefore(track, state.currentTimeUs);
    return count > 0 ? track.points[count - 1] : null;
  }

  function resetRelativeReadout(hint = '加载两份日志后显示；投影为 B − A 的有符号距离。') {
    elements.relativeDistance.textContent = '—';
    elements.nedNorth.textContent = '—';
    elements.nedEast.textContent = '—';
    elements.nedDown.textContent = '—';
    clearFrdReadout();
    elements.relativeReadoutHint.textContent = hint;
  }

  function clearFrdReadout() {
    elements.frdForward.textContent = '—';
    elements.frdRight.textContent = '—';
    elements.frdDown.textContent = '—';
  }

  function renderPending(card, label, fileName) {
    card.innerHTML = `
      <h2>${escapeHtml(label)}</h2>
      <p class="muted">${escapeHtml(fileName)} 正在解析...</p>
    `;
  }

  function renderError(card, label, error) {
    card.innerHTML = `
      <h2>${escapeHtml(label)}</h2>
      <p class="error">${escapeHtml(error && error.message ? error.message : String(error))}</p>
    `;
  }

  function renderStatus(card, label, log, mode, track, localOffset, attitudeConvention = null) {
    const local = log.topics.vehicle_local_position;
    const global = log.topics.vehicle_global_position;
    const attitude = log.topics.vehicle_attitude || { available: false, samples: 0 };
    const summary = buildTrackSummary(track);
    const warningItems = [];
    if (log.warnings && log.warnings.length) {
      warningItems.push(log.warnings.slice(0, 2).join('；'));
    }
    if (mode === 'local' && localOffset && !localOffset.available) {
      warningItems.push('缺少全球坐标，无法校正本地坐标原点，起点可能重合。');
    }
    if (label === DRONE_A_LABEL && !attitude.available) {
      warningItems.push('缺少 vehicle_attitude，无法绘制机体 FRD 坐标轴。');
    }
    if (label === DRONE_A_LABEL && attitude.available && attitudeConvention) {
      warningItems.push(`姿态约定：${attitudeConvention.convention}，依据：${attitudeConvention.source}。`);
      warningItems.push(`视线角度：${formatAngle(state.sightlineAngleDegrees)}（正角朝 -D，负角朝 +D）。`);
      warningItems.push(`视线长度：${formatLength(state.sightlineLengthMeters)}。`);
    }
    const warnings = warningItems.length
      ? `<p class="muted">提示：${escapeHtml(warningItems.join('；'))}</p>`
      : '';
    const pointStatus = summary.pointCount >= 2
      ? `${summary.pointCount} 点`
      : `<span class="error">${summary.pointCount} 点，无法绘制</span>`;

    card.innerHTML = `
      <h2>${escapeHtml(label)}</h2>
      <dl class="status-list">
        ${row('文件', escapeHtml(log.fileName || '—'))}
        ${row('本地坐标 topic', badge(local.available, `${local.samples} 条`))}
        ${row('全球坐标 topic', badge(global.available, `${global.samples} 条`))}
        ${row('姿态 topic', badge(attitude.available, `${attitude.samples} 条`))}
        ${row('当前模式', mode === 'local' ? '本地坐标' : '全球坐标')}
        ${row('采样点', pointStatus)}
        ${row('开始时间', formatSeconds(summary.startSeconds))}
        ${row('结束时间', formatSeconds(summary.endSeconds))}
        ${row('持续时间', formatSeconds(summary.durationSeconds))}
      </dl>
      ${warnings}
    `;
  }

  function row(label, value) {
    return `<div class="status-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function badge(ok, text) {
    return `<span class="badge ${ok ? 'ok' : 'no'}">${ok ? '可用' : '缺失'} · ${escapeHtml(text)}</span>`;
  }

  function formatSeconds(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value.toFixed(3)} s`;
  }

  function formatAngle(value) {
    return `${Number(value).toFixed(1)}°`;
  }

  function formatLength(value) {
    return `${Number(value).toFixed(2)} m`;
  }

  function formatMetric(value, signed = false) {
    if (!Number.isFinite(value)) return '—';
    const normalized = Math.abs(value) < 0.0005 ? 0 : value;
    const sign = signed && normalized > 0 ? '+' : '';
    return `${sign}${normalized.toFixed(3)} m`;
  }

  function parseSightlineAngle(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseSightlineLength(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SIGHTLINE_LENGTH;
  }

  function clearAll() {
    elements.fileA.value = '';
    elements.fileB.value = '';
    state.parsedLogs = { a: null, b: null };
    state.fullTracks = [];
    state.renderTracks = [];
    state.currentTimeUs = 0;
    state.timeRange = { startUs: 0, endUs: 0, durationUs: 0 };
    state.localOffsets = [];
    state.sightlineAngleDegrees = 0;
    state.sightlineLengthMeters = DEFAULT_SIGHTLINE_LENGTH;
    elements.sightlineAngle.value = '0';
    elements.sightlineLength.value = String(DEFAULT_SIGHTLINE_LENGTH);
    viewer.clear();
    disableTimeline();
    elements.statusA.innerHTML = `<h2>${DRONE_A_LABEL}</h2><p class="muted">尚未选择日志。</p>`;
    elements.statusB.innerHTML = `<h2>${DRONE_B_LABEL}</h2><p class="muted">尚未选择日志。</p>`;
    elements.emptyState.textContent = '选择两份日志后点击“解析并绘制”。';
    elements.viewerSubtitle.textContent = '左键按住拖拽平移，右键按住拖拽旋转，滚轮缩放，移动鼠标查看最近轨迹点。';
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }
})();
