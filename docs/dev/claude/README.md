# Claude — 화면 단위 적용 가능성

이 디렉터리는 **화면(메뉴) 단위로 Claude provider 가 실제로 어떻게 동작하는가**
하나만 봅니다. 어댑터 자체의 실측(코퍼스 규모·필드 항등식·버전 게이트·중복 제거
규칙·프라이버시 경계)은 [claude-code-adapter.md](../../claude-code-adapter.md)에
이미 있고, **여기서 다시 적지 않습니다** — 그 문서를 가리키고 인용만 합니다.

Claude 는 네 provider 중 가장 완전한 어댑터입니다(`integration: 'connected'`,
`localLedger`/`hooks`/턴 원장/턴 상세/도구 본문 열람 전부 켜져 있음). 그래서 이
문서의 관심사는 "만들 수 있는가"가 아니라 **"화면이 전제하는 것과 Claude 데이터가
실제로 보장하는 것이 어긋나는 자리가 어디인가"** 입니다.

| 문서 | 내용 |
|---|---|
| [기능적용가능성.md](./기능적용가능성.md) | `src/views/*.jsx` 를 전부 읽어 JSX 섹션 하나를 한 행으로 옮긴 O/△/X 표 |

네 provider 를 나란히 놓고 보려면 [LLM별 기능지원표.md](../LLM별%20기능지원표.md),
같은 형식의 Cursor 판은 [cursor/기능적용가능성.md](../cursor/기능적용가능성.md)
입니다.
