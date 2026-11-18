import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { groupTurn, installDeb, recoverGroups } from './groups.mjs'
await recoverGroups()
let active = 0
http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/', '/group', '/install-deb'].includes(req.url)) {
      res.writeHead(404).end()
      return
    }
    if (req.url === '/' && active >= 3) {
      res.writeHead(429).end()
      return
    }
    active++
    const name = 'qq-task-' + randomUUID()
    try {
      let size = 0
      const chunks = []
      for await (const part of req) {
        size += part.length
        if (size > 46e6) throw Error('输入过大')
        chunks.push(part)
      }
      const input = Buffer.concat(chunks)
      const payload = JSON.parse(input)
      if (req.url !== '/') {
        const result = req.url === '/group' ? await groupTurn(payload) : await installDeb(payload)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
        return
      }
      if (!['python', 'video', 'audio'].includes(payload.op)) throw Error('未知操作')
      const proc = spawn('docker', [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '-i',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--memory=512m',
        '--cpus=1',
        '--pids-limit=80',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=128m',
        'qq-superagent-sandbox:local',
      ])
      const output = []
      let bytes = 0
      proc.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 16e6) proc.kill()
        else output.push(chunk)
      })
      proc.stderr.resume()
      proc.stdin.on('error', () => {})
      proc.stdin.end(input)
      const kill = setTimeout(() => {
        proc.kill()
        execFile('docker', ['rm', '-f', name], () => {})
      }, 80000)
      try {
        await new Promise((ok, fail) => {
          proc.on('error', fail)
          proc.on('close', (code) =>
            code === 0 && bytes <= 16e6 ? ok() : fail(Error('沙箱任务失败或超时')),
          )
        })
      } finally {
        clearTimeout(kill)
      }
      res.setHeader('content-type', 'application/json')
      res.end(Buffer.concat(output))
    } catch (e) {
      res.writeHead(e.status || 422).end(JSON.stringify({ error: e.message }))
      if (req.url === '/') execFile('docker', ['rm', '-f', name], () => {})
    } finally {
      active--
    }
  })
  .listen(8090)
