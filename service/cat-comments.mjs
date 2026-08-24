// 냥코멘트 — 대시보드 하단의 한 줄 서사.
//
// 이건 장식이 아니라 **상태를 말하는 문장**입니다. 그래서 아무 문장이나 무작위로
// 띄우면 안 됩니다 — 화면이 재지 않은 것을 말하게 됩니다. 표는 상태별로 묶여
// 있고, 무작위는 **같은 상태의 다른 표현 사이에서만** 일어납니다.
//
// 표가 서버에 있는 이유: 클라이언트와 서버 양쪽에 두면 한쪽만 고쳤을 때 조용히
// 갈라집니다(이 저장소가 회계 표에서 이미 겪은 일입니다). 문구의 주인은 서버이고
// 화면은 받아서 고르기만 합니다.

const UNATTRIBUTED = (owner) => [
  {
    title: '서버 사용량 차이가 보인다냥',
    body: `서버 한도는 움직였지만 이 PC의 로컬 ${owner} 로그에서 대응 사용량을 찾지 못한 구간이 있어요. 다른 기기·클라우드 작업·지연 정산 가능성을 분리해서 기록 중입니다.`,
  },
  {
    title: '설명 못 한 서버 움직임이 있다냥',
    body: `서버 쪽 사용률만 올라간 구간을 이 PC의 로컬 ${owner} 로그가 설명하지 못했어요. 없던 일로 지우지 않고 미귀속으로 남겨 둡니다.`,
  },
  {
    title: '어디서 쓴 건지 모르겠다냥',
    body: `이 PC의 로컬 ${owner} 로그 밖에서 일어난 사용이 있어 보여요. 숫자를 맞추려고 로컬 토큰을 늘리지는 않습니다 — 서로 다른 관측이라 따로 둡니다.`,
  },
];

const LOCAL_AHEAD = (owner) => [
  {
    title: `${owner} 로컬 로그가 먼저 달린다냥`,
    body: '로컬 토큰은 증가했지만 서버 한도 snapshot은 아직 움직이지 않은 구간이 있어요. 다음 서버 snapshot에서 다시 대조합니다.',
  },
  {
    title: `${owner} 쪽이 서버보다 앞서 있다냥`,
    body: '로컬에서 센 토큰이 서버 한도에 아직 반영되지 않았어요. 서버 정산이 늦는 경우일 수 있어 기다렸다가 다시 맞춰 봅니다.',
  },
  {
    title: '서버가 아직 못 따라왔다냥',
    body: `로컬 ${owner} 로그가 먼저 늘었습니다. 둘을 억지로 같게 만들지 않고, 다음 snapshot에서 차이가 좁혀지는지 봅니다.`,
  },
];

// 맞는다고 해서 두 값을 하나로 합치지는 않습니다 — 토큰과 백분율은 단위가
// 다르고, 합치는 순간 어느 쪽 근거인지 알 수 없게 됩니다(R5).
const SYNCED = (owner) => [
  {
    title: `${owner} 로컬 기록과 서버 흐름이 잘 맞는다냥`,
    body: '토큰량은 로컬 로그 원본을 보존하고, 서버 사용률은 별도 snapshot으로 저장해 서로 억지로 보정하지 않고 비교합니다.',
  },
  {
    title: `${owner} 양쪽이 나란히 간다냥`,
    body: '로컬 로그의 토큰과 서버 사용률이 같은 구간에서 함께 움직였어요. 그래도 두 값을 하나로 합치지는 않습니다 — 측정 근거가 다릅니다.',
  },
  {
    title: `${owner} 대조가 깔끔하다냥`,
    body: '서버가 움직인 구간마다 로컬 로그에 대응하는 활동이 있었어요. 토큰과 백분율은 각자의 단위 그대로 둡니다.',
  },
];

// 아직 대조 전 — snapshot 이 **올 수 있는** provider 일 때만 쓰는 문구입니다.
const WATCHING = (providerName) => [
  {
    title: `${providerName} 기록을 관측 중이다냥`,
    body: '토큰량은 provider의 로컬 로그 기준입니다. 서버 rate-limit snapshot이 들어오면 로컬 활동과 자동으로 대조합니다.',
  },
  {
    title: `${providerName} 로그를 지켜보는 중이다냥`,
    body: '지금 숫자는 전부 로컬 로그에서 직접 읽은 값이에요. 서버 snapshot이 들어오면 그때 나란히 놓고 비교합니다.',
  },
  {
    title: '아직 대조할 서버 값이 없다냥',
    body: `${providerName} 토큰은 로컬 로그 관측값입니다. 서버 snapshot이 들어오면 어느 구간이 맞고 어긋나는지 표시합니다.`,
  },
];

// 서버 원장을 가진 provider 가 **하나도 없는** 경우. 여기서 "snapshot 이 들어오면
// 대조합니다" 라고 말하면 지킬 수 없는 약속입니다 — 올 snapshot 이 없습니다.
const NO_SERVER_LEDGER = () => [
  {
    title: '로컬 기록만 보고 있다냥',
    body: '연결된 provider 중 서버 한도 원장을 주는 곳이 없어요. 지금 보이는 토큰은 전부 로컬 로그 관측값이고, 대조할 서버 값은 없습니다.',
  },
  {
    title: '대조할 상대가 없다냥',
    body: '연결된 provider 중 서버 한도 원장을 주는 곳이 없어요. 로컬 로그만으로 셈하고 있고, 맞춰 볼 서버 값 자체가 존재하지 않습니다.',
  },
  {
    title: '로컬 로그가 전부다냥',
    body: '연결된 provider 중 서버 한도 원장을 주는 곳이 없어요. 그래서 이 화면의 숫자는 서버 대조를 거치지 않은 로컬 관측값입니다.',
  },
];

