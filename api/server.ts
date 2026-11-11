// Vercel 함수 진입점. vercel.json 이 모든 경로를 여기로 보낸다(웹소켓 /ws 포함).
import { server } from '../src/app.js'

export default server
