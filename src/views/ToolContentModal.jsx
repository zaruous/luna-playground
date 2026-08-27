import { useEffect, useRef, useState } from 'react';
import { formatBytes, PENDING_LABEL } from '../shared.js';

// 도구 호출 내용 팝업.
//
// 이 화면에서 **본문이 보이는 유일한 자리**입니다. 그래서 다른 컴포넌트와
// 다른 규칙 셋을 지킵니다(docs/dev/menus/detail.md).
//
//   1. 열릴 때 요청합니다 — 목록을 그리면서 미리 당기지 않습니다.
//   2. 닫으면 상태를 버립니다. 이 컴포넌트가 언마운트되면 본문도 사라지고,
//      다시 열면 다시 요청합니다. 캐시를 두면 "닫았는데 아직 메모리에 있다"가
//      됩니다.
//   3. 자격증명 경고를 늘 띄웁니다. 도구 출력에 .env 나 토큰이 섞여 들어간
//      사례가 실제로 보고돼 있습니다.

const REASONS = {
  redacted: {
    title: '가림된 프로젝트예요.',
    body: '경로 가림은 "이 프로젝트가 무엇인지 보이지 않게" 하는 설정입니다. 도구 출력에는 파일 내용과 명령 결과가 그대로 들어 있어서, 가림 상태에서는 내용을 내주지 않습니다.',
  },
  tool_call_not_found: {
    title: '이 호출을 원본에서 찾지 못했어요.',
    body: '표의 행은 원본을 읽어 만들었지만, 그 사이 파일이 잘렸거나 다른 사본만 남았을 수 있습니다. 지어내지 않고 없다고 적습니다.',
  },
  source_missing: {
    title: '원본 로그가 이미 없어요.',
    body: '내용은 저장해 두지 않고 볼 때마다 원본을 읽습니다. 파일이 지워지면 남는 것은 표의 숫자뿐이에요.',
  },
  provider_unverified: {
    title: '이 provider 는 아직 내용 보기를 켜지 않았어요.',
    body: '로그에서 호출과 결과가 어떻게 이어지는지 실물로 확인한 뒤에 켭니다. 확인 전에 반쯤 맞는 내용을 보여 주지 않는 편이 낫습니다.',
  },
  provider_not_implemented: {
    title: '이 provider 는 내용 보기를 아직 붙이지 않았어요.',
    body: '턴 상세와 같은 순서로 켭니다 — 로그 형태를 실측으로 확인한 뒤입니다.',
  },
  provider_has_no_turns: {
    title: '이 provider 는 원본에 대화 구조가 없어요.',
    body: 'Cursor Admin API 는 이벤트 단위 집계만 줍니다. 읽어 올 도구 호출 자체가 없습니다.',
  },
  provider_unknown: { title: '모르는 provider 예요.', body: '등록표에 없는 provider 입니다.' },
};

function ContentBlock({ title, block, emptyLabel }) {
  if (!block) {
    return (
      <div className="tool-content-block">
        <h4>{title}</h4>
        <p className="filter-note">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <div className="tool-content-block">
      <h4>
        {title}
        <small>
          {block.chars.toLocaleString('ko-KR')}자 · {formatBytes(block.bytes)}
          {block.truncated ? ' · 앞부분만' : ''}
        </small>
      </h4>
      <pre className="tool-content-body">{block.content}</pre>
      {block.truncated ? (
        <p className="filter-note">
          상한(256KB)을 넘어 앞부분만 실었습니다 — 잘린 것을 전부로 읽지 않도록 적어 둡니다.
        </p>
      ) : null}
    </div>
  );
}

export default function ToolContentModal({ api, session, call, onClose }) {
  const [state, setState] = useState({ status: 'loading', content: null, error: null });
  const closeRef = useRef(null);

  // 열릴 때 요청하고, 닫히면(언마운트) 그대로 버립니다.
  useEffect(() => {
    if (!api?.sessions?.toolContent || !session || !call?.id) return undefined;
    let active = true;
    setState({ status: 'loading', content: null, error: null });
    api.sessions.toolContent(session.sessionId, call.id, { provider: session.provider })
      .then((content) => { if (active) setState({ status: 'ready', content, error: null }); })
      .catch((error) => { if (active) setState({ status: 'error', content: null, error: error.message }); });
    return () => { active = false; };
  }, [api, session?.sessionId, session?.provider, call?.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const content = state.content;
  const reason = content && !content.available
    ? (REASONS[content.reason] ?? REASONS.provider_unknown)
    : null;

  return (
    <div className="tool-content-backdrop" role="presentation" onClick={onClose}>
      <div
        className="tool-content-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`도구 호출 내용 — ${call?.tool ?? ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tool-content-head">
          <div>
            <h3>도구 호출 내용 <span>••</span></h3>
            <p className="panel-sub">
              {call?.tool ?? '도구'}
              {content?.at ? ` · ${new Date(content.at).toLocaleString('ko-KR')}` : ''}
              {content?.isError ? ' · 오류로 끝난 호출' : ''}
            </p>
          </div>
          <button type="button" className="chip-button tiny" ref={closeRef} onClick={onClose} aria-label="내용 보기 닫기">✕</button>
        </div>

        <p className="tool-content-warning" role="note">
          ⚠ 도구 출력에는 자격증명이 남아 있을 수 있습니다 — 이 내용은 <strong>저장되지 않고</strong>, 창을 닫으면 버립니다.
        </p>

        {state.status === 'loading' ? (
          <div className="empty-projects"><strong>{PENDING_LABEL}</strong><span>원본에서 이 호출 하나만 읽는 중입니다.</span></div>
        ) : null}
        {state.status === 'error' ? (
          <div className="empty-projects"><strong>내용을 불러오지 못했어요.</strong><span>{state.error}</span></div>
        ) : null}
        {reason ? (
          <div className="empty-projects"><strong>{reason.title}</strong><span>{reason.body}</span></div>
        ) : null}

        {state.status === 'ready' && content?.available ? (
          <>
            <ContentBlock title="input (도구에 넘긴 것)" block={content.input} emptyLabel="이 호출의 input 을 찾지 못했습니다." />
            <ContentBlock
              title="결과 (모델이 받은 것)"
              block={content.result}
              emptyLabel="결과가 아직 없습니다 — 사람이 중단했거나 도구가 돌아오기 전에 기록이 끊긴 호출입니다."
            />
            {content.source?.path ? (
              <p className="filter-note">
                원본: {content.source.path}{content.source.line ? `:${content.source.line}` : ''} — 누를 때만 읽고, 닫으면 버립니다.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
