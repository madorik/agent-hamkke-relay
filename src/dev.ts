// 로컬 실행: npm run dev (docker compose 의 Postgres, 파일은 data/files)
// .env.local 이 있으면 읽는다(vercel env pull 로 받은 운영 설정도 쓸 수 있다).
try {
  process.loadEnvFile('.env.local')
} catch {}

const { server } = await import('./app.js')
const PORT = Number(process.env.PORT ?? 8787)
server.listen(PORT, () => console.log(`relay listening on http://localhost:${PORT}`))
