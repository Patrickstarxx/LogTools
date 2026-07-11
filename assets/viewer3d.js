(function (root, factory) {
  const trajectory = typeof require === 'function'
    ? require('./trajectory.js')
    : root.PX4Trajectory;
  const api = factory(trajectory);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.PX4Viewer3D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (trajectory) {
  const DEFAULT_YAW = -0.72;
  const DEFAULT_PITCH = 0.48;

  class TrajectoryViewer3D {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.readout = options.readout || null;
      this.emptyState = options.emptyState || null;
      this.tracks = [];
      this.bounds = null;
      this.yaw = DEFAULT_YAW;
      this.pitch = DEFAULT_PITCH;
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      this.dragging = false;
      this.interactionMode = null;
      this.lastPointer = null;
      this.rotationAnchor = null;
      this.currentMarkers = [];
      this.bodyAxes = [];
      this.projectedPoints = [];
      this.sceneCache = null;
      this.renderQueued = false;
      this.currentMarkers = [];
      this.bodyAxes = [];
      this.axisLabels = { x: 'X', y: 'Y', z: '高度' };
      this.pixelRatio = 1;
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
      this.bindEvents();
      this.resize();
      this.render();
    }

    setTracks(tracks, options = {}) {
      this.tracks = (tracks || []).filter((track) => track && track.points && track.points.length > 0);
      this.bounds = trajectory.computeBounds(this.tracks);
      this.axisLabels = options.axisLabels || this.axisLabels;
      if (!options.preserveView) {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
      }
      this.invalidateSceneCache();
      this.projectedPoints = [];
      if (this.emptyState) {
        this.emptyState.classList.toggle('hidden', this.tracks.length > 0);
      }
      this.requestRender();
    }

    clear() {
      this.tracks = [];
      this.bounds = null;
      this.projectedPoints = [];
      this.panX = 0;
      this.panY = 0;
      this.currentMarkers = [];
      this.bodyAxes = [];
      this.invalidateSceneCache();
      if (this.emptyState) {
        this.emptyState.classList.remove('hidden');
      }
      if (this.readout) {
        this.readout.textContent = '悬停轨迹点可查看时间与坐标。';
      }
      this.requestRender();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.pixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(320, Math.floor(rect.width || this.canvas.clientWidth || 900));
      const height = Math.max(360, Math.floor(rect.height || this.canvas.clientHeight || 520));
      this.canvas.width = Math.floor(width * this.pixelRatio);
      this.canvas.height = Math.floor(height * this.pixelRatio);
      this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      this.invalidateSceneCache();
      this.requestRender();
    }

    bindEvents() {
      this.canvas.addEventListener('pointerdown', (event) => {
        this.dragging = true;
        this.interactionMode = event.button === 2 ? 'rotate' : 'pan';
        this.canvas.setPointerCapture(event.pointerId);
        this.lastPointer = { x: event.clientX, y: event.clientY };
        if (this.interactionMode === 'rotate') {
          const rect = this.canvas.getBoundingClientRect();
          prepareAnchoredRotation(this, {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          }, this.bounds, this.getViewportSize());
        } else {
          this.rotationAnchor = null;
        }
      });

      this.canvas.addEventListener('pointermove', (event) => {
        if (this.dragging && this.lastPointer) {
          updateInteractionDrag(this, { x: event.clientX, y: event.clientY }, {
            bounds: this.bounds,
            size: this.getViewportSize(),
          });
          this.invalidateSceneCache();
          this.requestRender();
        } else {
          this.updateHover(event);
        }
      });

      this.canvas.addEventListener('pointerup', (event) => {
        this.dragging = false;
        this.interactionMode = null;
        this.lastPointer = null;
        this.rotationAnchor = null;
        try {
          this.canvas.releasePointerCapture(event.pointerId);
        } catch {
          // Pointer may already be released by the browser.
        }
      });

      this.canvas.addEventListener('pointerleave', () => {
        this.dragging = false;
        this.interactionMode = null;
        this.lastPointer = null;
        this.rotationAnchor = null;
      });

      this.canvas.addEventListener('contextmenu', (event) => {
        event.preventDefault();
      });

      this.canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const scale = Math.exp(-event.deltaY * 0.001);
        const rect = this.canvas.getBoundingClientRect();
        applyAnchoredZoom(this, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }, scale, this.bounds, this.getViewportSize());
        this.invalidateSceneCache();
        this.requestRender();
      }, { passive: false });
    }

    invalidateSceneCache() {
      this.sceneCache = null;
    }

    requestRender() {
      if (this.renderQueued) {
        return;
      }
      this.renderQueued = true;
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      schedule(() => {
        this.renderQueued = false;
        this.render();
      });
    }

    getViewportSize() {
      return {
        width: this.canvas.width / this.pixelRatio,
        height: this.canvas.height / this.pixelRatio,
      };
    }

    render() {
      const width = this.canvas.width / this.pixelRatio;
      const height = this.canvas.height / this.pixelRatio;
      this.ctx.clearRect(0, 0, width, height);
      this.drawBackground(width, height);
      this.projectedPoints = [];

      if (!this.bounds || this.tracks.length === 0) {
        this.drawEmptyAxes(width, height);
        return;
      }

      this.drawAxes(width, height);
      const scene = this.sceneCache || this.buildScene(width, height);
      this.sceneCache = scene;
      this.drawScene(scene);
    }

    setOverlays(currentMarkers = [], bodyAxes = null) {
      setOverlayState(this, currentMarkers, bodyAxes);
      this.invalidateSceneCache();
      this.requestRender();
    }

    drawBackground(width, height) {
      const gradient = this.ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.08)');
      gradient.addColorStop(1, 'rgba(249, 115, 22, 0.05)');
      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(0, 0, width, height);
    }

    drawEmptyAxes(width, height) {
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(width * 0.18, height * 0.72);
      this.ctx.lineTo(width * 0.82, height * 0.72);
      this.ctx.moveTo(width * 0.18, height * 0.72);
      this.ctx.lineTo(width * 0.28, height * 0.28);
      this.ctx.moveTo(width * 0.18, height * 0.72);
      this.ctx.lineTo(width * 0.12, height * 0.44);
      this.ctx.stroke();
      this.ctx.restore();
    }

    drawAxes(width, height) {
      const origin = this.projectPoint({
        x: this.bounds.centerX,
        y: this.bounds.centerY,
        z: this.bounds.centerZ,
      }, width, height);
      const span = this.bounds.span * 0.42;
      const axes = [
        { label: this.axisLabels.x || 'X', color: 'rgba(125, 211, 252, 0.8)', point: { x: this.bounds.centerX + span, y: this.bounds.centerY, z: this.bounds.centerZ } },
        { label: this.axisLabels.y || 'Y', color: 'rgba(167, 243, 208, 0.8)', point: { x: this.bounds.centerX, y: this.bounds.centerY + span, z: this.bounds.centerZ } },
        { label: this.axisLabels.z || 'Z', color: 'rgba(254, 215, 170, 0.8)', point: { x: this.bounds.centerX, y: this.bounds.centerY, z: this.bounds.centerZ + span } },
      ];
      this.ctx.save();
      this.ctx.lineWidth = 1.4;
      this.ctx.font = '13px "Microsoft YaHei UI", sans-serif';
      for (const axis of axes) {
        const end = this.projectPoint(axis.point, width, height);
        this.ctx.strokeStyle = axis.color;
        this.ctx.beginPath();
        this.ctx.moveTo(origin.x, origin.y);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.stroke();
        this.ctx.fillStyle = axis.color;
        this.ctx.fillText(axis.label, end.x + 6, end.y - 6);
      }
      this.ctx.restore();
    }

    buildScene(width, height) {
      const renderables = [];
      const labels = [];

      for (const track of this.tracks) {
        const projectedTrack = this.buildProjectedTrack(track, width, height);
        if (projectedTrack.points.length === 0) {
          continue;
        }
        this.collectTrackHoverPoints(projectedTrack);
        const trackScene = this.buildTrackScene(projectedTrack);
        renderables.push(...trackScene.renderables);
        labels.push(...trackScene.labels);
      }

      const bodyAxesScene = this.buildBodyAxesScene(width, height);
      renderables.push(...bodyAxesScene.renderables);
      labels.push(...bodyAxesScene.labels);

      const markerScene = this.buildCurrentMarkerScene(width, height);
      renderables.push(...markerScene.renderables);
      labels.push(...markerScene.labels);

      return {
        renderables: sortSceneDrawables(renderables),
        labels: sortSceneDrawables(labels),
      };
    }

    buildProjectedTrack(track, width, height) {
      return {
        track,
        points: track.points.map((point) => ({
          source: point,
          projected: this.projectPoint(point, width, height),
        })),
      };
    }

    collectTrackHoverPoints(projectedTrack) {
      const { track, points } = projectedTrack;
      for (let index = 0; index < points.length; index += Math.max(1, Math.floor(points.length / 500))) {
        this.projectedPoints.push({
          track,
          point: points[index].source,
          x: points[index].projected.x,
          y: points[index].projected.y,
        });
      }
    }

    buildTrackScene(projectedTrack) {
      const { track, points } = projectedTrack;
      const color = track.color || '#38bdf8';
      const renderables = [];
      const labels = [];

      for (let index = 1; index < points.length; index += 1) {
        renderables.push({
          kind: 'line',
          layer: 10,
          depth: averageDepth(points[index - 1].projected, points[index].projected),
          start: points[index - 1].projected,
          end: points[index].projected,
          color,
          lineWidth: 3,
          glowColor: color,
          glowBlur: 12,
        });
      }

      const first = points[0].projected;
      const last = points[points.length - 1].projected;
      renderables.push(createPointRenderable(first, {
        depth: first.depth,
        layer: 20,
        radius: 6,
        fillStyle: color,
        strokeStyle: 'rgba(255,255,255,0.9)',
        lineWidth: 2,
      }));
      labels.push(createLabelRenderable(first, {
        text: '起',
        color: 'rgba(229, 231, 235, 0.95)',
        font: '12px "Microsoft YaHei UI", sans-serif',
        dx: 8,
        dy: -8,
        depth: first.depth,
        layer: 50,
      }));

      renderables.push(createPointRenderable(last, {
        depth: last.depth,
        layer: 21,
        radius: 6,
        fillStyle: color,
        strokeStyle: 'rgba(255,255,255,0.9)',
        lineWidth: 2,
      }));
      labels.push(createLabelRenderable(last, {
        text: '终',
        color: 'rgba(229, 231, 235, 0.95)',
        font: '12px "Microsoft YaHei UI", sans-serif',
        dx: 8,
        dy: -8,
        depth: last.depth,
        layer: 51,
      }));
      labels.push(createLabelRenderable(last, {
        text: track.name || '轨迹',
        color,
        font: '600 14px "Microsoft YaHei UI", sans-serif',
        dx: 10,
        dy: 4,
        depth: last.depth,
        layer: 60,
      }));

      return { renderables, labels };
    }

    buildBodyAxesScene(width, height) {
      const renderables = [];
      const labels = [];
      for (const axis of this.bodyAxes) {
        const start = this.projectPoint(axis.start, width, height);
        const end = this.projectPoint(axis.end, width, height);
        renderables.push({
          kind: 'line',
          layer: 30,
          depth: averageDepth(start, end),
          start,
          end,
          color: axis.color,
          lineWidth: axis.lineWidth || 3,
        });
        if (axis.showEndpoint !== false) {
          renderables.push(createPointRenderable(end, {
            depth: end.depth,
            layer: 31,
            radius: 4,
            fillStyle: axis.color,
          }));
        }
        if (axis.showLabel !== false) {
          labels.push(createLabelRenderable(end, {
            text: axis.label,
            color: axis.color,
            font: '700 13px "Microsoft YaHei UI", sans-serif',
            dx: 6,
            dy: -6,
            depth: end.depth,
            layer: 70,
          }));
        }
      }
      return { renderables, labels };
    }

    buildCurrentMarkerScene(width, height) {
      const renderables = [];
      const labels = [];
      for (const marker of this.currentMarkers) {
        if (!marker.point) {
          continue;
        }
        const projected = this.projectPoint(marker.point, width, height);
        renderables.push(createPointRenderable(projected, {
          depth: projected.depth,
          layer: 40,
          radius: 8,
          fillStyle: marker.color || '#e5e7eb',
          strokeStyle: 'rgba(255,255,255,0.95)',
          lineWidth: 2,
        }));
        labels.push(createLabelRenderable(projected, {
          text: marker.name || '当前点',
          color: 'rgba(229, 231, 235, 0.95)',
          font: '12px "Microsoft YaHei UI", sans-serif',
          dx: 10,
          dy: 4,
          depth: projected.depth,
          layer: 80,
        }));
      }
      return { renderables, labels };
    }

    drawScene(scene) {
      for (const renderable of scene.renderables) {
        if (renderable.kind === 'line') {
          this.drawLineRenderable(renderable);
        } else if (renderable.kind === 'point') {
          this.drawPointRenderable(renderable);
        }
      }
      for (const label of scene.labels) {
        this.drawLabelRenderable(label);
      }
    }

    drawLineRenderable(renderable) {
      this.ctx.save();
      this.ctx.strokeStyle = renderable.color;
      this.ctx.lineWidth = renderable.lineWidth || 2;
      this.ctx.lineJoin = 'round';
      this.ctx.lineCap = 'round';
      this.ctx.shadowColor = renderable.glowColor || 'transparent';
      this.ctx.shadowBlur = renderable.glowBlur || 0;
      this.ctx.beginPath();
      this.ctx.moveTo(renderable.start.x, renderable.start.y);
      this.ctx.lineTo(renderable.end.x, renderable.end.y);
      this.ctx.stroke();
      this.ctx.restore();
    }

    drawPointRenderable(renderable) {
      this.ctx.save();
      this.ctx.fillStyle = renderable.fillStyle;
      if (renderable.strokeStyle) {
        this.ctx.strokeStyle = renderable.strokeStyle;
      }
      this.ctx.lineWidth = renderable.lineWidth || 0;
      this.ctx.beginPath();
      this.ctx.arc(renderable.point.x, renderable.point.y, renderable.radius || 4, 0, Math.PI * 2);
      this.ctx.fill();
      if (renderable.strokeStyle && (renderable.lineWidth || 0) > 0) {
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    drawLabelRenderable(label) {
      this.ctx.save();
      this.ctx.fillStyle = label.color || 'rgba(229, 231, 235, 0.95)';
      this.ctx.font = label.font || '12px "Microsoft YaHei UI", sans-serif';
      this.ctx.fillText(label.text, label.x + (label.dx || 0), label.y + (label.dy || 0));
      this.ctx.restore();
    }

    projectPoint(point, width, height) {
      return projectPointWithState(point, this.bounds, { width, height }, this);
    }

    updateHover(event) {
      if (!this.readout || this.projectedPoints.length === 0) {
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let nearest = null;
      let nearestDistance = Infinity;
      for (const candidate of this.projectedPoints) {
        const distance = Math.hypot(candidate.x - x, candidate.y - y);
        if (distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }
      if (!nearest || nearestDistance > 24) {
        this.readout.textContent = '悬停轨迹点可查看时间与坐标。';
        return;
      }
      this.readout.textContent = `${nearest.track.name} · t=${formatSeconds(nearest.point.t / 1e6)}s · x=${formatNumber(nearest.point.x)}m · y=${formatNumber(nearest.point.y)}m · z=${formatNumber(nearest.point.z)}m`;
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createInteractionState() {
      return {
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      panX: 0,
      panY: 0,
      zoom: 1,
      mode: null,
      interactionMode: null,
      lastPointer: null,
      rotationAnchor: null,
      currentMarkers: [],
      bodyAxes: [],
      setOverlays(currentMarkers, bodyAxes) {
        return setOverlayState(this, currentMarkers, bodyAxes);
      },
    };
  }

  function getInteractionMode(state) {
    return state.interactionMode || state.mode;
  }

  function updateInteractionDrag(state, pointer) {
    const context = arguments[2] || {};
    if (!state.lastPointer) {
      state.lastPointer = { x: pointer.x, y: pointer.y };
      return state;
    }
    const dx = pointer.x - state.lastPointer.x;
    const dy = pointer.y - state.lastPointer.y;
    if (getInteractionMode(state) === 'rotate') {
      const anchor = state.rotationAnchor || (
        context.bounds && context.size && context.anchorScreen
          ? makeAnchorState(context.anchorScreen, context.bounds, context.size, state)
          : null
      );
      state.yaw += dx * 0.008;
      state.pitch = clamp(state.pitch + dy * 0.006, -1.35, 1.2);
      if (anchor && context.bounds && context.size) {
        keepAnchorFixed(state, anchor.world, anchor.screen, context.bounds, context.size);
      }
    } else {
      state.panX += dx;
      state.panY += dy;
    }
    state.lastPointer = { x: pointer.x, y: pointer.y };
    return state;
  }

  function getProjectionScale(bounds, size, state) {
    return Math.min(size.width, size.height) * 0.68 / bounds.span * state.zoom;
  }

  function rotateCenteredPoint(point, bounds, state) {
    const centered = {
      x: point.x - bounds.centerX,
      y: point.y - bounds.centerY,
      z: point.z - bounds.centerZ,
    };

    const cosYaw = Math.cos(state.yaw);
    const sinYaw = Math.sin(state.yaw);
    const yawX = centered.x * cosYaw - centered.y * sinYaw;
    const yawY = centered.x * sinYaw + centered.y * cosYaw;
    const yawZ = centered.z;

    const cosPitch = Math.cos(state.pitch);
    const sinPitch = Math.sin(state.pitch);
    const pitchY = yawY * cosPitch - yawZ * sinPitch;
    const pitchZ = yawY * sinPitch + yawZ * cosPitch;

    return { yawX, pitchY, pitchZ };
  }

  function projectPointWithState(point, bounds, size, state) {
    const rotated = rotateCenteredPoint(point, bounds, state);
    const scale = getProjectionScale(bounds, size, state);
    return {
      x: size.width / 2 + state.panX + rotated.yawX * scale,
      y: size.height / 2 + state.panY - rotated.pitchZ * scale,
      depth: rotated.pitchY,
    };
  }

  function resolveScreenAnchorWorld(anchorScreen, bounds, size, state) {
    const scale = getProjectionScale(bounds, size, state);
    const yawX = (anchorScreen.x - size.width / 2 - state.panX) / scale;
    const pitchZ = -(anchorScreen.y - size.height / 2 - state.panY) / scale;
    const pitchY = 0;

    const cosPitch = Math.cos(state.pitch);
    const sinPitch = Math.sin(state.pitch);
    const yawY = pitchY * cosPitch + pitchZ * sinPitch;
    const yawZ = -pitchY * sinPitch + pitchZ * cosPitch;

    const cosYaw = Math.cos(state.yaw);
    const sinYaw = Math.sin(state.yaw);
    const centeredX = yawX * cosYaw + yawY * sinYaw;
    const centeredY = yawY * cosYaw - yawX * sinYaw;

    return {
      x: bounds.centerX + centeredX,
      y: bounds.centerY + centeredY,
      z: bounds.centerZ + yawZ,
    };
  }

  function keepAnchorFixed(state, anchorWorld, anchorScreen, bounds, size) {
    const projected = projectPointWithState(anchorWorld, bounds, size, state);
    state.panX += anchorScreen.x - projected.x;
    state.panY += anchorScreen.y - projected.y;
    return state;
  }

  function makeAnchorState(anchorScreen, bounds, size, state) {
    return {
      screen: { x: anchorScreen.x, y: anchorScreen.y },
      world: resolveScreenAnchorWorld(anchorScreen, bounds, size, state),
    };
  }

  function prepareAnchoredRotation(state, anchorScreen, bounds, size) {
    if (!bounds || !size || !anchorScreen) {
      state.rotationAnchor = null;
      return state;
    }
    state.rotationAnchor = makeAnchorState(anchorScreen, bounds, size, state);
    return state;
  }

  function applyAnchoredZoom(state, anchorScreen, scale, bounds, size) {
    if (!bounds || !size || !anchorScreen) {
      state.zoom = clamp(state.zoom * scale, 0.25, 8);
      return state;
    }
    const anchorWorld = resolveScreenAnchorWorld(anchorScreen, bounds, size, state);
    state.zoom = clamp(state.zoom * scale, 0.25, 8);
    keepAnchorFixed(state, anchorWorld, anchorScreen, bounds, size);
    return state;
  }

  function setOverlayState(state, currentMarkers = [], bodyAxes = null) {
    state.currentMarkers = currentMarkers || [];
    state.bodyAxes = buildBodyAxisSegments(bodyAxes);
    return state;
  }

  function buildBodyAxisSegments(bodyAxes) {
    if (!bodyAxes || !bodyAxes.origin || !bodyAxes.axes) {
      return [];
    }
    const length = bodyAxes.length || 5;
    const specs = [
      { key: 'forward', label: 'F', color: '#ef4444' },
      { key: 'right', label: 'R', color: '#22c55e' },
      { key: 'down', label: 'D', color: '#3b82f6' },
    ];
    const segments = specs
      .map((spec) => {
        const vector = bodyAxes.axes[spec.key];
        if (!vector) {
          return null;
        }
        return {
          label: spec.label,
          color: spec.color,
          lineWidth: 3,
          showEndpoint: true,
          showLabel: true,
          start: bodyAxes.origin,
          end: {
            x: bodyAxes.origin.x + vector.x * length,
            y: bodyAxes.origin.y + vector.y * length,
            z: bodyAxes.origin.z + vector.z * length,
          },
        };
      })
      .filter(Boolean);
    if (bodyAxes.sightline) {
      segments.push({
        label: 'LOS',
        color: '#facc15',
        lineWidth: 2,
        showEndpoint: false,
        showLabel: false,
        start: bodyAxes.origin,
        end: {
          x: bodyAxes.origin.x + bodyAxes.sightline.x * (bodyAxes.sightlineLength || length),
          y: bodyAxes.origin.y + bodyAxes.sightline.y * (bodyAxes.sightlineLength || length),
          z: bodyAxes.origin.z + bodyAxes.sightline.z * (bodyAxes.sightlineLength || length),
        },
      });
    }
    return segments;
  }

  function averageDepth(first, second) {
    return (((first && first.depth) || 0) + ((second && second.depth) || 0)) / 2;
  }

  function createPointRenderable(point, options = {}) {
    return {
      kind: 'point',
      point,
      depth: options.depth != null ? options.depth : ((point && point.depth) || 0),
      layer: options.layer || 0,
      radius: options.radius || 4,
      fillStyle: options.fillStyle || '#e5e7eb',
      strokeStyle: options.strokeStyle || null,
      lineWidth: options.lineWidth || 0,
    };
  }

  function createLabelRenderable(point, options = {}) {
    return {
      kind: 'label',
      x: point.x,
      y: point.y,
      depth: options.depth != null ? options.depth : ((point && point.depth) || 0),
      layer: options.layer || 0,
      text: options.text || '',
      color: options.color || 'rgba(229, 231, 235, 0.95)',
      font: options.font || '12px \"Microsoft YaHei UI\", sans-serif',
      dx: options.dx || 0,
      dy: options.dy || 0,
    };
  }

  function sortSceneDrawables(drawables) {
    return [...(drawables || [])].sort((left, right) => {
      const depthDelta = (right.depth || 0) - (left.depth || 0);
      if (Math.abs(depthDelta) > 1e-9) {
        return depthDelta;
      }
      return (left.layer || 0) - (right.layer || 0);
    });
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '—';
  }

  function formatSeconds(value) {
    return Number.isFinite(value) ? value.toFixed(3) : '—';
  }

  return {
    TrajectoryViewer3D,
    applyAnchoredZoom,
    createInteractionState,
    prepareAnchoredRotation,
    projectPointWithState,
    resolveScreenAnchorWorld,
    setOverlayState,
    sortSceneDrawables,
    updateInteractionDrag,
  };
});
