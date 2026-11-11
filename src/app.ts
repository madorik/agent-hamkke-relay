// 중계 서버: 사람·에이전트 메시지 중계, 승인 대기열, 문서 버전·확정, 권한 요청 전달.
// Vercel 함수(api/server.ts)와 로컬(src/dev.ts)이 같은 서버를 쓴다.
// 인스턴스가 여럿일 수 있어서 상태는 모두 Postgres 에 두고, 실시간 이벤트는 bus.ts 로 모든 인스턴스에 나눈다.
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  AgentActivity,
  AgentActivityState,
  AgentKind,
  Artifact,
  Channel,
  Locale,
  Member,
  Message,
  PermissionRequest,
  ServerEvent,
  Stage,
  SystemEvent,
  UploadTicket,
  User,
  ViewerKind,
} from './protocol.js'
import { AGENT_ONLINE, all, ensureSchema, one, run, tx, type Row } from './db.js'
import { listen, onBus, publish, unlisten, type BusEvent } from './bus.js'
import { storage } from './storage.js'
import { defaultChannelTitle, errorText, pickLocale, systemText, type ErrorCode } from './i18n.js'

const MAX_FILE = 25 * 1024 * 1024
const PERMISSION_TTL = 10 * 60_000
// 에이전트가 꺼져 있는 동안 온 @요청을 다시 줄 때 거슬러 올라가는 최대 범위
const MISSED_WINDOW = 24 * 60 * 60_000
// 웹소켓 하나를 이만큼 쓰면 새 연결로 넘기게 한다. Vercel 함수는 최대 300초(Hobby)라 그 전에 넘긴다.
const WS_LIFETIME = Number(process.env.AH_WS_LIFETIME_S ?? (process.env.VERCEL ? 240 : 0)) * 1000
const COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#5f3dc4', '#d9480f']
const STAGES: Stage[] = ['request', 'draft', 'review', 'final']
const AGENT_KINDS: AgentKind[] = ['claude-code', 'codex', 'builtin']

interface Viewer {
  userId: string
  kind: ViewerKind
  agentKind: AgentKind | null
}

// 문장은 응답할 때 요청의 언어로 만든다(던지는 곳은 언어를 모른다)
class HttpError extends Error {
  status: number
  code: ErrorCode
  params: Record<string, string | number>
  constructor(status: number, code: ErrorCode, params: Record<string, string | number> = {}) {
    super(code)
    this.status = status
    this.code = code
    this.params = params
  }
}

const now = () => Date.now()
const str = (v: unknown) => (typeof v === 'string' ? v : '')

const USER_SELECT = `SELECT u.*, ${AGENT_ONLINE} AS agent_online FROM users u`
// 메시지는 파일 정보를 붙여서 읽는다(msgOf 가 쓴다)
const MSG_SELECT = `SELECT m.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size
  FROM messages m LEFT JOIN files f ON f.id = m.file_id`

// ── 이 인스턴스의 웹소켓 연결 ────────────────────────────────────

interface Conn {
  id: string
  ws: WebSocket
  viewer: Viewer
  locale: Locale
  /** 이벤트를 받는가. 이어 받는 연결은 옛 연결이 넘겨줄 때까지 false */
  active: boolean
  alive: boolean
  retire?: NodeJS.Timeout
}
const conns = new Map<string, Conn>()

function sendNow(conn: Conn, ev: ServerEvent) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(ev))
}

function send(conn: Conn, ev: ServerEvent) {
  if (conn.active) sendNow(conn, ev)
}

// ── 행 → 객체 ──────────────────────────────────────────────────

function userOf(r: Row): User {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    agentKind: (r.agent_kind as AgentKind | null) ?? null,
    agentOnline: !!r.agent_online,
    autoApprove: !!r.auto_approve,
  }
}

/** 이 사람이 항상 모두 승인을 켰나(에이전트가 올리는 것을 바로 내보낸다) */
async function autoApproves(userId: string): Promise<boolean> {
  return !!(await one('SELECT auto_approve FROM users WHERE id = ?', userId))?.auto_approve
}

