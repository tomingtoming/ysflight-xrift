// Tiny static server for the built engine during development (CORS + MIME).
// Vite refuses to import() files under public/, so the dev world loads the
// engine from here instead:  node engine/serve.mjs [port]  (default 5180)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const port = Number(process.argv[2] || 5180)
const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream' }

http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname)
  const file = path.join(dir, name)
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', mime[path.extname(name)] || 'application/octet-stream')
  res.setHeader('Content-Length', fs.statSync(file).size)
  fs.createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`engine served from ${dir} on http://localhost:${port}/`))
