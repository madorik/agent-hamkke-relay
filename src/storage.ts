// 채널 파일의 바이트를 두는 곳.
// - Vercel Blob(private): 앱·커넥터가 presigned URL 로 바로 올린다(함수 요청 본문 4.5MB 제한을 피한다).
//   받을 때는 함수가 권한을 확인하고 스트리밍해 준다.
// - 로컬 디스크: Blob 설정이 없을 때(로컬 개발). 올리기 주소가 이 서버의 PUT /uploads/:id 다.
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { BlobNotFoundError, del, get, head, issueSignedToken, presignUrl, put } from '@vercel/blob'

export interface Storage {
  kind: 'blob' | 'disk'
  /** 바이트를 PUT 할 주소. key 는 로컬 디스크용 일회용 열쇠, origin 은 이 서버 주소 */
  uploadUrl(p: { id: string; key: string; maxBytes: number; origin: string }): Promise<string>
  /** 올라간 크기. 아직 없으면 null */
  size(id: string): Promise<number | null>
  open(id: string): Promise<Readable | null>
  write(id: string, data: Uint8Array, mime: string): Promise<void>
  remove(id: string): Promise<void>
}

const UPLOAD_TTL = 15 * 60_000
const blobPath = (id: string) => `files/${id}`

const blob: Storage = {
  kind: 'blob',
  async uploadUrl({ id, maxBytes }) {
    const pathname = blobPath(id)
    const validUntil = Date.now() + UPLOAD_TTL
    const token = await issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes: maxBytes, validUntil })
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname,
      access: 'private',
      maximumSizeInBytes: maxBytes,
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil,
    })
    return presignedUrl
  },
  async size(id) {
    try {
      return (await head(blobPath(id))).size
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null
      throw e
    }
  },
  async open(id) {
    const r = await get(blobPath(id), { access: 'private' })
    return r?.statusCode === 200 ? Readable.fromWeb(r.stream as import('node:stream/web').ReadableStream) : null
  },
  async write(id, data, mime) {
    await put(blobPath(id), Buffer.from(data), { access: 'private', contentType: mime, addRandomSuffix: false, allowOverwrite: true })
  },
  async remove(id) {
    await del(blobPath(id))
  },
}

const DIR = process.env.AH_FILES_DIR ?? fileURLToPath(new URL('../data/files', import.meta.url))

const disk: Storage = {
  kind: 'disk',
  async uploadUrl({ id, key, origin }) {
    return `${origin}/uploads/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`
  },
  async size(id) {
    const p = join(DIR, id)
    return existsSync(p) ? statSync(p).size : null
  },
  async open(id) {
    const p = join(DIR, id)
    return existsSync(p) ? createReadStream(p) : null
  },
  async write(id, data) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, id), data)
  },
  async remove(id) {
    rmSync(join(DIR, id), { force: true })
  },
}

// Vercel 에선 연결된 Blob 스토어가 BLOB_STORE_ID(OIDC)를, 밖에선 BLOB_READ_WRITE_TOKEN 을 준다
const useBlob = process.env.AH_STORAGE
  ? process.env.AH_STORAGE === 'blob'
  : !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN)

export const storage: Storage = useBlob ? blob : disk
