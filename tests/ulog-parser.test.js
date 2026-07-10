const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TYPE_SIZES,
  parseFormatDefinition,
  decodeRecord,
  parseUlog,
  buildTopicStatus,
} = require('../assets/ulog-parser.js');

test('PX4 primitive type sizes are exposed', () => {
  assert.equal(TYPE_SIZES.uint8_t, 1);
  assert.equal(TYPE_SIZES.int16_t, 2);
  assert.equal(TYPE_SIZES.uint64_t, 8);
  assert.equal(TYPE_SIZES.float, 4);
  assert.equal(TYPE_SIZES.double, 8);
  assert.equal(TYPE_SIZES.bool, 1);
});

test('format definition parses scalar and array fields', () => {
  const parsed = parseFormatDefinition('vehicle_local_position:uint64_t timestamp;float x;float y;float z;uint8_t _padding0[4];');

  assert.equal(parsed.name, 'vehicle_local_position');
  assert.deepEqual(parsed.fields.map((field) => ({
    type: field.type,
    name: field.name,
    arrayLength: field.arrayLength,
    size: field.size,
  })), [
    { type: 'uint64_t', name: 'timestamp', arrayLength: 1, size: 8 },
    { type: 'float', name: 'x', arrayLength: 1, size: 4 },
    { type: 'float', name: 'y', arrayLength: 1, size: 4 },
    { type: 'float', name: 'z', arrayLength: 1, size: 4 },
    { type: 'uint8_t', name: '_padding0', arrayLength: 4, size: 4 },
  ]);
  assert.equal(parsed.size, 24);
});

test('format definition supports PX4 array length on the type token', () => {
  const parsed = parseFormatDefinition('vehicle_attitude:uint64_t timestamp;float[4] q;uint8_t[2] _padding0;');

  assert.deepEqual(parsed.fields.map((field) => ({
    type: field.type,
    name: field.name,
    arrayLength: field.arrayLength,
    size: field.size,
  })), [
    { type: 'uint64_t', name: 'timestamp', arrayLength: 1, size: 8 },
    { type: 'float', name: 'q', arrayLength: 4, size: 16 },
    { type: 'uint8_t', name: '_padding0', arrayLength: 2, size: 2 },
  ]);
  assert.equal(parsed.size, 26);
});

test('record decoder reads a little-endian binary payload', () => {
  const format = parseFormatDefinition('vehicle_local_position:uint64_t timestamp;float x;float y;float z;');
  const bytes = new Uint8Array(format.size);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 1234567n, true);
  view.setFloat32(8, 1.25, true);
  view.setFloat32(12, -2.5, true);
  view.setFloat32(16, 3.75, true);

  assert.deepEqual(decodeRecord(view, 0, format), {
    timestamp: 1234567,
    x: 1.25,
    y: -2.5,
    z: 3.75,
  });
});

test('synthetic ULog extracts local and global trajectories', () => {
  const file = makeSyntheticUlog();
  const parsed = parseUlog(file.buffer);

  assert.equal(parsed.topics.vehicle_local_position.available, true);
  assert.equal(parsed.topics.vehicle_global_position.available, true);
  assert.equal(parsed.topics.vehicle_attitude.available, true);
  assert.equal(parsed.localTrajectory.points.length, 1);
  assert.equal(parsed.globalTrajectory.points.length, 1);
  assert.equal(parsed.attitudeRaw.length, 1);
  assert.deepEqual(parsed.localRaw[0], {
    timestamp: 1000000,
    x: 10,
    y: 20,
    z: -30,
  });
  assert.deepEqual(parsed.globalRaw[0], {
    timestamp: 1000000,
    lat: 225432109,
    lon: 1139123456,
    alt: 120500,
  });
  assert.deepEqual(parsed.attitudeRaw[0], {
    timestamp: 1000000,
    q: [1, 0, 0, 0],
  });
});

test('topic status reports missing topics clearly', () => {
  const status = buildTopicStatus({ vehicle_local_position: { samples: 2 } });

  assert.equal(status.vehicle_local_position.available, true);
  assert.equal(status.vehicle_local_position.samples, 2);
  assert.equal(status.vehicle_global_position.available, false);
  assert.equal(status.vehicle_global_position.samples, 0);
});

function makeSyntheticUlog() {
  const chunks = [];
  chunks.push(Uint8Array.from([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35, 0x01]));
  const timestamp = new Uint8Array(8);
  new DataView(timestamp.buffer).setBigUint64(0, 0n, true);
  chunks.push(timestamp);

  pushMessage(chunks, 'F', textBytes('vehicle_local_position:uint64_t timestamp;float x;float y;float z;'));
  pushMessage(chunks, 'F', textBytes('vehicle_global_position:uint64_t timestamp;int32_t lat;int32_t lon;int32_t alt;'));
  pushMessage(chunks, 'F', textBytes('vehicle_attitude:uint64_t timestamp;float[4] q;'));

  const addLocal = new Uint8Array(3 + 'vehicle_local_position'.length);
  let view = new DataView(addLocal.buffer);
  view.setUint8(0, 0);
  view.setUint16(1, 1, true);
  addLocal.set(textBytes('vehicle_local_position'), 3);
  pushMessage(chunks, 'A', addLocal);

  const addGlobal = new Uint8Array(3 + 'vehicle_global_position'.length);
  view = new DataView(addGlobal.buffer);
  view.setUint8(0, 0);
  view.setUint16(1, 2, true);
  addGlobal.set(textBytes('vehicle_global_position'), 3);
  pushMessage(chunks, 'A', addGlobal);

  const addAttitude = new Uint8Array(3 + 'vehicle_attitude'.length);
  view = new DataView(addAttitude.buffer);
  view.setUint8(0, 0);
  view.setUint16(1, 3, true);
  addAttitude.set(textBytes('vehicle_attitude'), 3);
  pushMessage(chunks, 'A', addAttitude);

  const localData = new Uint8Array(2 + 20);
  view = new DataView(localData.buffer);
  view.setUint16(0, 1, true);
  view.setBigUint64(2, 1000000n, true);
  view.setFloat32(10, 10, true);
  view.setFloat32(14, 20, true);
  view.setFloat32(18, -30, true);
  pushMessage(chunks, 'D', localData);

  const globalData = new Uint8Array(2 + 20);
  view = new DataView(globalData.buffer);
  view.setUint16(0, 2, true);
  view.setBigUint64(2, 1000000n, true);
  view.setInt32(10, 225432109, true);
  view.setInt32(14, 1139123456, true);
  view.setInt32(18, 120500, true);
  pushMessage(chunks, 'D', globalData);

  const attitudeData = new Uint8Array(2 + 24);
  view = new DataView(attitudeData.buffer);
  view.setUint16(0, 3, true);
  view.setBigUint64(2, 1000000n, true);
  view.setFloat32(10, 1, true);
  view.setFloat32(14, 0, true);
  view.setFloat32(18, 0, true);
  view.setFloat32(22, 0, true);
  pushMessage(chunks, 'D', attitudeData);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pushMessage(chunks, type, payload) {
  const header = new Uint8Array(3);
  const view = new DataView(header.buffer);
  view.setUint16(0, payload.length, true);
  view.setUint8(2, type.charCodeAt(0));
  chunks.push(header, payload);
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}
