# NyangTracker docs

- [Architecture](./architecture.md) — provider-neutral engine, trust model, realtime strategy, security boundary.
- [HTTP/SSE transport](./http-sse-transport.md) — local server API, SSE event format, authentication, and standalone operation.
- [Provider adapter contract](./provider-adapter-contract.md) — shared lifecycle, normalized events, deduplication, quota identity, and client snapshot shape.
- [Codex usage collection](./codex-usage.md) — Codex v1 parser, server snapshots, reconciliation and hook behavior.
- [Claude Code Adapter v1 plan](./claude-code-adapter.md) — next implementation contract covering local transcripts, dedupe, hooks, realtime reconciliation, privacy, tests, and acceptance criteria.
- [Provider roadmap](./roadmap.md) — Codex → Claude Code → Cursor → Gemini CLI implementation sequence and exit criteria.
- [개발 계획 (dev/)](./dev/README.md) — 아직 구현하지 않은 것: 마일스톤, 메뉴별 화면 계획과 와이어프레임, provider별 토큰 API 설계, 오픈소스 측정 알고리즘 조사.
