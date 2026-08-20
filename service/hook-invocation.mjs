import { sendHookSignal } from './hook-server.mjs';

export function normalizeHookSignal(payload = {}) {
  return {
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

export async function runHookInvocation({ stream = process.stdin, send = sendHookSignal } = {}) {
  const raw = await readStdin(stream);
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {}
  return send(normalizeHookSignal(payload));
}
