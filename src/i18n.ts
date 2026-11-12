// 중계 서버가 사람·에이전트에게 돌려주는 문장(오류, 시스템 메시지). 받는 쪽 언어로 고른다.
import type { Locale, Stage, SystemEvent } from './protocol.js'

/** Accept-Language("ko-KR,ko;q=0.9,en;q=0.8") 나 ?locale= 값에서 지원하는 언어를 고른다. 모르면 영어. */
export function pickLocale(raw: string | null | undefined): Locale {
  for (const part of String(raw ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase()
    if (tag === 'ko' || tag.startsWith('ko-')) return 'ko'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

const STAGE: Record<Locale, Record<Stage, string>> = {
  ko: { request: '요청', draft: '초안', review: '검토', final: '확정' },
  en: { request: 'Request', draft: 'Draft', review: 'Review', final: 'Final' },
}

type Params = Record<string, string | number>

const ERRORS = {
  ko: {
    user_not_found: () => '사용자를 찾을 수 없어요',
    channel_not_found: () => '채널을 찾을 수 없어요',
    humans_only: () => '사람만 할 수 있어요',
    agents_only: () => '에이전트만 올릴 수 있어요',
    agent_turn_limit: (p: Params) => `에이전트끼리 ${p.limit}번 주고받았어요. 사람이 채널에 한 번 말해야 다시 보낼 수 있어요.`,
    name_required: () => '이름을 입력해 주세요',
    unsupported_agent: () => '지원하지 않는 에이전트예요',
    invite_not_found: () => '초대 코드를 찾을 수 없어요',
    empty_message: () => '내용이 비어 있어요',
    message_too_long: () => '메시지가 너무 길어요',
    nothing_to_approve: () => '승인할 항목이 없어요',
    nothing_to_discard: () => '버릴 항목이 없어요',
    nothing_to_share: () => '공유할 에이전트 글이 없어요',
    nothing_to_unshare: () => '공유를 취소할 에이전트 글이 없어요',
    decision_not_found: () => '결정 요청을 찾을 수 없어요',
    decision_closed: () => '이미 처리한 결정 요청이에요',
    question_required: () => '무엇을 결정해야 하는지 적어 주세요',
    answer_required: () => '결정한 내용을 적어 주세요',
    task_not_found: () => '할 일을 찾을 수 없어요',
    task_title_required: () => '할 일을 적어 주세요',
    invalid_due: () => '기한은 YYYY-MM-DD 로 적어 주세요',
    assignee_not_member: () => '이 채널에 있는 사람에게만 맡길 수 있어요',
    document_not_found: () => '문서를 찾을 수 없어요',
    empty_document: () => '문서 내용이 비어 있어요',
    document_too_long: () => '문서가 너무 길어요',
    title_required: () => '문서 제목이 필요해요',
    version_not_finalizable: () => '확정할 수 있는 버전이 아니에요',
    request_not_found: () => '요청을 찾을 수 없어요',
    request_closed: () => '이미 끝난 요청이에요',
    file_too_large: (p: Params) => `파일은 ${p.mb}MB까지 올릴 수 있어요`,
    empty_file: () => '빈 파일이에요',
    file_not_found: () => '파일을 찾을 수 없어요',
    upload_not_found: () => '올린 파일을 찾을 수 없어요. 다시 올려 주세요',
    body_too_large: () => '요청이 너무 커요',
    invalid_json: () => 'JSON 형식이 아니에요',
    login_required: () => '로그인이 필요해요',
    route_not_found: () => '없는 경로예요',
    server_error: () => '서버 오류가 났어요',
  },
  en: {
    user_not_found: () => 'User not found',
    channel_not_found: () => 'Channel not found',
    humans_only: () => 'Only people can do this',
    agents_only: () => 'Only agents can post this',
    agent_turn_limit: (p: Params) =>
      `Agents have sent ${p.limit} messages in a row. A person needs to post in the channel before agents can send again.`,
    name_required: () => 'Please enter a name',
    unsupported_agent: () => 'This agent isn’t supported',
    invite_not_found: () => 'Invite code not found',
    empty_message: () => 'Message is empty',
    message_too_long: () => 'Message is too long',
    nothing_to_approve: () => 'Nothing to approve',
    nothing_to_discard: () => 'Nothing to discard',
    nothing_to_share: () => 'No agent message to share',
    nothing_to_unshare: () => 'No shared agent message to take back',
    decision_not_found: () => 'Decision request not found',
    decision_closed: () => 'This decision request is already closed',
    question_required: () => 'Say what needs deciding',
    answer_required: () => 'Write what you decided',
    task_not_found: () => 'Task not found',
    task_title_required: () => 'Write what needs doing',
    invalid_due: () => 'Write the due date as YYYY-MM-DD',
    assignee_not_member: () => 'You can only assign people in this channel',
    document_not_found: () => 'Document not found',
    empty_document: () => 'Document is empty',
    document_too_long: () => 'Document is too long',
    title_required: () => 'Document title is required',
    version_not_finalizable: () => 'This version can’t be finalized',
    request_not_found: () => 'Request not found',
    request_closed: () => 'This request has already been answered',
    file_too_large: (p: Params) => `Files can be up to ${p.mb} MB`,
    empty_file: () => 'The file is empty',
    file_not_found: () => 'File not found',
    upload_not_found: () => 'The upload wasn’t found. Please upload the file again.',
    body_too_large: () => 'Request is too large',
    invalid_json: () => 'Request body isn’t valid JSON',
    login_required: () => 'Sign-in required',
    route_not_found: () => 'Not found',
    server_error: () => 'Something went wrong on the server',
  },
} satisfies Record<Locale, Record<string, (p: Params) => string>>

export type ErrorCode = keyof (typeof ERRORS)['ko']

export function errorText(locale: Locale, code: ErrorCode, params: Params = {}): string {
  return ERRORS[locale][code](params)
}

export function systemText(ev: SystemEvent, locale: Locale): string {
  const ko = locale === 'ko'
  switch (ev.type) {
    case 'joined':
      return ko ? `${ev.name}님이 들어왔어요` : `${ev.name} joined`
    case 'stage_changed':
      return ko
        ? `${ev.name}님이 단계를 「${STAGE.ko[ev.stage]}」(으)로 바꿨어요`
        : `${ev.name} moved the stage to “${STAGE.en[ev.stage]}”`
    case 'approval_toggled':
      return ko
        ? `${ev.name}님이 에이전트 발언 승인을 ${ev.on ? '켰어요' : '껐어요'}`
        : `${ev.name} turned ${ev.on ? 'on' : 'off'} approval for agent messages`
    case 'agent_toggled':
      return ko
        ? `${ev.name}님의 에이전트가 ${ev.on ? '참여해요' : '빠졌어요'}`
        : `${ev.name}’s agent ${ev.on ? 'joined' : 'left'}`
    case 'doc_signed':
      return ko
        ? `${ev.name}님이 「${ev.title}」 v${ev.version}에 동의했어요 (${ev.signed}/${ev.total})`
        : `${ev.name} signed off on “${ev.title}” v${ev.version} (${ev.signed}/${ev.total})`
    case 'doc_finalized':
      return ko ? `「${ev.title}」 v${ev.version}을 모두 확정했어요` : `Everyone finalized “${ev.title}” v${ev.version}`
  }
}

/** 결정함에서 정한 답을 채널에 알리는 글(결정한 사람의 이름으로 나간다) */
export function decisionNotice(locale: Locale, p: { mention: string | null; question: string; answer: string }): string {
  const q = p.question.replace(/\s+/g, ' ').trim()
  const quote = q.length > 160 ? q.slice(0, 160) + '…' : q
  const to = p.mention ? `@${p.mention} ` : ''
  // 사람 글은 마크다운 없이 그대로 보이므로 꾸밈 기호를 쓰지 않는다
  return locale === 'ko' ? `${to}[결정] ${p.answer}\n(질문: ${quote})` : `${to}[Decision] ${p.answer}\n(Question: ${quote})`
}

/** 제목 없이 만든 채널의 이름 */
export function defaultChannelTitle(locale: Locale): string {
  return locale === 'ko' ? '새 채널' : 'New channel'
}
