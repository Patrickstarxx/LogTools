const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAnchoredZoom,
  createInteractionState,
  prepareAnchoredRotation,
  projectPointWithState,
  resolveScreenAnchorWorld,
  sortSceneDrawables,
  updateInteractionDrag,
} = require('../assets/viewer3d.js');

test('left-button drag pans the view in screen space', () => {
  const state = createInteractionState();
  state.mode = 'pan';
  state.lastPointer = { x: 100, y: 120 };

  updateInteractionDrag(state, { x: 135, y: 90 });

  assert.equal(state.panX, 35);
  assert.equal(state.panY, -30);
  assert.equal(state.yaw, -0.72);
  assert.equal(state.pitch, 0.48);
});

test('right-button drag rotates the view', () => {
  const state = createInteractionState();
  state.mode = 'rotate';
  state.lastPointer = { x: 100, y: 120 };

  updateInteractionDrag(state, { x: 150, y: 150 });

  assert.equal(state.panX, 0);
  assert.equal(state.panY, 0);
  assert.ok(state.yaw > -0.72);
  assert.ok(state.pitch > 0.48);
});

test('wheel zoom keeps the mouse anchor fixed on screen', () => {
  const state = createInteractionState();
  const bounds = makeBounds();
  const size = { width: 800, height: 600 };
  const anchor = { x: 520, y: 340 };
  const anchorWorld = resolveScreenAnchorWorld(anchor, bounds, size, state);

  applyAnchoredZoom(state, anchor, 1.8, bounds, size);
  const projected = projectPointWithState(anchorWorld, bounds, size, state);

  assert.ok(Math.abs(projected.x - anchor.x) < 0.000001);
  assert.ok(Math.abs(projected.y - anchor.y) < 0.000001);
});

test('right-button rotation keeps the mouse anchor fixed on screen', () => {
  const state = createInteractionState();
  const bounds = makeBounds();
  const size = { width: 800, height: 600 };
  const anchor = { x: 520, y: 340 };
  const anchorWorld = resolveScreenAnchorWorld(anchor, bounds, size, state);
  state.mode = 'rotate';
  state.lastPointer = { x: 500, y: 330 };

  updateInteractionDrag(state, anchor, { bounds, size, anchorScreen: anchor });
  const projected = projectPointWithState(anchorWorld, bounds, size, state);

  assert.ok(Math.abs(projected.x - anchor.x) < 0.000001);
  assert.ok(Math.abs(projected.y - anchor.y) < 0.000001);
});

test('right-button rotation uses the mouse-down anchor, not the moving pointer', () => {
  const state = createInteractionState();
  const bounds = makeBounds();
  const size = { width: 800, height: 600 };
  const mouseDownAnchor = { x: 500, y: 320 };
  const movingPointer = { x: 560, y: 360 };
  const anchorWorld = resolveScreenAnchorWorld(mouseDownAnchor, bounds, size, state);
  state.mode = 'rotate';
  state.lastPointer = { x: mouseDownAnchor.x, y: mouseDownAnchor.y };
  prepareAnchoredRotation(state, mouseDownAnchor, bounds, size);

  updateInteractionDrag(state, movingPointer, { bounds, size, anchorScreen: movingPointer });
  const projected = projectPointWithState(anchorWorld, bounds, size, state);

  assert.ok(Math.abs(projected.x - mouseDownAnchor.x) < 0.000001);
  assert.ok(Math.abs(projected.y - mouseDownAnchor.y) < 0.000001);
});

test('default view projects positive north upward on screen', () => {
  const state = createInteractionState();
  const bounds = makeBounds();
  const size = { width: 800, height: 600 };

  const origin = projectPointWithState({ x: 0, y: 0, z: 0 }, bounds, size, state);
  const north = projectPointWithState({ x: 0, y: 1, z: 0 }, bounds, size, state);

  assert.ok(north.y < origin.y);
});

test('viewer state accepts current markers and body axes overlays', () => {
  const state = createInteractionState();
  const markers = [
    { name: '无人机 A', point: { t: 100, x: 1, y: 2, z: 3 }, color: '#38bdf8' },
  ];
  const bodyAxes = {
    origin: { x: 1, y: 2, z: 3 },
    axes: {
      forward: { x: 1, y: 0, z: 0 },
      right: { x: 0, y: 1, z: 0 },
      down: { x: 0, y: 0, z: -1 },
    },
    sightline: { x: 0, y: 0, z: 1 },
    sightlineLength: 7,
    length: 5,
  };

  state.setOverlays(markers, bodyAxes);

  assert.equal(state.currentMarkers.length, 1);
  assert.equal(state.bodyAxes.length, 4);
  assert.equal(state.bodyAxes[0].label, 'F');
  assert.equal(state.bodyAxes[0].color, '#ef4444');
  assert.equal(state.bodyAxes[1].label, 'R');
  assert.equal(state.bodyAxes[1].color, '#22c55e');
  assert.equal(state.bodyAxes[2].label, 'D');
  assert.equal(state.bodyAxes[2].color, '#3b82f6');
  assert.equal(state.bodyAxes[3].label, 'LOS');
  assert.equal(state.bodyAxes[3].color, '#facc15');
  assert.equal(state.bodyAxes[0].lineWidth, 3);
  assert.equal(state.bodyAxes[3].lineWidth, 2);
  assert.equal(state.bodyAxes[0].showEndpoint, true);
  assert.equal(state.bodyAxes[3].showEndpoint, false);
  assert.equal(state.bodyAxes[3].showLabel, false);
  assert.deepEqual(state.bodyAxes[3].end, { x: 1, y: 2, z: 10 });
});

test('scene drawables are sorted from far to near by depth', () => {
  const sorted = sortSceneDrawables([
    { id: 'near', depth: 8, layer: 10 },
    { id: 'far', depth: -5, layer: 10 },
    { id: 'mid', depth: 2, layer: 10 },
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ['near', 'mid', 'far']);
});

test('scene drawables with same depth are sorted by layer', () => {
  const sorted = sortSceneDrawables([
    { id: 'label', depth: 4, layer: 70 },
    { id: 'line', depth: 4, layer: 10 },
    { id: 'marker', depth: 4, layer: 40 },
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ['line', 'marker', 'label']);
});

function makeBounds() {
  return {
    centerX: 10,
    centerY: -5,
    centerZ: 2,
    span: 120,
  };
}
