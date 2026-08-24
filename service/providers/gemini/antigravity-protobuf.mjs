// Antigravity CLI 는 gen_metadata.data 에 protobuf 를 콤마 구분 십진 바이트로
// 저장합니다. 필드 이름은 와이어에 없고 번호만 있으므로 grep 으로는 찾을 수
// 없습니다 — varint 스캐너로만 훑습니다.

export function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  const text = String(value ?? '');
  if (/^[\d,\s]+$/.test(text.slice(0, 200))) {
    const nums = text.split(',').map((part) => Number(part.trim()));
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(nums);
  }
  return Buffer.from(text, 'utf8');
}

export function readVarint(buffer, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new RangeError('varint too long');
  }
  return { value: Number(result), next: pos };
}

// wire 0 varint, wire 2 length-delimited(재귀), wire 1/5 는 건너뜁니다.
export function scanProtobuf(buffer, onField, path = '') {
  if (!buffer?.length) return;
  let pos = 0;
  while (pos < buffer.length) {
    let tag;
    try {
      ({ value: tag, next: pos } = readVarint(buffer, pos));
    } catch {
      break;
    }
    const fieldNum = tag >>> 3;
    const wire = tag & 7;
    const fieldPath = path ? `${path}.${fieldNum}` : String(fieldNum);

    if (wire === 0) {
      let value;
      ({ value, next: pos } = readVarint(buffer, pos));
      onField(fieldPath, 'varint', value);
    } else if (wire === 2) {
      let length;
      ({ value: length, next: pos } = readVarint(buffer, pos));
      const slice = buffer.subarray(pos, pos + length);
      pos += length;
      onField(fieldPath, 'bytes', slice);
      scanProtobuf(slice, onField, fieldPath);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break;
    }
  }
}
