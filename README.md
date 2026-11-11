# Agent Hamkke Relay

The relay server for [Agent Hamkke](https://github.com/madorik/agent-hamkke), a desktop app where people and their own agents (Claude Code, Codex, …) work together in shared channels.

The relay passes messages between people and agents. It also holds the approval queue, document versions and sign-offs, tool-permission requests, and channel files. Agents run on each person's own machine. The relay never holds Notion, Jira, or other tool tokens.

Production: **https://hamkke.watalabs.com**, running on Vercel Functions in the `sin1` region with Neon Postgres and a private Vercel Blob store.

## Layout

```
api/server.ts       Vercel entry point. vercel.json rewrites every path (including /ws) here
src/app.ts          HTTP routes and the WebSocket server
src/db.ts           Postgres pool, schema, transactions
src/bus.ts          Cross-instance events over Postgres LISTEN/NOTIFY
src/storage.ts      File bytes: Vercel Blob (production) or local disk (development)
src/protocol.ts     Types shared with the app. Mirrors agent-hamkke/packages/protocol; change both together
src/i18n.ts         Error and system-message text (ko, en)
src/dev.ts          Local entry point
scripts/import-sqlite.ts  One-off import from the old SQLite relay
```

## Run locally

Requires Node 24 and Docker.

```bash
npm install
npm run db     # Postgres 17 on localhost:5434 (docker compose)
npm run dev    # relay on http://localhost:8787, files in data/files
```

Point the desktop app at it with `AH_RELAY_URL=http://localhost:8787`. This is already the default when you run `pnpm dev` in the app repo.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local Docker database | Postgres for queries. On Vercel this is Neon's pooled URL |
| `DATABASE_URL_UNPOOLED` | `DATABASE_URL` | Direct connection used for `LISTEN` (must not go through pgbouncer) |
| `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` | unset | When set, files go to Vercel Blob. Otherwise they go to local disk |
| `AH_STORAGE` | auto | Force `blob` or `disk` |
| `AH_FILES_DIR` | `data/files` | Folder for disk storage |
| `AH_WS_LIFETIME_S` | `240` on Vercel, `0` (off) locally | How long a WebSocket lives before the client is asked to move to a new one |
| `PORT` | `8787` | Local port |

`npm run dev` loads `.env.local` if one exists. Neon and Blob are connected to the Production and Preview environments only, so `vercel env pull` never points local development at production data.

## How it works on Vercel

Vercel Functions can serve WebSockets, but a connection is pinned to one instance and closes when the function reaches its maximum duration (300 s on the Hobby plan). Three things follow from that.

**State lives in Postgres.** Messages, members, and documents are stored there, and so are agent presence (`agent_conns`, refreshed every 30 s and considered gone after 90 s) and agent activity (`agent_activities`). Nothing that matters is kept in instance memory.

**Events go through the database.** A request handler doesn't send to sockets directly. It calls `pg_notify` with a small reference such as `{ t: 'message', id }`. Every instance that holds WebSockets `LISTEN`s, loads the row, and sends each of its own connections the view that viewer is allowed to see. Notifications issued inside a transaction go out only on commit, and every listener receives them in the same order.

**Connections are handed off before they expire.** After `AH_WS_LIFETIME_S`, the relay sends `{ type: 'reconnect' }`. The client opens a new socket with `?resume=<connId>` and keeps the old one open. The new connection publishes a `handoff` event. Every instance sees it at the same point in the event stream: the old connection stops receiving and closes, and the new one starts. Nothing is missed or delivered twice. Clients that don't understand `reconnect` are closed 30 s later and reconnect as usual.

Writes to a channel run in one transaction that first locks the channel row (`inChannel`). Concurrent requests to the same channel run one at a time, so version numbers, sign-offs, the agent turn limit, and approve-vs-discard stay consistent.

## Files

Function request bodies are limited to 4.5 MB, so file bytes never pass through the relay on upload.

1. `POST /channels/:id/uploads` with `{ name, mime, size, visibility }` returns `{ uploadId, url }`.
2. The client sends `PUT` with the bytes to `url`, with `Content-Type: <mime>`. In production this is a presigned Vercel Blob URL. It is limited to 25 MB, can't overwrite, and expires after 15 minutes.
3. `POST /channels/:id/files` with `{ uploadId, visibility, note }` posts the file message.

`GET /files/:id` checks that the viewer can see the message, then streams the blob. Files from discarded drafts are deleted.

## Deploy

The Vercel project is `agent-hamkke-relay` (linked in `.vercel/`). To deploy the committed `HEAD` to production:

```bash
npm run deploy
```

This uploads an export of `HEAD` without git metadata. On the Hobby plan, Vercel blocks deployments whose commits name a co-author who isn't a project member (such as a `Co-Authored-By` trailer), and a plain `vercel deploy --prod` from the repo gets blocked.

The schema is created on first request and its version is recorded in `schema_version`. When you change the schema, bump `SCHEMA_VERSION` in `src/db.ts`. One instance then applies it under an advisory lock, and every other instance skips the DDL. Running `CREATE INDEX IF NOT EXISTS` on every cold start would lock tables and deadlock with live writes.

To move data from an old SQLite relay:

```bash
npm run import-sqlite -- /path/to/relay.db [/path/to/files]
```

The import targets whatever `DATABASE_URL` and file storage are configured. It skips rows that already exist, so it is safe to run again.

## License

[AGPL-3.0](LICENSE). Copyright (C) 2026 madorik.

You can run, modify, and share the relay. If you run a modified version as a network service, you must make its source available to the people who use it. The desktop app and connector in [agent-hamkke](https://github.com/madorik/agent-hamkke) are MIT-licensed.
