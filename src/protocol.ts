// 중계 서버 · 데스크톱 · 커넥터가 같이 쓰는 타입. 런타임 코드 없음(import type 으로만 쓴다).
// agent-hamkke 레포의 packages/protocol/src/index.ts 와 같은 내용이다. 바꾸면 양쪽을 같이 고친다.

export type Stage = 'request' | 'draft' | 'review' | 'final'
export type AuthorKind = 'human' | 'agent' | 'system'
export type AgentKind = 'claude-code' | 'codex' | 'builtin'
export type Visibility = 'channel' | 'private'
export type MessageStatus = 'sent' | 'pending' | 'rejected'
export type MessageKind = 'text' | 'system' | 'artifact' | 'file'
export type ViewerKind = 'human' | 'agent'
/** 화면·에이전트 언어. 중계 서버는 요청의 Accept-Language(웹소켓은 ?locale=)로 고른다. */
export type Locale = 'ko' | 'en'

/**
 * 시스템 메시지의 내용. 문장 대신 이벤트로 저장해 보는 사람마다 자기 언어로 그린다.
 * (예전 메시지는 event 가 없고 body 에 문장이 들어 있다)
 */
export type SystemEvent =
  | { type: 'joined'; name: string }
  | { type: 'stage_changed'; name: string; stage: Stage }
  | { type: 'approval_toggled'; name: string; on: boolean }
  | { type: 'agent_toggled'; name: string; on: boolean }
  | { type: 'doc_signed'; name: string; title: string; version: number; signed: number; total: number }
  | { type: 'doc_finalized'; title: string; version: number }

export interface User {
  id: string
  name: string
  color: string
  agentKind: AgentKind | null
  agentOnline: boolean
  /** 항상 모두 승인: 이 사람 에이전트의 메시지·문서·파일과 도구 실행을 확인 없이 바로 처리한다 */
  autoApprove: boolean
}

export interface Member extends User {
  agentEnabled: boolean
  joinedAt: number
}

export interface Channel {
  id: string
  title: string
  stage: Stage
  turnLimit: number
  requireApproval: boolean
  createdBy: string
  createdAt: number
  updatedAt: number
  members: Member[]
  /** 미리보기 글. text 면 본문 앞부분, artifact 면 문서 제목, file 이면 파일 이름 */
  lastMessage: string | null
  lastMessageKind: 'text' | 'artifact' | 'file' | null
  pendingCount: number
  unread: number
}

/**
 * 파일 올리기 허가(POST /channels/:id/uploads). 바이트를 url 에 PUT(Content-Type 은 올릴 때 밝힌 mime)한 뒤
 * POST /channels/:id/files { uploadId, visibility, note } 로 채널에 낸다.
 */
export interface UploadTicket {
  uploadId: string
  url: string
}

/** 채널에 올린 파일. 내용은 GET /files/:id 로 받는다(로그인 필요). */
export interface FileMeta {
  id: string
  name: string
  mime: string
  size: number
}

export interface Message {
  id: string
  channelId: string
  authorId: string | null
  authorKind: AuthorKind
  agentKind: AgentKind | null
  visibility: Visibility
  status: MessageStatus
  kind: MessageKind
  /** system 메시지는 받는 쪽 언어로 쓴 문장(event 가 있으면 화면이 event 로 다시 그려도 된다) */
  body: string
  /** kind 가 system 일 때의 이벤트. 예전 메시지는 null */
  event: SystemEvent | null
  /** 본문에서 @이름 으로 지목한 채널 참여자(user id). 지목받은 사람의 에이전트가 요청으로 받아 처리한다 */
  mentions: string[]
  artifactId: string | null
  artifactVersion: number | null
  /** kind 가 file 일 때. body 는 곁들인 말(없을 수 있음) */
  file: FileMeta | null
  edited: boolean
  createdAt: number
}

export interface ArtifactVersion {
  version: number
  content: string
  authorId: string
  authorKind: AuthorKind
  agentKind: AgentKind | null
  status: MessageStatus
  createdAt: number
}

export interface Finalization {
  version: number
  userId: string
  createdAt: number
}

export interface Artifact {
  id: string
  channelId: string
  title: string
  status: 'draft' | 'final'
  finalVersion: number | null
  createdBy: string
  createdAt: number
  updatedAt: number
  versions: ArtifactVersion[]
  finalizations: Finalization[]
}

export interface PermissionRequest {
  id: string
  userId: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
  status: 'pending' | 'allow' | 'deny' | 'expired'
  createdAt: number
}

// 에이전트가 지금 무엇을 하는지(작업 중 표시). 저장하지 않고 마스터에게만 실시간으로 보낸다.
export type AgentActivityState = 'working' | 'waiting' | 'idle'

export interface AgentActivity {
  userId: string
  channelId: string
  state: AgentActivityState
  /** 예: '노션 보는 중' */
  detail: string
  /** state 가 waiting 일 때 기다리는 도구 실행 권한 요청 id */
  permissionId: string | null
  at: number
}

export interface Approvals {
  messages: Message[]
  permissions: PermissionRequest[]
}

export type ServerEvent =
  /**
   * 연결되면 처음 보내는 이벤트. connId 는 이 연결의 id.
   * resumed 면 ?resume= 로 이어 받은 연결이라 그 사이 놓친 이벤트가 없다(다시 불러올 필요 없음).
   */
  | { type: 'hello'; me: User; kind: ViewerKind; connId: string; resumed: boolean }
  /**
   * 서버가 곧 이 연결을 닫는다(Vercel 함수 수명). 새 연결을 /ws?...&resume=<connId> 로 열면
   * 이벤트가 끊기거나 겹치지 않게 새 연결로 넘어가고, 옛 연결은 서버가 닫는다.
   */
  | { type: 'reconnect' }
  /** 내 계정 정보가 바뀜(이름·항상 모두 승인). 나의 사람·에이전트 연결에만 보낸다 */
  | { type: 'user'; user: User }
  | { type: 'message'; message: Message }
  /** 이제 볼 수 없게 된 메시지(주인이 에이전트 글의 공유를 취소함). 화면에서 지운다 */
  | { type: 'message_removed'; messageId: string; channelId: string }
  | { type: 'channel'; channel: Channel }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'artifact_removed'; artifactId: string; channelId: string }
  | { type: 'presence'; userId: string; agentOnline: boolean; agentKind: AgentKind | null }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission_verdict'; requestId: string; behavior: 'allow' | 'deny' }
  | { type: 'agent_activity'; activity: AgentActivity }
