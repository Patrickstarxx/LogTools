const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeLocalSamples,
  normalizeGlobalSamples,
  chooseGlobalReference,
  buildTrackSummary,
  buildTimeRange,
  countTrackPointsAtOrBefore,
  computeLocalOriginOffsets,
  computeRelativeMetrics,
  findNearestAtOrBefore,
  normalizeLatLon,
  computeSightlineVector,
  quaternionToFrdAxes,
  resolveAttitudeConvention,
  sliceTrackAtTime,
} = require('../assets/trajectory.js');

test('local NED samples are converted to ENU plot coordinates', () => {
  const track = normalizeLocalSamples([
    { timestamp: 1000000, x: 1, y: 2, z: -3 },
    { timestamp: 2000000, x: -4, y: 5, z: 6 },
  ]);

  assert.deepEqual(track.points, [
    { t: 1000000, x: 2, y: 1, z: 3, raw: { x: 1, y: 2, z: -3 } },
    { t: 2000000, x: 5, y: -4, z: -6, raw: { x: -4, y: 5, z: 6 } },
  ]);
  assert.equal(track.mode, 'local');
});

test('local normalization filters non-finite coordinates', () => {
  const track = normalizeLocalSamples([
    { timestamp: 1000000, x: 0, y: 0, z: 0 },
    { timestamp: 2000000, x: Number.NaN, y: 1, z: 2 },
    { timestamp: 3000000, x: 3, y: Number.POSITIVE_INFINITY, z: 4 },
  ]);

  assert.equal(track.points.length, 1);
  assert.equal(track.points[0].t, 1000000);
});

test('PX4 integer latitude and longitude values are normalized', () => {
  assert.equal(normalizeLatLon(225432109), 22.5432109);
  assert.equal(normalizeLatLon(113.9123456), 113.9123456);
});

test('global samples convert to ENU meters relative to reference', () => {
  const ref = { lat: 22.0, lon: 114.0, alt: 30 };
  const oneMeterNorthInDeg = 1 / 6371000 * 180 / Math.PI;
  const oneMeterEastInDeg = 1 / (6371000 * Math.cos(22.0 * Math.PI / 180)) * 180 / Math.PI;

  const track = normalizeGlobalSamples([
    {
      timestamp: 1000000,
      lat: 22.0 + oneMeterNorthInDeg,
      lon: 114.0 + oneMeterEastInDeg,
      alt: 32.5,
    },
  ], ref);

  assert.equal(track.mode, 'global');
  assert.equal(track.points.length, 1);
  assert.ok(Math.abs(track.points[0].x - 1) < 0.01);
  assert.ok(Math.abs(track.points[0].y - 1) < 0.01);
  assert.ok(Math.abs(track.points[0].z - 2.5) < 0.000001);
});

test('global reference is chosen from earliest available point across logs', () => {
  const ref = chooseGlobalReference([
    { globalRaw: [{ timestamp: 3000000, lat: 22, lon: 114, alt: 10 }] },
    { globalRaw: [{ timestamp: 1000000, lat: 23, lon: 115, alt: 20 }] },
  ]);

  assert.deepEqual(ref, { lat: 23, lon: 115, alt: 20 });
});

test('track summary computes point count and duration from timestamps', () => {
  const summary = buildTrackSummary({
    points: [
      { t: 1000000, x: 0, y: 0, z: 0 },
      { t: 4500000, x: 1, y: 1, z: 1 },
    ],
  });

  assert.equal(summary.pointCount, 2);
  assert.equal(summary.startSeconds, 1);
  assert.equal(summary.endSeconds, 4.5);
  assert.equal(summary.durationSeconds, 3.5);
});

test('track can be sliced up to a current timestamp', () => {
  const track = {
    mode: 'local',
    points: [
      { t: 1000000, x: 0, y: 0, z: 0 },
      { t: 2000000, x: 1, y: 0, z: 0 },
      { t: 3000000, x: 2, y: 0, z: 0 },
    ],
  };

  const sliced = sliceTrackAtTime(track, 2500000);

  assert.deepEqual(sliced.points.map((point) => point.t), [1000000, 2000000]);
  assert.equal(sliced.mode, 'local');
});

test('track visible point count is found without slicing the point array', () => {
  const track = {
    points: [
      { t: 100 },
      { t: 200 },
      { t: 300 },
    ],
  };

  assert.equal(countTrackPointsAtOrBefore(track, 50), 0);
  assert.equal(countTrackPointsAtOrBefore(track, 200), 2);
  assert.equal(countTrackPointsAtOrBefore(track, 250), 2);
  assert.equal(countTrackPointsAtOrBefore(track, 500), 3);
});

test('nearest sample at or before current time is selected', () => {
  const sample = findNearestAtOrBefore([
    { timestamp: 100, value: 'a' },
    { timestamp: 250, value: 'b' },
    { timestamp: 500, value: 'c' },
  ], 300);

  assert.equal(sample.value, 'b');
});

test('time range spans multiple tracks', () => {
  const range = buildTimeRange([
    { points: [{ t: 500 }, { t: 900 }] },
    { points: [{ t: 100 }, { t: 700 }] },
  ]);

  assert.deepEqual(range, { startUs: 100, endUs: 900, durationUs: 800 });
});

