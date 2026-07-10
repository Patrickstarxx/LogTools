(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.PX4Trajectory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EARTH_RADIUS_METERS = 6371000;

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function toNumber(value) {
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return Number(value);
    }
    return value;
  }

  function normalizeTimestamp(sample) {
    const timestamp = toNumber(sample.timestamp ?? sample.timestamp_sample ?? sample.time_us ?? sample.t);
    return isFiniteNumber(timestamp) ? timestamp : 0;
  }

  function normalizeLocalSamples(samples, originOffset = { x: 0, y: 0, z: 0 }) {
    const points = [];
    for (const sample of samples || []) {
      const north = toNumber(sample.x);
      const east = toNumber(sample.y);
      const down = toNumber(sample.z);
      if (!isFiniteNumber(north) || !isFiniteNumber(east) || !isFiniteNumber(down)) {
        continue;
      }
      const enu = nedToEnu({ x: north, y: east, z: down });
      points.push({
        t: normalizeTimestamp(sample),
        x: enu.x + (originOffset.x || 0),
        y: enu.y + (originOffset.y || 0),
        z: enu.z + (originOffset.z || 0),
        raw: { x: north, y: east, z: down },
      });
    }
    return { mode: 'local', points };
  }

  function normalizeLatLon(value) {
    const numeric = toNumber(value);
    if (!isFiniteNumber(numeric)) {
      return Number.NaN;
    }
    if (Math.abs(numeric) > 1000) {
      return numeric / 1e7;
    }
    return numeric;
  }

  function normalizeAltitude(value) {
    const numeric = toNumber(value);
    if (!isFiniteNumber(numeric)) {
      return Number.NaN;
    }
    if (Math.abs(numeric) > 10000) {
      return numeric / 1000;
    }
    return numeric;
  }

  function getAltitude(sample) {
    return normalizeAltitude(sample.alt ?? sample.alt_ellipsoid ?? sample.terrain_alt);
  }

  function normalizeGlobalPoint(sample) {
    const lat = normalizeLatLon(sample.lat ?? sample.latitude);
    const lon = normalizeLatLon(sample.lon ?? sample.lng ?? sample.longitude);
    const alt = getAltitude(sample);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || !isFiniteNumber(alt)) {
      return null;
    }
    return {
      timestamp: normalizeTimestamp(sample),
      lat,
      lon,
      alt,
    };
  }

  function chooseGlobalReference(logs) {
    const candidates = [];
    for (const log of logs || []) {
      const samples = log.globalRaw || log.globalTrajectory || log.samples || [];
      for (const sample of samples) {
        const point = normalizeGlobalPoint(sample);
        if (point) {
          candidates.push(point);
        }
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => a.timestamp - b.timestamp);
    const first = candidates[0];
    return { lat: first.lat, lon: first.lon, alt: first.alt };
  }

  function normalizeGlobalSamples(samples, reference) {
    const ref = reference || chooseGlobalReference([{ globalRaw: samples }]);
    if (!ref) {
      return { mode: 'global', points: [] };
    }

    const refLatRad = ref.lat * Math.PI / 180;
    const points = [];
    for (const sample of samples || []) {
      const point = normalizeGlobalPoint(sample);
      if (!point) {
        continue;
      }
      const deltaLat = (point.lat - ref.lat) * Math.PI / 180;
      const deltaLon = (point.lon - ref.lon) * Math.PI / 180;
      points.push({
        t: point.timestamp,
        x: deltaLon * Math.cos(refLatRad) * EARTH_RADIUS_METERS,
        y: deltaLat * EARTH_RADIUS_METERS,
        z: point.alt - ref.alt,
        raw: point,
      });
    }
    return { mode: 'global', points };
  }

  function sliceTrackAtTime(track, timeUs) {
    const points = ((track && track.points) || []).filter((point) => point.t <= timeUs);
    return {
      ...track,
      points,
    };
  }

  function findNearestAtOrBefore(samples, timeUs) {
    let best = null;
    for (const sample of samples || []) {
      const timestamp = normalizeTimestamp(sample);
      if (timestamp <= timeUs && (!best || timestamp > normalizeTimestamp(best))) {
        best = sample;
      }
    }
    return best;
  }

  function buildTimeRange(tracks) {
    const timestamps = [];
    for (const track of tracks || []) {
      for (const point of (track && track.points) || []) {
        if (isFiniteNumber(point.t)) {
          timestamps.push(point.t);
        }
      }
    }
    if (timestamps.length === 0) {
      return { startUs: 0, endUs: 0, durationUs: 0 };
    }
    const startUs = Math.min(...timestamps);
    const endUs = Math.max(...timestamps);
    return { startUs, endUs, durationUs: endUs - startUs };
  }

  function firstGlobalPoint(log) {
    const points = [];
    for (const sample of (log && log.globalRaw) || []) {
      const point = normalizeGlobalPoint(sample);
      if (point) {
        points.push(point);
      }
    }
    if (points.length === 0) {
      return null;
    }
    points.sort((a, b) => a.timestamp - b.timestamp);
    return points[0];
  }

  function computeLocalOriginOffsets(logs) {
    const firstPoints = (logs || []).map(firstGlobalPoint);
    const reference = firstPoints.find(Boolean);
    if (!reference) {
      return (logs || []).map(() => ({ x: 0, y: 0, z: 0, available: false }));
    }
    return firstPoints.map((point) => {
      if (!point) {
        return { x: 0, y: 0, z: 0, available: false };
      }
      const track = normalizeGlobalSamples([point], reference);
      const offset = track.points[0] || { x: 0, y: 0, z: 0 };
      return { x: offset.x, y: offset.y, z: offset.z, available: true };
    });
  }

  function quaternionToFrdAxes(q, convention = 'body_to_ned') {
    if (!Array.isArray(q) || q.length < 4) {
      return null;
    }
    let [w0, x0, y0, z0] = q.map(toNumber);
    if (convention === 'ned_to_body') {
      x0 = -x0;
      y0 = -y0;
      z0 = -z0;
    }
    const norm = Math.hypot(w0, x0, y0, z0);
    if (!Number.isFinite(norm) || norm === 0) {
      return null;
    }
    const w = w0 / norm;
    const x = x0 / norm;
    const y = y0 / norm;
    const z = z0 / norm;

    const rotate = (vector) => {
      const [vx, vy, vz] = vector;
      const ix = w * vx + y * vz - z * vy;
      const iy = w * vy + z * vx - x * vz;
      const iz = w * vz + x * vy - y * vx;
      const iw = -x * vx - y * vy - z * vz;
      const rx = ix * w + iw * -x + iy * -z - iz * -y;
      const ry = iy * w + iw * -y + iz * -x - ix * -z;
      const rz = iz * w + iw * -z + ix * -y - iy * -x;
      return nedToEnu({ x: rx, y: ry, z: rz });
    };

    return {
      forward: normalizeVector(rotate([1, 0, 0])),
      right: normalizeVector(rotate([0, 1, 0])),
      down: normalizeVector(rotate([0, 0, 1])),
    };
  }

  function computeSightlineVector(axes, angleDegrees) {
    if (!axes || !axes.forward || !axes.down) {
      return null;
    }
    const angleRadians = toNumber(angleDegrees) * Math.PI / 180;
    if (!Number.isFinite(angleRadians)) {
      return normalizeVector(axes.forward);
    }
    const cos = Math.cos(angleRadians);
    const sin = Math.sin(angleRadians);
    return normalizeVector({
      x: axes.forward.x * cos - axes.down.x * sin,
      y: axes.forward.y * cos - axes.down.y * sin,
      z: axes.forward.z * cos - axes.down.z * sin,
    });
  }

  function resolveAttitudeConvention(attitudeSamples, localSamples) {
    const headingSamples = (localSamples || [])
      .map((sample) => ({ timestamp: normalizeTimestamp(sample), heading: toNumber(sample.heading) }))
      .filter((sample) => isFiniteNumber(sample.heading));
    const candidates = [];
    for (const attitude of attitudeSamples || []) {
      if (!attitude.q) {
        continue;
      }
      const local = findNearestAtOrBefore(headingSamples, normalizeTimestamp(attitude));
      if (!local) {
        continue;
      }
      candidates.push({
        q: attitude.q,
        heading: local.heading,
      });
      if (candidates.length >= 25) {
        break;
      }
    }
    if (candidates.length === 0) {
      return {
        convention: 'body_to_ned',
        source: 'PX4 fallback: vehicle_attitude.q assumed body-to-NED',
        confidence: 0,
      };
    }

    const directError = averageHeadingError(candidates, 'body_to_ned');
    const inverseError = averageHeadingError(candidates, 'ned_to_body');
    return {
      convention: directError <= inverseError ? 'body_to_ned' : 'ned_to_body',
      source: 'vehicle_local_position.heading',
      confidence: Math.abs(directError - inverseError),
      directError,
      inverseError,
    };
  }

  function averageHeadingError(candidates, convention) {
    const errors = candidates.map((candidate) => {
      const axes = quaternionToFrdAxes(candidate.q, convention);
      if (!axes) {
        return Math.PI;
      }
      const yaw = Math.atan2(axes.forward.x, axes.forward.y);
      return Math.abs(wrapPi(yaw - candidate.heading));
    });
    return errors.reduce((sum, value) => sum + value, 0) / errors.length;
  }

  function nedToEnu(point) {
    return {
      x: point.y,
      y: point.x,
      z: -point.z,
    };
  }

  function wrapPi(angle) {
    let wrapped = angle;
    while (wrapped > Math.PI) wrapped -= Math.PI * 2;
    while (wrapped < -Math.PI) wrapped += Math.PI * 2;
    return wrapped;
  }

  function normalizeVector(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z);
    if (!Number.isFinite(length) || length === 0) {
      return { x: 0, y: 0, z: 0 };
    }
    return {
      x: cleanZero(vector.x / length),
      y: cleanZero(vector.y / length),
      z: cleanZero(vector.z / length),
    };
  }

  function cleanZero(value) {
    return Math.abs(value) < 1e-12 ? 0 : value;
  }

  function buildTrackSummary(track) {
    const points = (track && track.points) || [];
    if (points.length === 0) {
      return {
        pointCount: 0,
        startSeconds: null,
        endSeconds: null,
        durationSeconds: null,
      };
    }
    const timestamps = points.map((point) => point.t).filter(isFiniteNumber);
    const startUs = Math.min(...timestamps);
    const endUs = Math.max(...timestamps);
    return {
      pointCount: points.length,
      startSeconds: startUs / 1e6,
      endSeconds: endUs / 1e6,
      durationSeconds: (endUs - startUs) / 1e6,
    };
  }

  function computeBounds(tracks) {
    const all = [];
    for (const track of tracks || []) {
      for (const point of (track && track.points) || []) {
        if (isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z)) {
          all.push(point);
        }
      }
    }
    if (all.length === 0) {
      return null;
    }
    const bounds = {
      minX: Math.min(...all.map((point) => point.x)),
      maxX: Math.max(...all.map((point) => point.x)),
      minY: Math.min(...all.map((point) => point.y)),
      maxY: Math.max(...all.map((point) => point.y)),
      minZ: Math.min(...all.map((point) => point.z)),
      maxZ: Math.max(...all.map((point) => point.z)),
    };
    bounds.centerX = (bounds.minX + bounds.maxX) / 2;
    bounds.centerY = (bounds.minY + bounds.maxY) / 2;
    bounds.centerZ = (bounds.minZ + bounds.maxZ) / 2;
    bounds.span = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      bounds.maxZ - bounds.minZ,
      1,
    );
    return bounds;
  }

  return {
    EARTH_RADIUS_METERS,
    buildTimeRange,
    normalizeLocalSamples,
    normalizeGlobalSamples,
    chooseGlobalReference,
    computeLocalOriginOffsets,
    findNearestAtOrBefore,
    buildTrackSummary,
    normalizeLatLon,
    normalizeGlobalPoint,
    computeSightlineVector,
    quaternionToFrdAxes,
    resolveAttitudeConvention,
    sliceTrackAtTime,
    computeBounds,
  };
});
