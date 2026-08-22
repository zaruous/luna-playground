// 도구 이름 → 작업 단계 매핑.
//
// 파서는 도구 **이름만** 기록하고, 단계 분류는 여기서 조회 시점에 합니다.
// 파싱 때 확정하지 않는 이유는 매핑이 바뀌어도 재파싱이 필요 없게 하려는
// 것입니다 — 이름은 사실이고, 단계는 해석입니다.
//
// 정규 단계는 이 6개뿐입니다. 늘리면 provider 간·세션 간 비교가 깨집니다
// (docs/dev/menus/session.md).
export const PHASES = Object.freeze(['explore', 'implement', 'verify', 'plan', 'clarify', 'delegate']);
export const PHASE_OTHER = 'other';
export const PHASE_NONE = 'no-tool';

export const PHASE_LABELS = Object.freeze({
  explore: '탐색',
  implement: '구현',
  verify: '검증',
  plan: '계획',
  clarify: '확인',
  delegate: '위임',
  other: '기타',
  'no-tool': '도구 없음',
});

// 도구 어휘가 provider 마다 다릅니다. Claude 는 Bash/Edit/Read, Codex 는
// shell_command/apply_patch/exec — 그래서 표를 provider 별로 둡니다.
// 실제 로그에서 관측한 이름만 넣고, 모르는 이름은 'other' 로 떨어뜨립니다.
const TABLES = Object.freeze({
  claude: Object.freeze({
    Read: 'explore', Grep: 'explore', Glob: 'explore', ToolSearch: 'explore',
    WebFetch: 'explore', WebSearch: 'explore', ReadMcpResourceTool: 'explore',
    ListMcpResourcesTool: 'explore', ReadMcpResourceDirTool: 'explore',

    Edit: 'implement', Write: 'implement', NotebookEdit: 'implement',

    Bash: 'verify', PowerShell: 'verify', Monitor: 'verify',

    TaskCreate: 'plan', TaskUpdate: 'plan', TaskGet: 'plan', TaskList: 'plan',
    TaskOutput: 'plan', TaskStop: 'plan', EnterPlanMode: 'plan', ExitPlanMode: 'plan',

    AskUserQuestion: 'clarify',

    Agent: 'delegate', Task: 'delegate', Workflow: 'delegate', SendMessage: 'delegate',
    ListAgents: 'delegate',
  }),
  codex: Object.freeze({
    tool_search_call: 'explore',
    apply_patch: 'implement',
    shell_command: 'verify', exec: 'verify', run: 'verify', js: 'verify', wait: 'verify',
    local_shell_call: 'verify',
  }),
  // M5 에서 실제 로그를 세어 채웠습니다. 개발 머신 코퍼스에서 도구 이름 70종이
  // 관측됐는데, 그중 **CLI 내장 도구만** 넣습니다. 나머지는 MCP·프로젝트 전용
  // 이름(`mcp_*`, `API-*`, 브라우저 자동화)이라 이 표에 넣으면 남의 프로젝트
  // 어휘를 우리 분류로 굳히게 됩니다 — 전부 'other' 로 떨어지는 것이 맞습니다.
  gemini: Object.freeze({
    read_file: 'explore', read_many_files: 'explore', list_directory: 'explore',
    glob: 'explore', grep_search: 'explore', search_file_content: 'explore',
    google_web_search: 'explore', web_fetch: 'explore',

    write_file: 'implement', replace: 'implement',

    // Claude 의 Bash·Codex 의 shell_command 와 같은 자리입니다.
    run_shell_command: 'verify',

    write_todos: 'plan', enter_plan_mode: 'plan', exit_plan_mode: 'plan',

    ask_user: 'clarify',

    delegate_to_agent: 'delegate', codebase_investigator: 'delegate',
  }),
  // Cursor(M6) 는 어휘를 확인한 뒤 채웁니다. 빈 표라도 동작은 합니다 — 전부
  // 'other' 로 떨어지고, 그것이 "아직 분류 근거가 없다"는 정직한 표시입니다.
  cursor: Object.freeze({}),
});

export function phaseOfTool(provider, toolName) {
  if (!toolName) return PHASE_OTHER;
  return TABLES[String(provider).toLowerCase()]?.[toolName] ?? PHASE_OTHER;
}

export function knownToolNames(provider) {
  return Object.keys(TABLES[String(provider).toLowerCase()] ?? {});
}

// 한 턴에 여러 단계가 섞이면 도구 호출 비율로 토큰을 나눠 귀속합니다.
// 인과가 아니라 배분이므로 화면에서 "추정 배분"으로 표기합니다.
export function splitTokensByPhase(provider, toolCounts, tokens) {
  const byPhase = new Map();
  let calls = 0;
  for (const [name, count] of Object.entries(toolCounts ?? {})) {
    const n = Number(count) || 0;
    if (n <= 0) continue;
    const phase = phaseOfTool(provider, name);
    byPhase.set(phase, (byPhase.get(phase) ?? 0) + n);
    calls += n;
  }
  if (!calls) return new Map([[PHASE_NONE, tokens]]);
  const split = new Map();
  for (const [phase, n] of byPhase) split.set(phase, (tokens * n) / calls);
  return split;
}

export function dominantPhase(provider, toolCounts) {
  let best = null;
  let bestCalls = 0;
  const byPhase = new Map();
  for (const [name, count] of Object.entries(toolCounts ?? {})) {
    const n = Number(count) || 0;
    if (n <= 0) continue;
    const phase = phaseOfTool(provider, name);
    const next = (byPhase.get(phase) ?? 0) + n;
    byPhase.set(phase, next);
    if (next > bestCalls) { bestCalls = next; best = phase; }
  }
  return best ?? PHASE_NONE;
}