function mentionsOf(r: Row): string[] {
  try {
    const v = JSON.parse((r.mentions as string) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 본문의 @이름 → 채널 참여자 id. 긴 이름부터 찾아 'Jamie' 가 'Jamie Park' 를 가로채지 않게 한다. */
async function findMentions(channelId: string, authorId: string, text: string): Promise<string[]> {
  const members = (await all('SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ?', channelId))
    .filter((r) => r.id !== authorId)
    .sort((a, b) => (b.name as string).length - (a.name as string).length)
  let rest = text
  const ids: string[] = []
  for (const r of members) {
    const tag = '@' + (r.name as string)
    if (!rest.includes(tag)) continue
    ids.push(r.id as string)
    rest = rest.split(tag).join(' ')
  }
  return ids
}

function eventOf(r: Row): SystemEvent | null {
  if (!r.event) return null
  try {
    return JSON.parse(r.event as string) as SystemEvent
  } catch {
    return null
  }
}

/** MSG_SELECT 로 읽은 행. 시스템 메시지는 보는 사람 언어로 문장을 다시 만든다. */
function msgOf(r: Row, locale: Locale = 'en'): Message {
  const event = eventOf(r)
  return {
    id: r.id as string,
    channelId: r.channel_id as string,
    authorId: (r.author_id as string | null) ?? null,
    authorKind: r.author_kind as Message['authorKind'],
    agentKind: (r.agent_kind as AgentKind | null) ?? null,
    visibility: r.visibility as Message['visibility'],
    status: r.status as Message['status'],
    kind: r.kind as Message['kind'],
    body: event ? systemText(event, locale) : (r.body as string),
    event,
    mentions: mentionsOf(r),
    artifactId: (r.artifact_id as string | null) ?? null,
    artifactVersion: (r.artifact_version as number | null) ?? null,
    file:
      r.file_id && r.file_name != null
        ? { id: r.file_id as string, name: r.file_name as string, mime: r.file_mime as string, size: r.file_size as number }
        : null,
    edited: !!r.edited,
    createdAt: r.created_at as number,
  }
}

const messageRow = (id: string) => one(`${MSG_SELECT} WHERE m.id = ?`, id)

async function getUser(userId: string): Promise<Row> {
  const u = await one(`${USER_SELECT} WHERE u.id = ?`, userId)
  if (!u) throw new HttpError(404, 'user_not_found')
  return u
}

// ── 권한 ───────────────────────────────────────────────────────

function canSee(m: Row, v: Viewer): boolean {
  if (m.status === 'rejected' || m.status === 'pending') return m.author_id === v.userId
  if (m.visibility === 'private') return m.author_id === v.userId
  return true
}

/** 에이전트는 그 채널에서 켜져 있을 때만 참여자로 본다 */
function allowed(m: Row | undefined, v: Viewer): boolean {
  return !!m && (v.kind !== 'agent' || !!m.agent_enabled)
}

async function membership(channelId: string, v: Viewer): Promise<Row | undefined> {
  const m = await one('SELECT * FROM members WHERE channel_id = ? AND user_id = ?', channelId, v.userId)
  return allowed(m, v) ? m : undefined
}

async function requireMember(channelId: string, v: Viewer): Promise<Row> {
  const m = await membership(channelId, v)
  if (!m) throw new HttpError(404, 'channel_not_found')
  return m
}

/** 채널 참여자 표를 한 번 읽어, 연결마다 볼 수 있는지 고른다 */
async function memberFilter(channelId: string): Promise<(v: Viewer) => boolean> {
  const rows = new Map((await all('SELECT * FROM members WHERE channel_id = ?', channelId)).map((r) => [r.user_id as string, r]))
  return (v) => allowed(rows.get(v.userId), v)
}

function requireHuman(v: Viewer) {
  if (v.kind !== 'human') throw new HttpError(403, 'humans_only')
}

// ── 뷰 ────────────────────────────────────────────────────────

async function channelView(channelId: string, v: Viewer): Promise<Channel> {
  const [c, members, recent, unreadRows, pending] = await Promise.all([
    one('SELECT * FROM channels WHERE id = ?', channelId),
    all(
      `SELECT u.*, ${AGENT_ONLINE} AS agent_online, m.agent_enabled, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? ORDER BY m.joined_at`,
      channelId,
    ),
    all(`${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT 30`, channelId),
    all(
      `SELECT author_id, author_kind, status, visibility FROM messages
       WHERE channel_id = ? AND status = 'sent'
         AND created_at > COALESCE((SELECT last_read_at FROM members WHERE channel_id = ? AND user_id = ?), 0)
       LIMIT 200`,
      channelId,
      channelId,
      v.userId,
    ),
    one(`SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND author_id = ? AND status = 'pending'`, channelId, v.userId),
  ])
  if (!c) throw new HttpError(404, 'channel_not_found')
  const last = recent.find((m) => m.kind !== 'system' && m.status === 'sent' && canSee(m, v))
  const unread = unreadRows.filter((m) => canSee(m, v) && !(m.author_id === v.userId && m.author_kind === 'human')).length
  let lastMessage: string | null = null
  if (last?.kind === 'artifact') {
    lastMessage = ((await one('SELECT title FROM artifacts WHERE id = ?', last.artifact_id as string))?.title as string | undefined) ?? ''
  } else if (last?.kind === 'file') {
    lastMessage = (last.file_name as string | null) ?? ''
  } else if (last) {
    lastMessage = (last.body as string).slice(0, 120)
  }
  return {
    id: c.id as string,
    title: c.title as string,
    stage: c.stage as Stage,
    turnLimit: c.turn_limit as number,
    requireApproval: !!c.require_approval,
    createdBy: c.created_by as string,
    createdAt: c.created_at as number,
    updatedAt: c.updated_at as number,
    members: members.map(
      (r): Member => ({ ...userOf(r), agentEnabled: !!r.agent_enabled, joinedAt: r.joined_at as number }),
    ),
    lastMessage,
    lastMessageKind: last ? (last.kind as 'text' | 'artifact' | 'file') : null,
    pendingCount: (pending?.n as number) ?? 0,
    unread,
  }
}

async function artifactView(artifactId: string, v: Viewer): Promise<Artifact | null> {
  const [a, versionRows, finalizationRows] = await Promise.all([
    one('SELECT * FROM artifacts WHERE id = ?', artifactId),
    all('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version', artifactId),
    all('SELECT * FROM finalizations WHERE artifact_id = ? ORDER BY created_at', artifactId),
  ])
  if (!a) return null
  const versions = versionRows
    .filter((r) => r.status === 'sent' || (r.status === 'pending' && r.author_id === v.userId))
    .map((r) => ({
      version: r.version as number,
      content: r.content as string,
      authorId: r.author_id as string,
      authorKind: r.author_kind as Artifact['versions'][number]['authorKind'],
      agentKind: (r.agent_kind as AgentKind | null) ?? null,
      status: r.status as Artifact['versions'][number]['status'],
      createdAt: r.created_at as number,
    }))
  if (!versions.length) return null
  return {
    id: a.id as string,
    channelId: a.channel_id as string,
    title: a.title as string,
    status: a.status as Artifact['status'],
    finalVersion: (a.final_version as number | null) ?? null,
    createdBy: a.created_by as string,
    createdAt: a.created_at as number,
    updatedAt: a.updated_at as number,
    versions,
    finalizations: finalizationRows.map((r) => ({
      version: r.version as number,
      userId: r.user_id as string,
      createdAt: r.created_at as number,
    })),
  }
}

function permissionOf(r: Row): PermissionRequest {
  const expired = r.status === 'pending' && now() - (r.created_at as number) > PERMISSION_TTL
  return {
    id: r.id as string,
    userId: r.user_id as string,
    requestId: r.request_id as string,
    toolName: r.tool_name as string,
    description: r.description as string,
    inputPreview: r.input_preview as string,
    status: expired ? 'expired' : (r.status as PermissionRequest['status']),
    createdAt: r.created_at as number,
  }
}

// ── 이벤트 받기(bus → 이 인스턴스의 연결) ────────────────────────

const ownedBy = (c: Conn, userId: string, kind?: ViewerKind) => c.viewer.userId === userId && (!kind || c.viewer.kind === kind)

async function deliver(ev: BusEvent) {
  if (!conns.size) return
  const targets = () => [...conns.values()].filter((c) => c.active)
  switch (ev.t) {
    case 'message': {
      const row = await messageRow(ev.id)
      if (!row) return
      const ok = await memberFilter(row.channel_id as string)
      for (const c of targets()) if (ok(c.viewer) && canSee(row, c.viewer)) send(c, { type: 'message', message: msgOf(row, c.locale) })
      return
    }
    case 'channel': {
      const ok = await memberFilter(ev.id)
      const to = targets().filter((c) => ok(c.viewer) && (!ev.userId || ownedBy(c, ev.userId, ev.kind)))
      const views = await Promise.all(to.map((c) => channelView(ev.id, c.viewer)))
      to.forEach((c, i) => send(c, { type: 'channel', channel: views[i] }))
      return
    }
    case 'artifact': {
      const ok = await memberFilter(ev.channelId)
      const to = targets().filter((c) => ok(c.viewer))
      const views = await Promise.all(to.map((c) => artifactView(ev.id, c.viewer)))
      to.forEach((c, i) => {
        const view = views[i]
        send(c, view ? { type: 'artifact', artifact: view } : { type: 'artifact_removed', artifactId: ev.id, channelId: ev.channelId })
      })
      return
    }
    case 'presence': {
      const u = await one(`${USER_SELECT} WHERE u.id = ?`, ev.userId)
      if (!u) return
      const peers = new Set(
        (
          await all(
            `SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.channel_id = m2.channel_id WHERE m1.user_id = ?`,
            ev.userId,
          )
        ).map((r) => r.id as string),
      )
      peers.add(ev.userId)
      const out: ServerEvent = {
        type: 'presence',
        userId: ev.userId,
        agentOnline: !!u.agent_online,
        agentKind: (u.agent_kind as AgentKind | null) ?? null,
      }
      for (const c of targets()) if (peers.has(c.viewer.userId)) send(c, out)
      return
    }
    case 'user': {
      const u = await one(`${USER_SELECT} WHERE u.id = ?`, ev.userId)
      if (!u) return
      const user = userOf(u)
      for (const c of targets()) if (ownedBy(c, ev.userId)) send(c, { type: 'user', user })
      return
    }
    case 'permission': {
      const r = await one('SELECT * FROM permission_requests WHERE id = ?', ev.id)
      if (!r) return
      const request = permissionOf(r)
      for (const c of targets()) if (ownedBy(c, request.userId, 'human')) send(c, { type: 'permission', request })
      return
    }
    case 'owner':
      for (const c of targets()) if (ownedBy(c, ev.userId, ev.kind)) send(c, ev.ev)
      return
    case 'kick':
      for (const c of conns.values()) if (ownedBy(c, ev.userId, ev.kind)) c.ws.close(ev.code, ev.reason)
      return
    case 'handoff': {
      // 모든 인스턴스가 같은 순서로 받으므로, 이 앞의 이벤트는 옛 연결로, 뒤의 이벤트는 새 연결로 간다
      const old = conns.get(ev.from)
      if (old) {
        old.active = false
        old.ws.close(4000, 'handoff')
      }
      const fresh = conns.get(ev.to)
      if (fresh) fresh.active = true
      return
    }
  }
}

// 받기가 끊기면 그 사이 이벤트를 놓쳤을 수 있다. 연결을 닫아 다시 붙고(새로 불러오게) 한다.
onBus(deliver, () => {
  for (const c of conns.values()) c.ws.close(1012, 'relay restart')
})

// ── 쓰기 도우미 ────────────────────────────────────────────────

/**
 * 채널 하나에 쓰는 일은 채널 행을 잠근 한 트랜잭션에서 한다.
 * 같은 채널 요청이 동시에 와도 하나씩 처리된다(버전 번호, 확정 동의, 연속 발언 한도, 승인/버리기가 엇갈리지 않게).
 */
function inChannel<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  return tx(async () => {
    await one('SELECT id FROM channels WHERE id = ? FOR UPDATE', channelId)
    return fn()
  })
}

async function insertMessage(m: {
  channelId: string
  authorId: string | null
  authorKind: Message['authorKind']
  agentKind?: AgentKind | null
  visibility?: Message['visibility']
  status?: Message['status']
  kind?: Message['kind']
  body: string
  artifactId?: string | null
  artifactVersion?: number | null
  fileId?: string | null
  event?: SystemEvent | null
  mentions?: string[]
}): Promise<Row> {
  const id = randomUUID()
  const t = now()
  await run(
    `INSERT INTO messages (id, channel_id, author_id, author_kind, agent_kind, visibility, status, kind, body, artifact_id, artifact_version, file_id, event, mentions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    m.channelId,
    m.authorId,
    m.authorKind,
    m.agentKind ?? null,
    m.visibility ?? 'channel',
    m.status ?? 'sent',
    m.kind ?? 'text',
    m.body,
    m.artifactId ?? null,
    m.artifactVersion ?? null,
    m.fileId ?? null,
    m.event ? JSON.stringify(m.event) : null,
    m.mentions?.length ? JSON.stringify(m.mentions) : null,
    t,
  )
  await run('UPDATE channels SET updated_at = ? WHERE id = ?', t, m.channelId)
  return (await messageRow(id))!
}

// body 에는 영어 문장을 남겨 두고(예전 클라이언트용), 보낼 때 받는 사람 언어로 다시 만든다
async function systemMessage(channelId: string, event: SystemEvent) {
  const row = await insertMessage({ channelId, authorId: null, authorKind: 'system', kind: 'system', body: systemText(event, 'en'), event })
  await publish({ t: 'message', id: row.id as string })
}

// 사람이 끼어들지 않은 채 에이전트끼리 주고받은 수. 상한을 넘으면 사람 차례.
async function agentStreak(channelId: string): Promise<number> {
  const rows = await all(
    `SELECT author_kind FROM messages WHERE channel_id = ? AND visibility = 'channel' AND status = 'sent' AND kind != 'system'
     ORDER BY created_at DESC LIMIT 100`,
    channelId,
  )
  let n = 0
  for (const r of rows) {
    if (r.author_kind !== 'agent') break
    n++
  }
  return n
}

async function checkAgentTurn(channelId: string, v: Viewer) {
  if (v.kind !== 'agent') return
  const c = (await one('SELECT turn_limit FROM channels WHERE id = ?', channelId))!
  if ((await agentStreak(channelId)) >= (c.turn_limit as number)) {
    throw new HttpError(409, 'agent_turn_limit', { limit: c.turn_limit as number })
  }
}

function newCode(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  return Array.from(bytes, (b) => abc[b % abc.length]).join('')
}

// ── 에이전트 작업 상태(작업 중·허락 대기·끝). 마스터에게만 보낸다 ──────────

const ACTIVITY_STATES: AgentActivityState[] = ['working', 'waiting', 'idle']

async function setActivity(userId: string, channelId: string, state: AgentActivityState, detail = '', permissionId: string | null = null) {
  const activity: AgentActivity = { userId, channelId, state, detail, permissionId, at: now() }
  if (state === 'idle') {
    await run('DELETE FROM agent_activities WHERE user_id = ? AND channel_id = ?', userId, channelId)
  } else {
    await run(
      `INSERT INTO agent_activities (user_id, channel_id, state, detail, permission_id, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET state = excluded.state, detail = excluded.detail, permission_id = excluded.permission_id, at = excluded.at`,
      userId,
      channelId,
      state,
      detail,
      permissionId,
      activity.at,
    )
  }
  await publish({ t: 'owner', userId, kind: 'human', ev: { type: 'agent_activity', activity } })
}

async function clearActivities(userId: string) {
  for (const r of await all('SELECT channel_id FROM agent_activities WHERE user_id = ?', userId)) {
    await setActivity(userId, r.channel_id as string, 'idle')
  }
}

/** 지금 진행 중인 작업. 에이전트가 붙어 있지 않으면(끊긴 채 남은 것) 없는 것으로 본다. */
async function activitiesOf(userId: string): Promise<AgentActivity[]> {
  const rows = await all(
    `SELECT a.* FROM agent_activities a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND ${AGENT_ONLINE}`,
    userId,
  )
  return rows.map((r) => ({
    userId,
    channelId: r.channel_id as string,
    state: r.state as AgentActivityState,
    detail: r.detail as string,
    permissionId: (r.permission_id as string | null) ?? null,
    at: r.at as number,
  }))
}

// ── 라우터 ─────────────────────────────────────────────────────

interface Ctx {
  viewer: Viewer
  /** 요청한 쪽 언어(Accept-Language) */
  locale: Locale
  params: string[]
  body: Record<string, unknown>
  query: URLSearchParams
  /** 이 서버의 바깥 주소(https://hamkke.watalabs.com) */
  origin: string
}
type Handler = (ctx: Ctx) => Promise<unknown>
const routes: { method: string; re: RegExp; auth: boolean; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler, auth = true) {
  routes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), auth, handler })
}

async function viewerFromToken(token: string | null): Promise<Viewer | null> {
  if (!token) return null
  const t = await one('SELECT * FROM tokens WHERE token = ?', token)
  if (!t) return null
  return { userId: t.user_id as string, kind: t.kind as ViewerKind, agentKind: (t.agent_kind as AgentKind | null) ?? null }
}

// 가입·나
route(
  'POST',
  '/signup',
  async ({ body }) => {
    const name = str(body.name).trim().slice(0, 30)
    if (!name) throw new HttpError(400, 'name_required')
    const id = randomUUID()
    const token = 'h_' + randomBytes(24).toString('base64url')
    await tx(async () => {
      await run(
        'INSERT INTO users (id, name, color, created_at) VALUES (?, ?, ?, ?)',
        id,
        name,
        COLORS[Math.floor(Math.random() * COLORS.length)],
        now(),
      )
      await run('INSERT INTO tokens (token, user_id, kind, created_at) VALUES (?, ?, ?, ?)', token, id, 'human', now())
    })
    return { user: userOf(await getUser(id)), token }
  },
  false,
)

route('GET', '/me', async ({ viewer }) => ({ user: userOf(await getUser(viewer.userId)), kind: viewer.kind, agentKind: viewer.agentKind }))

route('PATCH', '/me', async ({ viewer, body }) => {
  requireHuman(viewer)
  const name = str(body.name).trim().slice(0, 30)
  if (name) await run('UPDATE users SET name = ? WHERE id = ?', name, viewer.userId)
  if (typeof body.autoApprove === 'boolean') await run('UPDATE users SET auto_approve = ? WHERE id = ?', Number(body.autoApprove), viewer.userId)
  const user = userOf(await getUser(viewer.userId))
  // 내 화면과 내 에이전트가 바로 알도록(에이전트는 요청을 얼마나 조심해 처리할지 정한다)
  await publish({ t: 'user', userId: viewer.userId })
  for (const r of await all('SELECT channel_id FROM members WHERE user_id = ?', viewer.userId)) {
    await publish({ t: 'channel', id: r.channel_id as string })
  }
  return { user }
})

route('POST', '/agent-tokens', async ({ viewer, body }) => {
  requireHuman(viewer)
  const agentKind = str(body.agentKind) as AgentKind
  if (!AGENT_KINDS.includes(agentKind)) throw new HttpError(400, 'unsupported_agent')
  const token = 'a_' + randomBytes(24).toString('base64url')
  await tx(async () => {
    await one('SELECT id FROM users WHERE id = ? FOR UPDATE', viewer.userId)
    await run(`DELETE FROM tokens WHERE user_id = ? AND kind = 'agent'`, viewer.userId)
    await run(
      'INSERT INTO tokens (token, user_id, kind, agent_kind, created_at) VALUES (?, ?, ?, ?, ?)',
      token,
      viewer.userId,
      'agent',
      agentKind,
      now(),
    )
    await run('UPDATE users SET agent_kind = ? WHERE id = ?', agentKind, viewer.userId)
    // 예전 토큰으로 붙어 있던 에이전트 연결은 끊는다
    await publish({ t: 'kick', userId: viewer.userId, kind: 'agent', code: 4001, reason: 'token rotated' })
    await publish({ t: 'presence', userId: viewer.userId })
  })
  return { token, agentKind }
})

// 채널
route('GET', '/channels', async ({ viewer }) => {
  const ids = (
    await all(`SELECT channel_id FROM members WHERE user_id = ? ${viewer.kind === 'agent' ? 'AND agent_enabled = 1' : ''}`, viewer.userId)
  ).map((r) => r.channel_id as string)
  return (await Promise.all(ids.map((id) => channelView(id, viewer)))).sort((a, b) => b.updatedAt - a.updatedAt)
})

route('POST', '/channels', async ({ viewer, body, locale }) => {
  requireHuman(viewer)
  const title = str(body.title).trim().slice(0, 80) || defaultChannelTitle(locale)
  const id = randomUUID()
  const t = now()
  await tx(async () => {
    await run('INSERT INTO channels (id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, title, viewer.userId, t, t)
    await run('INSERT INTO members (channel_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', id, viewer.userId, t, t)
    await publish({ t: 'channel', id })
  })
  return channelView(id, viewer)
})

route('GET', '/channels/:id', async ({ viewer, params }) => {
  await requireMember(params[0], viewer)
  return channelView(params[0], viewer)
})

route('PATCH', '/channels/:id', async ({ viewer, params, body }) => {
  requireHuman(viewer)
  const id = params[0]
  await requireMember(id, viewer)
  await inChannel(id, async () => {
    const c = (await one('SELECT * FROM channels WHERE id = ?', id))!
    const name = (await getUser(viewer.userId)).name as string
    if (typeof body.title === 'string' && body.title.trim()) {
      await run('UPDATE channels SET title = ? WHERE id = ?', body.title.trim().slice(0, 80), id)
    }
    if (typeof body.stage === 'string' && STAGES.includes(body.stage as Stage) && body.stage !== c.stage) {
      await run('UPDATE channels SET stage = ? WHERE id = ?', body.stage, id)
      await systemMessage(id, { type: 'stage_changed', name, stage: body.stage as Stage })
    }
    if (typeof body.requireApproval === 'boolean' && Number(body.requireApproval) !== c.require_approval) {
      await run('UPDATE channels SET require_approval = ? WHERE id = ?', Number(body.requireApproval), id)
      await systemMessage(id, { type: 'approval_toggled', name, on: body.requireApproval })
    }
    if (typeof body.turnLimit === 'number') {
      const limit = Math.max(1, Math.min(50, Math.round(body.turnLimit)))
      await run('UPDATE channels SET turn_limit = ? WHERE id = ?', limit, id)
    }
    await publish({ t: 'channel', id })
  })
  return channelView(id, viewer)
})

route('PATCH', '/channels/:id/me', async ({ viewer, params, body }) => {
  requireHuman(viewer)
  const id = params[0]
  await requireMember(id, viewer)
  await inChannel(id, async () => {
    const m = await requireMember(id, viewer)
    if (typeof body.agentEnabled === 'boolean' && Number(body.agentEnabled) !== m.agent_enabled) {
      await run('UPDATE members SET agent_enabled = ? WHERE channel_id = ? AND user_id = ?', Number(body.agentEnabled), id, viewer.userId)
      const name = (await getUser(viewer.userId)).name as string
      await systemMessage(id, { type: 'agent_toggled', name, on: body.agentEnabled })
    }
    await publish({ t: 'channel', id })
  })
  return channelView(id, viewer)
})

route('POST', '/channels/:id/read', async ({ viewer, params }) => {
  requireHuman(viewer)
  await requireMember(params[0], viewer)
  await run('UPDATE members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', now(), params[0], viewer.userId)
  await publish({ t: 'channel', id: params[0], userId: viewer.userId, kind: 'human' })
  return channelView(params[0], viewer)
})

// 초대
route('POST', '/channels/:id/invites', async ({ viewer, params }) => {
  requireHuman(viewer)
  await requireMember(params[0], viewer)
  const existing = await one('SELECT code FROM invites WHERE channel_id = ? AND created_by = ?', params[0], viewer.userId)
  if (existing) return { code: existing.code }
  const code = newCode()
  await run('INSERT INTO invites (code, channel_id, created_by, created_at) VALUES (?, ?, ?, ?)', code, params[0], viewer.userId, now())
  return { code }
})

route('POST', '/invites/:code/accept', async ({ viewer, params }) => {
  requireHuman(viewer)
  const inv = await one('SELECT * FROM invites WHERE code = ?', params[0].toUpperCase())
  if (!inv) throw new HttpError(404, 'invite_not_found')
  const channelId = inv.channel_id as string
  await inChannel(channelId, async () => {
    if (await membership(channelId, viewer)) return
    await run('INSERT INTO members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', channelId, viewer.userId, now())
    await systemMessage(channelId, { type: 'joined', name: (await getUser(viewer.userId)).name as string })
    await publish({ t: 'channel', id: channelId })
  })
  return channelView(channelId, viewer)
})

// 메시지
// 나를 @로 지목한 요청 중 since 뒤에 온 것(최근 24시간, 최대 20개).
// 에이전트가 꺼져 있는 동안 온 요청을 다시 접속했을 때 받아 처리하게 한다.
route('GET', '/mentions', async ({ viewer, query, locale }) => {
  const since = Math.max(Number(query.get('since')) || 0, now() - MISSED_WINDOW)
  return (
    await all(
      `${MSG_SELECT} JOIN members mb ON mb.channel_id = m.channel_id AND mb.user_id = ?
       WHERE m.created_at > ? AND m.status = 'sent' AND m.visibility = 'channel' AND m.author_id != ? AND m.mentions LIKE ?
       ORDER BY m.created_at ASC LIMIT 20`,
      viewer.userId,
      since,
      viewer.userId,
      `%"${viewer.userId}"%`,
    )
  )
    .filter((m) => canSee(m, viewer))
    .map((m) => msgOf(m, locale))
})

route('GET', '/channels/:id/messages', async ({ viewer, params, locale }) => {
  await requireMember(params[0], viewer)
  return (await all(`${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at ASC LIMIT 1000`, params[0]))
    .filter((m) => m.status !== 'rejected' && canSee(m, viewer))
    .map((m) => msgOf(m, locale))
})

route('POST', '/channels/:id/messages', async ({ viewer, params, body }) => {
  const channelId = params[0]
  await requireMember(channelId, viewer)
  const text = str(body.body).trim()
  if (!text) throw new HttpError(400, 'empty_message')
  if (text.length > 20000) throw new HttpError(400, 'message_too_long')
  const visibility = body.visibility === 'private' ? 'private' : 'channel'
  const row = await inChannel(channelId, async () => {
    let status: Message['status'] = 'sent'
    if (viewer.kind === 'agent' && visibility === 'channel') {
      await checkAgentTurn(channelId, viewer)
      const c = (await one('SELECT require_approval FROM channels WHERE id = ?', channelId))!
      if (c.require_approval && !(await autoApproves(viewer.userId))) status = 'pending'
    }
    const row = await insertMessage({
      channelId,
      authorId: viewer.userId,
      authorKind: viewer.kind,
      agentKind: viewer.kind === 'agent' ? viewer.agentKind : null,
      visibility,
      status,
      body: text,
      mentions: visibility === 'channel' ? await findMentions(channelId, viewer.userId, text) : [],
    })
    await publish({ t: 'message', id: row.id as string })
    await publish({ t: 'channel', id: channelId })
    return row
  })
  return msgOf(row)
})

/** 내 에이전트가 올려 승인을 기다리는 메시지. 채널 잠금 안에서 다시 읽는다. */
async function pendingOf(messageId: string, viewer: Viewer, missing: ErrorCode): Promise<{ channelId: string; read: () => Promise<Row> }> {
  const first = await one('SELECT channel_id FROM messages WHERE id = ?', messageId)
  if (!first) throw new HttpError(404, missing)
  const channelId = first.channel_id as string
  return {
    channelId,
    read: async () => {
      const m = await one('SELECT * FROM messages WHERE id = ?', messageId)
      if (!m || m.author_id !== viewer.userId || m.status !== 'pending') throw new HttpError(404, missing)
      return m
    },
  }
}

route('POST', '/messages/:id/approve', async ({ viewer, params, body }) => {
  requireHuman(viewer)
  const { channelId, read } = await pendingOf(params[0], viewer, 'nothing_to_approve')
  const row = await inChannel(channelId, async () => {
    const m = await read()
    await requireMember(channelId, viewer)
    const edited = typeof body.body === 'string' && body.body.trim() && body.body.trim() !== m.body && m.kind === 'text'
    const finalBody = edited ? (body.body as string).trim() : (m.body as string)
    const t = now()
    await run(
      `UPDATE messages SET status = 'sent', created_at = ?, body = ?, edited = ?, mentions = ? WHERE id = ?`,
      t,
      finalBody,
      edited ? 1 : (m.edited as number),
      // 고쳐서 보냈으면 지목도 다시 찾는다
      edited && m.visibility === 'channel'
        ? JSON.stringify(await findMentions(channelId, viewer.userId, finalBody))
        : ((m.mentions as string | null) ?? null),
      m.id as string,
    )
    await run('UPDATE channels SET updated_at = ? WHERE id = ?', t, channelId)
    if (m.kind === 'artifact' && m.artifact_id) {
      await run(`UPDATE artifact_versions SET status = 'sent' WHERE artifact_id = ? AND version = ?`, m.artifact_id, m.artifact_version)
      await run(`UPDATE artifacts SET updated_at = ?, status = 'draft' WHERE id = ?`, now(), m.artifact_id)
      await publish({ t: 'artifact', id: m.artifact_id as string, channelId })
    }
    await publish({ t: 'message', id: m.id as string })
    await publish({ t: 'channel', id: channelId })
    return (await messageRow(m.id as string))!
  })
  return msgOf(row)
})

route('POST', '/messages/:id/reject', async ({ viewer, params }) => {
  requireHuman(viewer)
  const { channelId, read } = await pendingOf(params[0], viewer, 'nothing_to_discard')
  const fileId = await inChannel(channelId, async () => {
    const m = await read()
    await run(`UPDATE messages SET status = 'rejected' WHERE id = ?`, m.id as string)
    let fileId: string | null = null
    if (m.kind === 'file' && m.file_id) {
      // 버린 파일은 서버에 남기지 않는다(바이트는 커밋 뒤에 지운다)
      fileId = m.file_id as string
      await run('DELETE FROM files WHERE id = ?', fileId)
    }
    if (m.kind === 'artifact' && m.artifact_id) {
      await run('DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?', m.artifact_id, m.artifact_version)
      const left = (await one('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?', m.artifact_id))!
      if (!left.n) {
        await run('DELETE FROM finalizations WHERE artifact_id = ?', m.artifact_id)
        await run('DELETE FROM artifacts WHERE id = ?', m.artifact_id)
      }
      await publish({ t: 'artifact', id: m.artifact_id as string, channelId })
    }
    await publish({ t: 'message', id: m.id as string })
    await publish({ t: 'channel', id: channelId })
    return fileId
  })
  if (fileId) await storage.remove(fileId).catch((e) => console.error('[files] remove', e))
  return { ok: true }
})

// 문서
route('GET', '/channels/:id/artifacts', async ({ viewer, params }) => {
  await requireMember(params[0], viewer)
  const rows = await all('SELECT id FROM artifacts WHERE channel_id = ? ORDER BY updated_at DESC', params[0])
  return (await Promise.all(rows.map((r) => artifactView(r.id as string, viewer)))).filter(Boolean)
})

route('GET', '/artifacts/:id', async ({ viewer, params }) => {
  const a = await one('SELECT channel_id FROM artifacts WHERE id = ?', params[0])
  if (!a) throw new HttpError(404, 'document_not_found')
  await requireMember(a.channel_id as string, viewer)
  const view = await artifactView(params[0], viewer)
  if (!view) throw new HttpError(404, 'document_not_found')
  return view
})

route('POST', '/channels/:id/artifacts', async ({ viewer, params, body }) => {
  const channelId = params[0]
  await requireMember(channelId, viewer)
  const content = str(body.content)
  if (!content.trim()) throw new HttpError(400, 'empty_document')
  if (content.length > 200_000) throw new HttpError(400, 'document_too_long')

  const { artifactId, msg } = await inChannel(channelId, async () => {
    await checkAgentTurn(channelId, viewer)
    let artifactId = str(body.artifactId)
    const t = now()
    if (artifactId) {
      const a = await one('SELECT id FROM artifacts WHERE id = ? AND channel_id = ?', artifactId, channelId)
      if (!a) throw new HttpError(404, 'document_not_found')
    } else {
      const title = str(body.title).trim().slice(0, 120)
      if (!title) throw new HttpError(400, 'title_required')
      artifactId = randomUUID()
      await run(
        'INSERT INTO artifacts (id, channel_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        artifactId,
        channelId,
        title,
        viewer.userId,
        t,
        t,
      )
    }
    const max = await one('SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id = ?', artifactId)
    const version = ((max?.v as number | null) ?? 0) + 1
    const c = (await one('SELECT require_approval FROM channels WHERE id = ?', channelId))!
    const status: Message['status'] =
      viewer.kind === 'agent' && c.require_approval && !(await autoApproves(viewer.userId)) ? 'pending' : 'sent'
    const agentKind = viewer.kind === 'agent' ? viewer.agentKind : null
    await run(
      `INSERT INTO artifact_versions (artifact_id, version, content, author_id, author_kind, agent_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      artifactId,
      version,
      content,
      viewer.userId,
      viewer.kind,
      agentKind,
      status,
      t,
    )
    if (status === 'sent') await run(`UPDATE artifacts SET updated_at = ?, status = 'draft' WHERE id = ?`, t, artifactId)
    const msg = await insertMessage({
      channelId,
      authorId: viewer.userId,
      authorKind: viewer.kind,
      agentKind,
      status,
      kind: 'artifact',
      body: str(body.note).trim().slice(0, 2000),
      artifactId,
      artifactVersion: version,
    })
    await publish({ t: 'artifact', id: artifactId, channelId })
    await publish({ t: 'message', id: msg.id as string })
    await publish({ t: 'channel', id: channelId })
    return { artifactId, msg }
  })
  return { artifact: await artifactView(artifactId, viewer), message: msgOf(msg) }
})

route('POST', '/artifacts/:id/finalize', async ({ viewer, params, body }) => {
  requireHuman(viewer)
  const a = await one('SELECT * FROM artifacts WHERE id = ?', params[0])
  if (!a) throw new HttpError(404, 'document_not_found')
  const channelId = a.channel_id as string
  await requireMember(channelId, viewer)
  const version = Number(body.version)
  await inChannel(channelId, async () => {
    const v = await one(`SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ? AND status = 'sent'`, a.id as string, version)
    if (!v) throw new HttpError(400, 'version_not_finalizable')
    await run(
      'INSERT INTO finalizations (artifact_id, version, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      a.id as string,
      version,
      viewer.userId,
      now(),
    )
    const humans = (await all('SELECT user_id FROM members WHERE channel_id = ?', channelId)).map((r) => r.user_id as string)
    const signed = new Set(
      (await all('SELECT user_id FROM finalizations WHERE artifact_id = ? AND version = ?', a.id as string, version)).map(
        (r) => r.user_id as string,
      ),
    )
    const name = (await getUser(viewer.userId)).name as string
    if (humans.every((h) => signed.has(h))) {
      await run(`UPDATE artifacts SET status = 'final', final_version = ?, updated_at = ? WHERE id = ?`, version, now(), a.id as string)
      await systemMessage(channelId, { type: 'doc_finalized', title: a.title as string, version })
    } else {
      await systemMessage(channelId, { type: 'doc_signed', name, title: a.title as string, version, signed: signed.size, total: humans.length })
    }
    await publish({ t: 'artifact', id: a.id as string, channelId })
    await publish({ t: 'channel', id: channelId })
  })
  return artifactView(a.id as string, viewer)
})

// 승인함
route('GET', '/approvals', async ({ viewer, locale }) => {
  requireHuman(viewer)
  const [rows, mine, permissionRows] = await Promise.all([
    all(`${MSG_SELECT} WHERE m.author_id = ? AND m.status = 'pending' ORDER BY m.created_at ASC`, viewer.userId),
    all('SELECT channel_id FROM members WHERE user_id = ?', viewer.userId),
    all(
      `SELECT * FROM permission_requests WHERE user_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at ASC`,
      viewer.userId,
      now() - PERMISSION_TTL,
    ),
  ])
  const channels = new Set(mine.map((r) => r.channel_id as string))
  return {
    messages: rows.filter((m) => channels.has(m.channel_id as string)).map((m) => msgOf(m, locale)),
    permissions: permissionRows.map(permissionOf),
  }
})

// Claude Code 도구 실행 권한 요청(커넥터가 올리고, 사람이 데스크톱에서 답한다)
route('POST', '/permission-requests', async ({ viewer, body }) => {
  if (viewer.kind !== 'agent') throw new HttpError(403, 'agents_only')
  const id = randomUUID()
  // 항상 모두 승인이면 묻지 않고 허용한다(기록은 남긴다)
  const auto = await autoApproves(viewer.userId)
  const requestId = str(body.requestId).slice(0, 16)
  await run(
    `INSERT INTO permission_requests (id, user_id, request_id, tool_name, description, input_preview, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    viewer.userId,
    requestId,
    str(body.toolName).slice(0, 200),
    str(body.description).slice(0, 4000),
    str(body.inputPreview).slice(0, 8000),
    auto ? 'allow' : 'pending',
    now(),
  )
  await publish({ t: 'permission', id })
  if (auto) await publish({ t: 'owner', userId: viewer.userId, kind: 'agent', ev: { type: 'permission_verdict', requestId, behavior: 'allow' } })
  return permissionOf((await one('SELECT * FROM permission_requests WHERE id = ?', id))!)
})

route('POST', '/permission-requests/:id/verdict', async ({ viewer, params, body }) => {
  requireHuman(viewer)
  const behavior = body.behavior === 'allow' ? 'allow' : 'deny'
  // 아직 열려 있을 때만 바꾼다(두 화면에서 동시에 눌러도 한 번만)
  const changed = await run(
    `UPDATE permission_requests SET status = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND created_at > ?`,
    behavior,
    params[0],
    viewer.userId,
    now() - PERMISSION_TTL,
  )
  const r = await one('SELECT * FROM permission_requests WHERE id = ? AND user_id = ?', params[0], viewer.userId)
  if (!r) throw new HttpError(404, 'request_not_found')
  if (!changed) throw new HttpError(410, 'request_closed')
  await publish({ t: 'owner', userId: viewer.userId, kind: 'agent', ev: { type: 'permission_verdict', requestId: r.request_id as string, behavior } })
  await publish({ t: 'permission', id: r.id as string })
  return permissionOf(r)
})

route('POST', '/agent-activity', async ({ viewer, body }) => {
  if (viewer.kind !== 'agent') throw new HttpError(403, 'agents_only')
  const state = ACTIVITY_STATES.includes(body.state as AgentActivityState) ? (body.state as AgentActivityState) : 'idle'
  const ids = Array.isArray(body.channelIds) ? body.channelIds.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
  for (const id of ids) {
    if (!(await membership(id, viewer))) continue
    await setActivity(viewer.userId, id, state, str(body.detail).slice(0, 120), state === 'waiting' ? str(body.permissionId) || null : null)
  }
  return { ok: true }
})

route('GET', '/health', async () => ({ ok: true, storage: storage.kind }), false)

// ── 파일 ─────────────────────────────────────────────────────
// 1) POST /channels/:id/uploads { name, mime, size, visibility } → { uploadId, url }
// 2) 바이트를 url 에 PUT(Content-Type: mime). Vercel Blob 이면 Blob 으로 바로, 로컬이면 이 서버의 PUT /uploads/:id
// 3) POST /channels/:id/files { uploadId, visibility, note } → 메시지
// 에이전트가 채널에 올리는 파일은 채널 설정과 상관없이 늘 마스터 승인을 거친다(로컬 파일이 새지 않게).

function cleanName(raw: unknown): string {
  const name = (String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200)
  return name || 'file'
}

const tooLarge = () => new HttpError(413, 'file_too_large', { mb: Math.round(MAX_FILE / 1024 / 1024) })

route('POST', '/channels/:id/uploads', async ({ viewer, params, body, origin }): Promise<UploadTicket> => {
  const channelId = params[0]
  await requireMember(channelId, viewer)
  const size = Number(body.size)
  if (!(size > 0)) throw new HttpError(400, 'empty_file')
  if (size > MAX_FILE) throw tooLarge()
  // 한도에 걸릴 거면 올리기 전에 알려 준다(낼 때 다시 확인한다)
  if (viewer.kind === 'agent' && body.visibility !== 'private') await checkAgentTurn(channelId, viewer)
  const mime = str(body.mime).split(';')[0].trim().slice(0, 100) || 'application/octet-stream'
  const id = randomUUID()
  const key = randomBytes(18).toString('base64url')
  await run(
    'INSERT INTO files (id, channel_id, uploader_id, name, mime, size, upload_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    channelId,
    viewer.userId,
    cleanName(body.name),
    mime,
    size,
    key,
    now(),
  )
  return { uploadId: id, url: await storage.uploadUrl({ id, key, maxBytes: MAX_FILE, origin }) }
})

route('POST', '/channels/:id/files', async ({ viewer, params, body }) => {
  const channelId = params[0]
  await requireMember(channelId, viewer)
  const fileId = str(body.uploadId)
  const visibility = body.visibility === 'private' ? 'private' : 'channel'
  const f = await one('SELECT * FROM files WHERE id = ? AND channel_id = ? AND uploader_id = ?', fileId, channelId, viewer.userId)
  if (!f) throw new HttpError(404, 'upload_not_found')
  const size = await storage.size(fileId)
  if (size === null) throw new HttpError(400, 'upload_not_found')
  if (size > MAX_FILE) {
    await storage.remove(fileId).catch(() => {})
    throw tooLarge()
  }
  const row = await inChannel(channelId, async () => {
    if (await one('SELECT id FROM messages WHERE file_id = ?', fileId)) throw new HttpError(404, 'upload_not_found') // 이미 냈다
    if (viewer.kind === 'agent' && visibility === 'channel') await checkAgentTurn(channelId, viewer)
    await run('UPDATE files SET size = ?, upload_key = NULL WHERE id = ?', size, fileId)
    const row = await insertMessage({
      channelId,
      authorId: viewer.userId,
      authorKind: viewer.kind,
      agentKind: viewer.kind === 'agent' ? viewer.agentKind : null,
      visibility,
      // 항상 모두 승인을 켠 사람의 에이전트만 바로 올린다
      status: viewer.kind === 'agent' && visibility === 'channel' && !(await autoApproves(viewer.userId)) ? 'pending' : 'sent',
      kind: 'file',
      body: str(body.note).trim().slice(0, 4000),
      fileId,
    })
    await publish({ t: 'message', id: row.id as string })
    await publish({ t: 'channel', id: channelId })
    return row
  })
  return msgOf(row)
})

// 바이트를 그대로 주고받는 경로(JSON 이 아니다)
interface RawCtx {
  req: http.IncomingMessage
  res: http.ServerResponse
  viewer: Viewer | null
  params: string[]
  query: URLSearchParams
}
const rawRoutes: { method: string; re: RegExp; auth: boolean; handler: (ctx: RawCtx) => Promise<void> }[] = []
function rawRoute(method: string, path: string, handler: (ctx: RawCtx) => Promise<void>, auth = true) {
  rawRoutes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), auth, handler })
}

async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw tooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// 로컬 디스크로 올리기(Blob 이 없을 때). 열쇠가 곧 허가다.
rawRoute(
  'PUT',
  '/uploads/:id',
  async ({ req, res, params, query }) => {
    if (storage.kind !== 'disk') throw new HttpError(404, 'route_not_found')
    const f = await one('SELECT * FROM files WHERE id = ? AND upload_key = ?', params[0], query.get('key') ?? '')
    if (!f) throw new HttpError(404, 'upload_not_found')
    const data = await readRaw(req, MAX_FILE)
    if (!data.length) throw new HttpError(400, 'empty_file')
    await storage.write(params[0], data, f.mime as string)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end('{"ok":true}')
  },
  false,
)

// 받기: 그 파일이 든 메시지를 볼 수 있는 사람·에이전트만
rawRoute('GET', '/files/:id', async ({ res, viewer, params, query }) => {
  const [f, m] = await Promise.all([
    one('SELECT * FROM files WHERE id = ?', params[0]),
    one('SELECT * FROM messages WHERE file_id = ?', params[0]),
  ])
  if (!f || !m || !(await membership(m.channel_id as string, viewer!)) || !canSee(m, viewer!) || m.status === 'rejected')
    throw new HttpError(404, 'file_not_found')
  const stream = await storage.open(f.id as string)
  if (!stream) throw new HttpError(404, 'file_not_found')
  const inline = query.get('inline') === '1' && /^image\/(png|jpeg|gif|webp)$/.test(f.mime as string)
  res.writeHead(200, {
    'Content-Type': f.mime as string,
    'Content-Length': String(f.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name as string)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  })
  await new Promise<void>((done, fail) => stream.on('error', fail).on('end', done).pipe(res))
})

// ── HTTP ──────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 2_000_000) throw new HttpError(413, 'body_too_large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

function originOf(req: http.IncomingMessage): string {
  const first = (h: string | string[] | undefined) => String(h ?? '').split(',')[0].trim()
  const proto = first(req.headers['x-forwarded-proto']) || 'http'
  return `${proto}://${first(req.headers['x-forwarded-host']) || req.headers.host}`
}

const bearer = (req: http.IncomingMessage) => req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? null

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept-Language')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const locale = pickLocale(req.headers['accept-language'])
  const find = <T extends { method: string; re: RegExp }>(list: T[]) =>
    list
      .filter((r) => r.method === req.method)
      .map((r) => ({ r, m: r.re.exec(url.pathname) }))
      .find((x) => x.m)
  try {
    await ensureSchema()
    const raw = find(rawRoutes)
    if (raw) {
      const viewer = raw.r.auth ? await viewerFromToken(bearer(req)) : null
      if (raw.r.auth && !viewer) throw new HttpError(401, 'login_required')
      await raw.r.handler({ req, res, viewer, params: raw.m!.slice(1).map(decodeURIComponent), query: url.searchParams })
      return
    }
    const match = find(routes)
    if (!match) throw new HttpError(404, 'route_not_found')
    const viewer = await viewerFromToken(bearer(req))
    if (match.r.auth && !viewer) throw new HttpError(401, 'login_required')
    const body = req.method === 'GET' ? {} : await readBody(req)
    const result = await match.r.handler({
      viewer: viewer!,
      locale,
      params: match.m!.slice(1).map(decodeURIComponent),
      body,
      query: url.searchParams,
      origin: originOf(req),
    })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result ?? null))
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (res.headersSent) return void res.destroy() // 파일을 보내다 실패한 경우
    res
      .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(
        JSON.stringify(
          e instanceof HttpError
            ? { error: errorText(locale, e.code, e.params), code: e.code }
            : { error: errorText(locale, 'server_error'), code: 'server_error' },
        ),
      )
  }
}

export const server = http.createServer((req, res) => void handle(req, res))

// ── WebSocket ────────────────────────────────────────────────
// 연결마다: 붙으면 hello, 30초마다 ping(에이전트면 접속 표시도 갱신), WS_LIFETIME 이 지나면 reconnect 를 보내
// 클라이언트가 ?resume=<connId> 로 새 연결을 열게 한다. 새 연결은 handoff 가 bus 로 돌아올 때부터 이벤트를 받는다.

const wss = new WebSocketServer({ noServer: true })
let beat: NodeJS.Timeout | null = null
let idle: NodeJS.Timeout | null = null

async function heartbeat() {
  const agents: string[] = []
  for (const c of conns.values()) {
    if (!c.alive) {
      c.ws.terminate()
      continue
    }
    c.alive = false
    c.ws.ping()
    if (c.viewer.kind === 'agent') agents.push(c.id)
  }
  if (agents.length) await run('UPDATE agent_conns SET seen_at = now() WHERE id = ANY(?)', agents)
}

function wake() {
  if (idle) clearTimeout(idle)
  idle = null
  beat ??= setInterval(() => void heartbeat().catch((e) => console.error('[ws] heartbeat', e)), 30_000)
}

// 연결이 하나도 없으면 잠시 뒤 받기를 멈춘다(DB 를 깨워 두지 않게)
function rest() {
  if (conns.size || idle) return
  idle = setTimeout(() => {
    idle = null
    if (conns.size) return
    if (beat) clearInterval(beat)
    beat = null
    unlisten()
  }, 30_000)
}

async function opened(ws: WebSocket, viewer: Viewer, locale: Locale, resume: string | null) {
  const conn: Conn = { id: randomUUID(), ws, viewer, locale, active: false, alive: true }
  conns.set(conn.id, conn)
  wake()
  ws.on('pong', () => (conn.alive = true))
  ws.on('close', () => void closed(conn).catch((e) => console.error('[ws] close', e)))
  if (viewer.kind === 'agent') {
    await run('INSERT INTO agent_conns (id, user_id) VALUES (?, ?)', conn.id, viewer.userId)
    await publish({ t: 'presence', userId: viewer.userId })
  }
  if (resume) {
    await publish({ t: 'handoff', from: resume, to: conn.id })
    // 넘겨받기 알림이 안 오면(받기가 끊긴 경우 등) 잠시 뒤 그냥 받기 시작한다
    setTimeout(() => (conn.active = true), 5000).unref()
  }
  sendNow(conn, { type: 'hello', me: userOf(await getUser(viewer.userId)), kind: viewer.kind, connId: conn.id, resumed: !!resume })
  if (viewer.kind === 'human') for (const activity of await activitiesOf(viewer.userId)) sendNow(conn, { type: 'agent_activity', activity })
  if (!resume) conn.active = true
  if (WS_LIFETIME) {
    conn.retire = setTimeout(() => {
      sendNow(conn, { type: 'reconnect' })
      // 넘겨받지 않으면(예전 클라이언트) 닫는다. 클라이언트는 평소처럼 다시 붙는다.
      conn.retire = setTimeout(() => ws.close(4000, 'lifetime'), 30_000)
    }, WS_LIFETIME)
  }
}

async function closed(conn: Conn) {
  if (!conns.delete(conn.id)) return
  clearTimeout(conn.retire)
  rest()
  const { userId, kind } = conn.viewer
  if (kind !== 'agent') return
  await run('DELETE FROM agent_conns WHERE id = ?', conn.id)
  const left = await one(`SELECT 1 FROM agent_conns WHERE user_id = ? AND seen_at > now() - interval '90 seconds'`, userId)
  if (!left) await clearActivities(userId) // 에이전트가 끊기면 '작업 중'이 남지 않게
  await publish({ t: 'presence', userId })
}

async function upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  await ensureSchema()
  const url = new URL(req.url ?? '/', 'http://localhost')
  const viewer = url.pathname === '/ws' ? await viewerFromToken(url.searchParams.get('token')) : null
  if (!viewer) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  await listen()
  const locale = pickLocale(url.searchParams.get('locale') ?? req.headers['accept-language'])
  const resume = url.searchParams.get('resume')
  wss.handleUpgrade(req, socket, head, (ws) => {
    void opened(ws, viewer, locale, resume).catch((e) => {
      console.error('[ws] open', e)
      ws.close(1011, 'server error')
    })
  })
}

server.on('upgrade', (req, socket, head) => {
  void upgrade(req, socket, head).catch((e) => {
    console.error('[ws] upgrade', e)
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
  })
})
