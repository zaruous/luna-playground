import { sendHookSignal } from './hook-server.mjs';

export function normalizeHookSignal(payload = {}, provider = null) {
  return {
    // 수집기가 하나가 아니므로 어떤 provider 의 hook 이었는지 적어 보내야
    // 엔진이 한 군데만 깨울 수 있습니다. 없으면 엔진이 경로로 유추합니다.
    provider: provider ?? payload.provider ?? null,
    hook_event_name: payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? null,
    session_id: payload.session_id ?? payload.sessionId ?? null,
    turn_id: payload.turn_id ?? payload.turnId ?? null,
    transcript_path: payload.transcript_path ?? payload.transcriptPath ?? null,
    cwd: payload.cwd ?? null,
    model: payload.model ?? null,
  };
}

export function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(''));
    if (stream.readableEnded) resolve(data);
  });
}

export async function runHookInvocation({ stream = process.stdin, send = sendHookSignal, provider = null } = {}) {
  const raw = await readStdin(stream);
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {}
  return send(normalizeHookSignal(payload, provider));
}
