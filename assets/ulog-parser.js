(function (root, factory) {
  const trajectory = typeof require === 'function'
    ? require('./trajectory.js')
    : root.PX4Trajectory;
  const api = factory(trajectory);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.PX4UlogParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (trajectory) {
  const TYPE_SIZES = {
    int8_t: 1,
    uint8_t: 1,
    bool: 1,
    char: 1,
    int16_t: 2,
    uint16_t: 2,
    int32_t: 4,
    uint32_t: 4,
    int64_t: 8,
    uint64_t: 8,
    float: 4,
    double: 8,
  };

  const TARGET_TOPICS = ['vehicle_local_position', 'vehicle_global_position', 'vehicle_attitude'];
  const TEXT_DECODER = new TextDecoder('utf-8');

  function parseFormatDefinition(text) {
    const separator = text.indexOf(':');
    if (separator < 1) {
      throw new Error(`Invalid ULog format definition: ${text}`);
    }
    const name = text.slice(0, separator).trim();
    const body = text.slice(separator + 1);
    const fields = [];
    let offset = 0;

    for (const rawField of body.split(';')) {
      const fieldText = rawField.trim();
      if (!fieldText) {
        continue;
      }
      const field = parseField(fieldText, offset);
      if (!field) {
        continue;
      }
      fields.push(field);
      offset += field.size;
    }

    return { name, fields, size: offset };
  }

  function parseField(fieldText, offset) {
    const match = fieldText.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)])?(?:\s+)([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)])?$/);
    if (!match) {
      return null;
    }
    const [, type, typeArrayLengthText, name, nameArrayLengthText] = match;
    const typeSize = TYPE_SIZES[type];
    if (!typeSize) {
      return null;
    }
    const arrayLengthText = typeArrayLengthText || nameArrayLengthText;
    const arrayLength = arrayLengthText ? Number(arrayLengthText) : 1;
    return {
      type,
      name,
      arrayLength,
      offset,
      size: typeSize * arrayLength,
    };
  }

  function decodeRecord(view, offset, format) {
    const record = {};
    for (const field of format.fields) {
      if (field.name.startsWith('_padding')) {
        continue;
      }
      const fieldOffset = offset + field.offset;
      if (field.arrayLength > 1) {
        record[field.name] = decodeArray(view, fieldOffset, field);
      } else {
        record[field.name] = decodeScalar(view, fieldOffset, field.type);
      }
    }
    return record;
  }

  function decodeArray(view, offset, field) {
    const values = [];
    const stride = TYPE_SIZES[field.type];
    for (let index = 0; index < field.arrayLength; index += 1) {
      values.push(decodeScalar(view, offset + index * stride, field.type));
    }
    if (field.type === 'char') {
      return values
        .map((value) => String.fromCharCode(value))
        .join('')
        .replace(/\0+$/, '');
    }
    return values;
  }

  function decodeScalar(view, offset, type) {
    switch (type) {
      case 'int8_t':
        return view.getInt8(offset);
      case 'uint8_t':
      case 'char':
        return view.getUint8(offset);
      case 'bool':
        return view.getUint8(offset) !== 0;
      case 'int16_t':
        return view.getInt16(offset, true);
      case 'uint16_t':
        return view.getUint16(offset, true);
      case 'int32_t':
        return view.getInt32(offset, true);
      case 'uint32_t':
        return view.getUint32(offset, true);
      case 'int64_t': {
        const value = view.getBigInt64(offset, true);
        return bigintToSafeNumber(value);
      }
      case 'uint64_t': {
        const value = view.getBigUint64(offset, true);
        return bigintToSafeNumber(value);
      }
      case 'float':
        return view.getFloat32(offset, true);
      case 'double':
        return view.getFloat64(offset, true);
      default:
        throw new Error(`Unsupported ULog primitive type: ${type}`);
    }
  }

  function bigintToSafeNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }

  function parseUlog(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    validateHeader(bytes);

    const formats = new Map();
    const subscriptions = new Map();
    const collected = {
      vehicle_local_position: [],
      vehicle_global_position: [],
      vehicle_attitude: [],
    };
    const allTopics = {};
    const warnings = [];

    let offset = 16;
    while (offset + 3 <= bytes.length) {
      const messageSize = view.getUint16(offset, true);
      const messageType = String.fromCharCode(view.getUint8(offset + 2));
      const payloadOffset = offset + 3;
      const nextOffset = payloadOffset + messageSize;
      if (nextOffset > bytes.length) {
        warnings.push(`Truncated ULog message at byte ${offset}.`);
        break;
      }

      try {
        if (messageType === 'F') {
          const text = decodeText(bytes, payloadOffset, messageSize);
          const format = parseFormatDefinition(text);
          formats.set(format.name, format);
          allTopics[format.name] = allTopics[format.name] || { samples: 0 };
        } else if (messageType === 'A') {
          const subscription = parseAddLoggedMessage(view, bytes, payloadOffset, messageSize);
          subscriptions.set(subscription.msgId, subscription);
          allTopics[subscription.name] = allTopics[subscription.name] || { samples: 0 };
        } else if (messageType === 'D') {
          const msgId = view.getUint16(payloadOffset, true);
          const subscription = subscriptions.get(msgId);
          if (subscription) {
            const format = formats.get(subscription.name);
            if (format && TARGET_TOPICS.includes(subscription.name)) {
              const record = decodeRecord(view, payloadOffset + 2, format);
              collected[subscription.name].push(record);
              allTopics[subscription.name] = allTopics[subscription.name] || { samples: 0 };
              allTopics[subscription.name].samples += 1;
            }
          }
        }
      } catch (error) {
        warnings.push(`${messageType} message at byte ${offset}: ${error.message}`);
      }

      offset = nextOffset;
    }

    const localRaw = collected.vehicle_local_position;
    const globalRaw = collected.vehicle_global_position;
    const attitudeRaw = collected.vehicle_attitude;
    return {
      topics: buildTopicStatus(allTopics),
      topicNames: Object.keys(allTopics).sort(),
      localRaw,
      globalRaw,
      attitudeRaw,
      localTrajectory: trajectory.normalizeLocalSamples(localRaw),
      globalTrajectory: trajectory.normalizeGlobalSamples(globalRaw),
      warnings,
    };
  }

  function validateHeader(bytes) {
    const magic = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
    if (bytes.length < 16) {
      throw new Error('File is too small to be a PX4 ULog.');
    }
    for (let index = 0; index < magic.length; index += 1) {
      if (bytes[index] !== magic[index]) {
        throw new Error('Invalid ULog header. Expected a PX4 .ulg file.');
      }
    }
  }

  function parseAddLoggedMessage(view, bytes, offset, size) {
    if (size < 3) {
      throw new Error('Add logged message payload is too small.');
    }
    const multiId = view.getUint8(offset);
    const msgId = view.getUint16(offset + 1, true);
    const name = decodeText(bytes, offset + 3, size - 3).replace(/\0+$/, '');
    return { multiId, msgId, name };
  }

  function decodeText(bytes, offset, size) {
    return TEXT_DECODER.decode(bytes.subarray(offset, offset + size));
  }

  async function parseUlogFile(file) {
    const buffer = await file.arrayBuffer();
    const parsed = parseUlog(buffer);
    return {
      fileName: file.name,
      ...parsed,
    };
  }

  function buildTopicStatus(topicMap) {
    const status = {};
    for (const topic of TARGET_TOPICS) {
      const entry = topicMap[topic];
      status[topic] = {
        available: Boolean(entry && entry.samples > 0),
        samples: entry ? entry.samples || 0 : 0,
      };
    }
    return status;
  }

  return {
    TYPE_SIZES,
    TARGET_TOPICS,
    parseFormatDefinition,
    decodeRecord,
    parseUlog,
    parseUlogFile,
    buildTopicStatus,
  };
});
