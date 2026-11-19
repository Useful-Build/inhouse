// The runner skeleton (P3 R0). It only answers the health route, so the image build and the container start can be
// checked in CI. R1 replaces this with the root runner: the server, the protocol and one process per session.
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 8080)

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404).end()
})

server.listen(port, () => console.log(`runner listening on ${port}`))

process.on('SIGTERM', () => server.close(() => process.exit(0)))
