// 인스턴스 사이 실시간 이벤트(Postgres LISTEN/NOTIFY).
// Vercel 에선 HTTP 요청을 받은 인스턴스와 웹소켓이 붙은 인스턴스가 다를 수 있다. 그래서 무엇이 바뀌었는지만
// pg_notify 로 알리고, 웹소켓을 가진 인스턴스가 받아 자기 연결마다 보는 사람에 맞게 다시 만들어 보낸다.
// - tx() 안에서 publish 하면 커밋될 때 나가고, 되돌리면 버려진다.
// - 모든 인스턴스가 같은 순서로 받는다(커밋 순서). 연결 넘겨주기(handoff)가 이 순서에 기댄다.
// - 내용은 8000바이트까지라 큰 것은 id 만 싣는다.
import pg from 'pg'
import type { ServerEvent, ViewerKind } from './protocol.js'
import { directUrl, run } from './db.js'

const CHANNEL = 'relay_events'

export type BusEvent =
  /** hidden: 공유를 취소해 이제 못 보게 된 참여자에게 지우라고 알린다 */
  | { t: 'message'; id: string; hidden?: boolean }
  /** userId 가 있으면 그 사람의 그 종류 연결에만 */
  | { t: 'channel'; id: string; userId?: string; kind?: ViewerKind }
  | { t: 'artifact'; id: string; channelId: string }
  | { t: 'presence'; userId: string }
  | { t: 'user'; userId: string }
  | { t: 'permission'; id: string }
  /** 결정 요청이 생기거나 바뀜. 결정할 사람의 사람·에이전트 연결에 보낸다 */
  | { t: 'decision'; id: string }
  /** 작은 이벤트를 그대로 그 사람의 그 종류 연결에 */
  | { t: 'owner'; userId: string; kind: ViewerKind; ev: ServerEvent }
  /** 그 사람의 그 종류 연결을 닫는다(토큰을 새로 받았을 때) */
  | { t: 'kick'; userId: string; kind: ViewerKind; code: number; reason: string }
  /** 연결 from 을 닫고 to 로 넘긴다 */
  | { t: 'handoff'; from: string; to: string }

export async function publish(ev: BusEvent): Promise<void> {
  await run('SELECT pg_notify(?, ?)', CHANNEL, JSON.stringify(ev))
}

let handler: (ev: BusEvent) => Promise<void> = async () => {}
let onLost: () => void = () => {}

/** 받은 이벤트를 넘길 곳. 받기가 끊기면 onLost(그 사이 이벤트를 놓쳤으니 연결을 닫아 다시 받게 한다) */
export function onBus(h: (ev: BusEvent) => Promise<void>, lost: () => void) {
  handler = h
  onLost = lost
}

let client: pg.Client | null = null
let starting: Promise<void> | null = null
let queue = Promise.resolve()

/** 받기 시작(이미 받고 있으면 그대로). 웹소켓이 붙을 때 부른다. */
export function listen(): Promise<void> {
  if (client) return Promise.resolve()
  starting ??= connect().finally(() => (starting = null))
  return starting
}

async function connect() {
  const c = new pg.Client({ connectionString: directUrl })
  c.on('notification', (n) => {
    if (n.channel !== CHANNEL || !n.payload) return
    const ev = JSON.parse(n.payload) as BusEvent
    // 하나씩 순서대로(뒤 이벤트가 앞 이벤트를 앞질러 보내지지 않게)
    queue = queue.then(() => handler(ev)).catch((e) => console.error('[bus] handler', e))
  })
  c.on('error', (e) => {
    console.error('[bus] listener error', e)
    drop(c)
  })
  c.on('end', () => drop(c))
  await c.connect()
  try {
    await c.query(`LISTEN ${CHANNEL}`)
  } catch (e) {
    await c.end().catch(() => {})
    throw e
  }
  client = c
}

function drop(c: pg.Client) {
  if (client !== c) return
  client = null
  c.end().catch(() => {})
  onLost()
}

/** 받기를 멈춘다(이 인스턴스에 웹소켓이 하나도 없을 때) */
export function unlisten() {
  const c = client
  client = null
  c?.end().catch(() => {})
}