// 상태와 **무관하게 항상 참인** 문구들. 대조 상태가 무엇이든 이 앱이 어떻게
// 재는지를 설명하므로 언제 띄워도 거짓이 되지 않습니다. 상태별 문구가 3개뿐이라
// 금방 물리는데, 없는 상태를 지어내서 개수를 늘리는 대신 이렇게 채웁니다.
const ALWAYS_TRUE = [
  {
    title: '대화 내용은 안 본다냥',
    body: '프롬프트와 응답 본문은 읽지도 저장하지도 않아요. 원장에 남는 것은 토큰 수·도구 이름·시각, 그리고 경로 마지막 두 조각뿐입니다.',
  },
  {
    title: '퍼센트를 토큰으로 바꾸지 않는다냥',
    body: '서버가 주는 것은 사용률(%)이고 로컬이 주는 것은 토큰 수예요. 환산 규칙을 provider 가 공개하지 않았으니 둘을 억지로 같은 단위로 만들지 않습니다.',
  },
  {
    title: 'provider 마다 캐시 셈법이 다르다냥',
    body: 'Codex 와 Gemini 는 캐시 읽기가 입력 안에 들어 있고 Claude 는 밖에 있어요. 그래서 합쳐서 한 번에 쪼개지 않고 provider 마다 자기 회계로 나눕니다.',
  },
  {
    title: '없는 값은 0 이 아니다냥',
    body: '재지 못한 자리는 0 대신 — 로, 아직 안 온 값은 로딩중.. 으로 적어요. 셋을 같은 글자로 적으면 화면이 재지 않은 것을 말하게 됩니다.',
  },
  {
    title: '턴은 사람이 말할 때 갈린다냥',
    body: '토큰을 턴에 붙일 때 기준은 사람 메시지예요. 경계를 못 찾은 사용량은 다른 턴에 억지로 끼우지 않고 경계 미확인 자리에 그대로 둡니다.',
  },
  {
    title: '같은 컨텍스트를 몇 번 읽었나 본다냥',
    body: '비싼 세션은 보통 많이 만들어서가 아니라 긴 컨텍스트를 여러 번 다시 읽어서예요. 세션 흐름 화면의 재독 배수가 그 숫자입니다.',
  },
  {
    title: '원장은 다시 만들 수 있다냥',
    body: '진짜 원본은 각 도구의 로컬 로그이고 이 원장은 거기서 나온 파생값이에요. 그래서 비우고 다시 재도 같은 값이 돌아옵니다 — 로그가 남아 있는 구간까지는요.',
  },
];

// scope 로 두 종류를 갈라 둡니다. `status` 는 **지금 이 provider 의 대조 결과**를
// 말하므로 남의 이름을 쓰면 안 되고, `general` 은 앱이 어떻게 재는지를 설명하므로
// 세 provider 를 예로 들어도 사칭이 아닙니다. 테스트가 이 둘에 다른 단정을 겁니다.
export function generalComments() {
  return ALWAYS_TRUE.map((item) => ({ ...item, scope: 'general' }));
}

// 현재 대조 상태에 **해당하는 문구 전부**를 돌려줍니다. 고르는 일은 화면이 합니다
// — 서버가 골라 버리면 매 요청마다 바뀌어서 화면이 이유 없이 깜빡입니다.
export function catComments(status, providerName = null) {
  const owner = providerName ?? '연동된 provider';
  const pick = () => {
    switch (status) {
      case 'UNATTRIBUTED_SERVER_USAGE': return UNATTRIBUTED(owner);
      case 'LOCAL_AHEAD_OF_SERVER': return LOCAL_AHEAD(owner);
      case 'SYNCED': return SYNCED(owner);
      default: return providerName ? WATCHING(providerName) : NO_SERVER_LEDGER();
    }
  };
  return pick().map((item) => ({ ...item, scope: 'status' }));
}

// 냥코멘트는 "서버와 로컬을 대조했다"는 이야기입니다. 그러니 서버 원장을 가진
// provider 것만 먹여야 합니다 — 아무 provider 나 잡으면 Claude 데이터 위에 Codex 의
// 대조 서사를 얹게 됩니다. 대시보드가 쓰던 규칙과 같은 규칙입니다.
export function catCommentPayload(snapshot) {
  const providers = snapshot?.providers ?? [];
  const owner = providers.find((provider) => (
    provider.integration === 'connected' && provider.capabilities?.serverQuota
  )) ?? null;
  const status = owner?.reconciliation?.status ?? null;
  // 상태별 문구 + 항상 참인 문구. 화면이 이 묶음 안에서 하나를 고릅니다.
  const comments = [...catComments(status, owner?.name ?? null), ...generalComments()];
  return {
    status,
    provider: owner ? { id: owner.id, name: owner.name } : null,
    comments,
  };
}
