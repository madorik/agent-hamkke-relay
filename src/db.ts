// Postgres 연결과 스키마.
// 쿼리는 ? 자리표시자로 쓰고 보낼 때 $1, $2… 로 바꾼다. 그래서 SQL 문장 안에 ? 글자를 직접 쓰면 안 된다.
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { attachDatabasePool } from '@vercel/functions'

// BIGINT(ms 시각, COUNT) 를 문자열 대신 숫자로 받는다. ms 시각은 2^53 안이다.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)

export type Row = Record<string, string | number | boolean | null>
export type Param = string | number | boolean | null | string[]

const LOCAL_URL = 'postgres://hamkke:hamkke@localhost:5434/hamkke' // docker-compose.yml
// pg 는 sslmode=require 를 지금도 verify-full 로 다룬다(곧 바뀐다는 경고를 찍는다). 그 뜻대로 적어 둔다.
const strict = (u: string | undefined) => u?.replace(/([?&]sslmode=)require\b/, '$1verify-full')
const url = strict(process.env.DATABASE_URL ?? (process.env.VERCEL ? undefined : LOCAL_URL))
if (!url) throw new Error('DATABASE_URL is not set')

/** 일반 쿼리(Neon 은 pgbouncer 를 거치는 주소) */
const pool = new pg.Pool({ connectionString: url, max: Number(process.env.AH_DB_POOL ?? 10) })
pool.on('error', (e) => console.error('[db] idle client error', e))
// Vercel 함수가 잠들기 전에 노는 연결을 닫는다(로컬에선 아무 일도 안 한다)
attachDatabasePool(pool)

/** LISTEN 은 pgbouncer(transaction 모드)를 거치면 안 된다 */
export const directUrl = strict(process.env.DATABASE_URL_UNPOOLED) ?? url

const toPg = (sql: string) => {
  let i = 0
  return sql.replace(/\?/g, () => '$' + ++i)
}

// tx() 안에서는 같은 연결로 보낸다
const txClient = new AsyncLocalStorage<pg.PoolClient>()

async function query(sql: string, params: Param[]) {
  return (txClient.getStore() ?? pool).query(toPg(sql), params)
}

export const all = async (sql: string, ...p: Param[]) => (await query(sql, p)).rows as Row[]
export const one = async (sql: string, ...p: Param[]) => (await query(sql, p)).rows[0] as Row | undefined
/** 바뀐 행 수를 돌려준다 */
export const run = async (sql: string, ...p: Param[]) => (await query(sql, p)).rowCount ?? 0

