import fsp from 'node:fs/promises';

const READ_CHUNK_SIZE = 256 * 1024;

// 파일 기반 provider 세 곳(Codex / Claude / Gemini)이 같은 tail 규칙을 씁니다.
//   - 정상 시에는 append 된 바이트만 읽는다
//   - 불완전한 마지막 줄은 다음 append 까지 버퍼링한다 (finalOffset 은 마지막
//     완결 줄 경계)
//   - 파일이 저장된 offset 보다 작아졌으면 절단/교체이므로 호출자가 안전
//     재스캔으로 폴백하도록 truncated 를 올린다
// docs/토큰 사용량 측정.md §4.2 의 "파일 커서 규칙"이 이 함수의 계약입니다.
export async function readCompleteLines(filePath, startOffset, onLine) {
  const handle = await fsp.open(filePath, 'r');
  let position = startOffset;
  let carry = Buffer.alloc(0);
  try {
    const stat = await handle.stat();
    if (startOffset > stat.size) {
      return { finalOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs, truncated: true };
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) break;
      const chunk = carry.length
        ? Buffer.concat([carry, buffer.subarray(0, bytesRead)])
        : Buffer.from(buffer.subarray(0, bytesRead));
      const chunkBaseOffset = position - carry.length;
      let lineStart = 0;
      while (true) {
        const newline = chunk.indexOf(0x0a, lineStart);
        if (newline === -1) break;
        const raw = chunk.subarray(lineStart, newline);
        const line = raw.length && raw[raw.length - 1] === 0x0d
          ? raw.subarray(0, -1).toString('utf8')
          : raw.toString('utf8');
        const lineEndOffset = chunkBaseOffset + newline + 1;
        await onLine(line, lineEndOffset);
        lineStart = newline + 1;
      }
      carry = Buffer.from(chunk.subarray(lineStart));
      position += bytesRead;
    }
    const finalOffset = stat.size - carry.length;
    return { finalOffset, fileSize: stat.size, mtimeMs: stat.mtimeMs, truncated: false };
  } finally {
    await handle.close();
  }
}

export { READ_CHUNK_SIZE };