test('local origin offsets use first global points to keep different starts apart', () => {
  const oneMeterNorthInDeg = 1 / 6371000 * 180 / Math.PI;
  const offsets = computeLocalOriginOffsets([
    { globalRaw: [{ timestamp: 10, lat: 22, lon: 114, alt: 30 }] },
    { globalRaw: [{ timestamp: 10, lat: 22 + oneMeterNorthInDeg, lon: 114, alt: 35 }] },
  ]);

  assert.ok(Math.abs(offsets[0].x) < 0.000001);
  assert.ok(Math.abs(offsets[0].y) < 0.000001);
  assert.ok(Math.abs(offsets[0].z) < 0.000001);
  assert.ok(Math.abs(offsets[1].x) < 0.01);
  assert.ok(Math.abs(offsets[1].y - 1) < 0.01);
  assert.ok(Math.abs(offsets[1].z - 5) < 0.000001);
});

test('local samples accept an origin offset', () => {
  const track = normalizeLocalSamples([
    { timestamp: 1000000, x: 10, y: 20, z: -5 },
  ], { x: 2, y: 3, z: 4 });

  assert.deepEqual(track.points[0], {
    t: 1000000,
    x: 22,
    y: 13,
    z: 9,
    raw: { x: 10, y: 20, z: -5 },
  });
});

test('identity quaternion maps FRD body axes into ENU plot coordinates', () => {
  const axes = quaternionToFrdAxes([1, 0, 0, 0]);

  assert.deepEqual(axes.forward, { x: 0, y: 1, z: 0 });
  assert.deepEqual(axes.right, { x: 1, y: 0, z: 0 });
  assert.deepEqual(axes.down, { x: 0, y: 0, z: -1 });
});

test('relative position metrics report B minus A in NED and drone A FRD axes', () => {
  const axes = quaternionToFrdAxes([1, 0, 0, 0]);
  const metrics = computeRelativeMetrics(
    { x: 10, y: 20, z: 30 },
    { x: 13, y: 24, z: 18 },
    axes,
  );

  assert.equal(metrics.euclideanDistance, 13);
  assert.deepEqual(metrics.ned, { north: 4, east: 3, down: 12 });
  assert.deepEqual(metrics.frd, { forward: 4, right: 3, down: 12 });
});

test('relative position metrics keep NED data when drone A attitude is unavailable', () => {
  const metrics = computeRelativeMetrics(
    { x: 0, y: 0, z: 0 },
    { x: -2, y: 5, z: 7 },
    null,
  );

  assert.ok(Math.abs(metrics.euclideanDistance - Math.sqrt(78)) < 1e-12);
  assert.deepEqual(metrics.ned, { north: 5, east: -2, down: -7 });
  assert.equal(metrics.frd, null);
});

test('relative position metrics reject incomplete positions', () => {
  assert.equal(computeRelativeMetrics({ x: 0, y: 0 }, { x: 1, y: 2, z: 3 }), null);
});

test('sightline angle rotates from F toward minus D for positive angles', () => {
  const vector = computeSightlineVector({
    forward: { x: 0, y: 1, z: 0 },
    down: { x: 0, y: 0, z: -1 },
  }, 90);

  assert.deepEqual(vector, { x: 0, y: 0, z: 1 });
});

test('sightline angle rotates from F toward plus D for negative angles', () => {
  const vector = computeSightlineVector({
    forward: { x: 0, y: 1, z: 0 },
    down: { x: 0, y: 0, z: -1 },
  }, -90);

  assert.deepEqual(vector, { x: 0, y: 0, z: -1 });
});

test('attitude convention is resolved from ULog heading when direct quaternion matches heading', () => {
  const yawEast = Math.PI / 2;
  const qBodyToNed = [Math.cos(yawEast / 2), 0, 0, Math.sin(yawEast / 2)];

  const result = resolveAttitudeConvention(
    [{ timestamp: 1000, q: qBodyToNed }],
    [{ timestamp: 1000, heading: yawEast }],
  );

  assert.equal(result.convention, 'body_to_ned');
  assert.equal(result.source, 'vehicle_local_position.heading');
});

test('attitude convention is resolved from ULog heading when inverse quaternion matches heading', () => {
  const yawEast = Math.PI / 2;
  const qNedToBody = [Math.cos(yawEast / 2), 0, 0, -Math.sin(yawEast / 2)];

  const result = resolveAttitudeConvention(
    [{ timestamp: 1000, q: qNedToBody }],
    [{ timestamp: 1000, heading: yawEast }],
  );

  assert.equal(result.convention, 'ned_to_body');
  assert.equal(result.source, 'vehicle_local_position.heading');
});

test('inverse convention flips the yaw direction before drawing FRD axes', () => {
  const yawEast = Math.PI / 2;
  const qNedToBody = [Math.cos(yawEast / 2), 0, 0, -Math.sin(yawEast / 2)];

  const axes = quaternionToFrdAxes(qNedToBody, 'ned_to_body');

  assert.ok(Math.abs(axes.forward.x - 1) < 1e-12);
  assert.ok(Math.abs(axes.forward.y) < 1e-12);
});