/**
 * fn 을 한 트랜잭션에서 돌린다. 안에서 부르는 all/one/run 은 모두 같은 연결을 쓴다.
 * pg_notify 는 커밋될 때 나가고 되돌리면 버려진다(bus.ts).
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn()
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    const out = await txClient.run(client, fn)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => (broken = true))
    throw e
  } finally {
    client.release(broken)
  }
}

// 시각은 ms(BIGINT). 참/거짓은 0/1(INTEGER) — 예전 SQLite 와 같은 모양이라 행을 그대로 옮길 수 있다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  agent_kind TEXT,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,            -- human | agent
  agent_kind TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'request',
  turn_limit INTEGER NOT NULL DEFAULT 8,
  require_approval INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_enabled INTEGER NOT NULL DEFAULT 1,
  joined_at BIGINT NOT NULL,
  last_read_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members (user_id);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_channel ON invites (channel_id, created_by);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id TEXT,
  author_kind TEXT NOT NULL,     -- human | agent | system
  agent_kind TEXT,
  visibility TEXT NOT NULL,      -- channel | private
  status TEXT NOT NULL,          -- sent | pending | rejected
  kind TEXT NOT NULL,            -- text | system | artifact | file
  body TEXT NOT NULL,
  artifact_id TEXT,
  artifact_version INTEGER,
  file_id TEXT,
  event TEXT,                    -- 시스템 메시지의 이벤트(JSON). 보는 사람 언어로 문장을 만든다
  mentions TEXT,                 -- @이름 으로 지목한 참여자(JSON 배열)
  edited INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_pending ON messages (author_id, status);
CREATE INDEX IF NOT EXISTS messages_file ON messages (file_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  final_version INTEGER,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_channel ON artifacts (channel_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  agent_kind TEXT,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS finalizations (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, version, user_id)
);

-- 바이트는 storage.ts(Vercel Blob 또는 로컬 디스크)에 있다.
-- upload_key: 로컬 디스크로 올릴 때 쓰는 일회용 열쇠. 다 올리면 지운다.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  upload_key TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_preview TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS permission_requests_user ON permission_requests (user_id, status);

-- 지금 붙어 있는 에이전트 연결(인스턴스가 여럿이라 메모리 대신 여기 둔다).
-- 연결이 30초마다 seen_at 을 갱신한다. 90초 넘게 소식이 없으면 끊긴 것으로 본다.
CREATE TABLE IF NOT EXISTS agent_conns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_conns_user ON agent_conns (user_id);

-- 에이전트 작업 상태(작업 중·허락 대기). idle 이면 지운다.
CREATE TABLE IF NOT EXISTS agent_activities (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  permission_id TEXT,
  at BIGINT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

-- v2: 자리 비움. away_since 가 있으면 그때부터 자리를 비웠다(데스크톱이 입력·화면 잠금을 보고 알리거나, 사람이 직접 켠다).
ALTER TABLE users ADD COLUMN IF NOT EXISTS away_since BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS away_note TEXT;

-- v2: 결정 요청. 그 사람이 판단해야 할 일을 사람이 없어도 남겨 둔다.
-- source: agent(그 사람의 에이전트가 남김) | mention(자리에 없고 에이전트도 꺼진 사람을 @로 불러 서버가 남김)
-- status: open | decided(사람이 정함) | dismissed(사람이 넘김) | resolved(에이전트가 스스로 처리함)
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  source TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  options TEXT,                  -- 고를 수 있는 답(JSON 배열)
  requester_id TEXT,             -- 결정을 기다리는 사람
  message_id TEXT,               -- 이 결정이 생긴 메시지(@요청 등)
  status TEXT NOT NULL,
  answer TEXT,
  decided_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_user ON decisions (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_message ON decisions (user_id, message_id) WHERE message_id IS NOT NULL;
`

/** 에이전트가 붙어 있나(SQL 식). users 를 u 로 부른 쿼리에 넣는다. */
export const AGENT_ONLINE = `EXISTS (SELECT 1 FROM agent_conns c WHERE c.user_id = u.id AND c.seen_at > now() - interval '90 seconds')`

// SCHEMA 를 바꾸면 올린다. 버전이 같으면 DDL 을 아예 돌리지 않는다:
// CREATE INDEX IF NOT EXISTS 는 인덱스가 있어도 표를 잠가서, 새 인스턴스가 뜰 때마다 돌리면 쓰기와 교착이 난다.
const SCHEMA_VERSION = 2

async function schemaVersion(q: Pick<pg.PoolClient, 'query'>): Promise<number> {
  const t = await q.query(`SELECT to_regclass('schema_version') AS t`)
  if (!t.rows[0].t) return 0
  return (await q.query('SELECT version FROM schema_version')).rows[0]?.version ?? 0
}

let ready: Promise<void> | null = null

/** 표가 최신인지 보고, 아니면 한 인스턴스만 잠금을 잡고 만든다. */
export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    if ((await schemaVersion(pool)) >= SCHEMA_VERSION) return
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(4248001)')
      if ((await schemaVersion(client)) >= SCHEMA_VERSION) {
        await client.query('COMMIT')
        return
      }
      await client.query(SCHEMA)
      await client.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
      await client.query('DELETE FROM schema_version')
      await client.query('INSERT INTO schema_version (version) VALUES ($1)', [SCHEMA_VERSION])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })().catch((e) => {
    ready = null
    throw e
  })
  return ready
}
