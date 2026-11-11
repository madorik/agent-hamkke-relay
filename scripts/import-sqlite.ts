// 예전 SQLite 중계 서버의 데이터를 Postgres 로 옮긴다(한 번만 쓰는 도구).
//   npm run import-sqlite -- <relay.db 경로> [files 폴더]
// 대상은 DATABASE_URL(없으면 로컬 docker). 파일 바이트는 지금 설정된 저장소(Blob 또는 로컬 디스크)로 올린다.
// 이미 있는 행은 건너뛰므로 여러 번 돌려도 된다.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

try {
  process.loadEnvFile('.env.local')
} catch {}

const [src, filesArg] = process.argv.slice(2)
if (!src || !existsSync(src)) {
  console.error('usage: npm run import-sqlite -- <relay.db> [files dir]')
  process.exit(1)
}
const filesDir = filesArg ?? join(dirname(src), 'files')

const { ensureSchema, run, tx } = await import('../src/db.js')
const { storage } = await import('../src/storage.js')

// 부모 → 자식 순서(외래 키)
const TABLES: [string, string[]][] = [
  ['users', ['id', 'name', 'color', 'agent_kind', 'auto_approve', 'created_at']],
  ['tokens', ['token', 'user_id', 'kind', 'agent_kind', 'created_at']],
  ['channels', ['id', 'title', 'stage', 'turn_limit', 'require_approval', 'created_by', 'created_at', 'updated_at']],
  ['members', ['channel_id', 'user_id', 'agent_enabled', 'joined_at', 'last_read_at']],
  ['invites', ['code', 'channel_id', 'created_by', 'created_at']],
  ['files', ['id', 'channel_id', 'uploader_id', 'name', 'mime', 'size', 'created_at']],
  ['artifacts', ['id', 'channel_id', 'title', 'status', 'final_version', 'created_by', 'created_at', 'updated_at']],
  ['artifact_versions', ['artifact_id', 'version', 'content', 'author_id', 'author_kind', 'agent_kind', 'status', 'created_at']],
  ['finalizations', ['artifact_id', 'version', 'user_id', 'created_at']],
  [
    'messages',
    [
      'id', 'channel_id', 'author_id', 'author_kind', 'agent_kind', 'visibility', 'status', 'kind', 'body',
      'artifact_id', 'artifact_version', 'file_id', 'event', 'mentions', 'edited', 'created_at',
    ],
  ],
  ['permission_requests', ['id', 'user_id', 'request_id', 'tool_name', 'description', 'input_preview', 'status', 'created_at']],
]

const sqlite = new DatabaseSync(src, { readOnly: true })
const hasColumn = (table: string, col: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)

await ensureSchema()
await tx(async () => {
  for (const [table, cols] of TABLES) {
    // 아주 예전 DB 엔 나중에 생긴 열이 없다
    const present = cols.filter((c) => hasColumn(table, c))
    const rows = sqlite.prepare(`SELECT ${present.join(', ')} FROM ${table}`).all() as Record<string, string | number | null>[]
    let added = 0
    for (const r of rows) {
      added += await run(
        `INSERT INTO ${table} (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
        ...present.map((c) => r[c] ?? null),
      )
    }
    console.log(`${table}: ${added}/${rows.length}`)
  }
})

const files = sqlite.prepare('SELECT id, mime FROM files').all() as { id: string; mime: string }[]
let copied = 0
for (const f of files) {
  const p = join(filesDir, f.id)
  if (!existsSync(p) || (await storage.size(f.id)) !== null) continue
  await storage.write(f.id, readFileSync(p), f.mime)
  copied++
}
console.log(`file bytes → ${storage.kind}: ${copied}/${files.length}`)
process.exit(0)
