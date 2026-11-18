import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Store, persona } from './store.mjs'
import { Capabilities } from './capabilities.mjs'
import { Runtime } from './runtime.mjs'
import { QQ } from './qq.mjs'
import { key } from './messages.mjs'

const dir = resolve(process.env.STATE_DIR || 'state')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const tokenFile = join(dir, 'admin-token')
if (!process.env.ADMIN_TOKEN && !existsSync(tokenFile))
  writeFileSync(tokenFile, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' })
const token = process.env.ADMIN_TOKEN || readFileSync(tokenFile, 'utf8').trim()
const store = new Store(join(dir, 'bot.sqlite')),
  caps = new Capabilities(store, join(dir, 'assets')),
  app = new Runtime(store, caps),
  qq = new QQ(app)
qq.enabled = true
function publicConfig() {
  const c = store.config()
  if (c.qq.secret) c.qq.secret = '••••'
  for (const p of Object.values(c.providers)) if (p.key) p.key = '••••'
  return c
}
async function payload(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 46e6) throw Error('输入过大')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}
function save(c) {
  if (!c.qq || !c.groups || !c.providers || typeof c.persona !== 'string' || !c.persona.trim())
    throw Error('配置格式不正确')
  const old = store.config()
  if (c.qq.secret === '••••') c.qq.secret = old.qq.secret
  for (const [k, p] of Object.entries(c.providers)) {
    if (p.key === '••••') p.key = old.providers[k]?.key
    if (p.base && !['https:', 'http:'].includes(new URL(p.base).protocol))
      throw Error('供应商地址须为 HTTP(S)')
  }
  for (const g of Object.values(c.groups))
    if (!['quiet', 'social', 'rules'].includes(g.mode) || !Array.isArray(g.rules))
      throw Error('群策略格式错误')
  store.put('config', 'main', c)
  if (JSON.stringify(old.qq) !== JSON.stringify(c.qq)) qq.reset()
  return publicConfig()
}
function schedules() {
  const now = Date.now()
  for (const t of store.all('schedule'))
    if (t.enabled && t.next <= now)
      store.atomic(() => {
        const id = key(t.id, t.next)
        app.enqueue(id, t.group, '', t.text)
        if (t.every) t.next += t.every * (1 + Math.floor((now - t.next) / t.every))
        else t.enabled = false
        store.put('schedule', t.id, t)
      })
}
const staticDir = fileURLToPath(new URL('../public/', import.meta.url))
const files = { '/': 'index.html', '/ui.js': 'ui.js', '/style.css': 'style.css' }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (Object.hasOwn(files, path)) {
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
      )
      res.setHeader(
        'content-type',
        { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(files[path])] +
          ';charset=utf-8',
      )
      return res.end(readFileSync(join(staticDir, files[path])))
    }
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''))
    if (supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) {
      res.writeHead(401).end()
      return
    }
    res.setHeader('content-type', 'application/json;charset=utf-8')
    const json = (v) => res.end(JSON.stringify(v))
    if (path === '/api/state' && req.method === 'GET')
      return json({
        config: publicConfig(),
        persona,
        qq: qq.status,
        skills: caps.tools().map((v) => v.function.name),
        groups: store.db
          .prepare('SELECT DISTINCT g FROM messages')
          .all()
          .map((v) => v.g),
        runs: store
          .all('run')
          .slice(0, 80)
          .map((r) => ({
            id: r.id,
            group: r.m.group,
            question: r.m.text,
            state: r.state,
            ticket: r.ticket,
            answer: r.answer,
          })),
        deliveries: store.all('out').slice(0, 50),
        schedules: store.all('schedule'),
      })
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const body = await payload(req)
    if (path === '/api/run') {
      const run = store.get('run', String(body.id))
      if (!run) throw Error('找不到任务')
      return json({
        state: run.state,
        ticket: run.ticket,
        steps: store
          .all('step')
          .filter((s) => s.run === run.id)
          .reverse()
          .map(({ name, result }) => ({
            name,
            provider: result.provider,
            status: result.status,
            sources: result.sources,
            detail: result.detail,
          })),
        answer: run.answer,
      })
    }
    if (path === '/api/config') return json(save(body))
    if (path === '/api/test') {
      const group = '@test',
        id = randomUUID(),
        m = {
          id,
          group,
          parts: [],
          refs: [],
          author: 'admin',
          at: new Date().toISOString(),
          text: body.question || '请分析素材',
        }
      const args = { ...body.args }
      if (body.file) {
        if (!/^(image|video)\//.test(body.file.mime)) throw Error('请选择图片或视频')
        args.resource = caps.save(group, body.file.mime, Buffer.from(body.file.data, 'base64'))
      }
      if (!['analyzeMedia', 'readWebPage', 'searchWeb', 'chat'].includes(body.name))
        throw Error('请选择测试能力')
      if (body.name === 'chat') {
        const { chat, provider } = await import('./network.mjs')
        const p = provider(store.config(), 'chat')
        return json({
          status: 'ok',
          provider: p.model,
          data: (await chat(p, [{ role: 'user', content: m.text }])).content,
        })
      }
      try {
        return json(await caps.run(body.name, args, { config: store.config(), m }))
      } catch (e) {
        const adapter = caps.registry.get(body.name)
        return json({
          status: 'failed',
          capability: body.name,
          provider: store.config().providers[adapter.provider]?.model || adapter.provider,
          detail: e.message,
        })
      }
    }
    if (path === '/api/schedule') {
      if (body.remove) {
        store.del('schedule', String(body.remove))
        return json({ ok: true })
      }
      const next = Date.parse(body.at),
        every = Number(body.every || 0)
      if (
        !body.group ||
        !body.text?.trim() ||
        !(next > Date.now()) ||
        !(every === 0 || (every >= 60000 && Number.isFinite(every)))
      )
        throw Error('请填写群、提醒内容和未来的触发时间')
      const row = { id: randomUUID(), group: body.group, text: body.text, next, every, enabled: true }
      return json(store.put('schedule', row.id, row))
    }
    if (path === '/api/replay') {
      if (store.config().qq.appId) throw Error('回放仅可用于未接入 QQ 的实例，避免向真实群投递')
      const m = app.receive(body.t, body.d || {})
      return json({ received: !!m, id: m?.id })
    }
    res.writeHead(404).end()
  } catch (e) {
    res.statusCode = 400
    res.end(JSON.stringify({ detail: e.message }))
  }
})
const interval = setInterval(() => {
  schedules()
  void app.tick()
  void qq.connect()
  void qq.flush().catch((e) => {
    qq.status = e.message
  })
}, 800)
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () =>
  console.log(
    'QQ Studio listening on ' +
      server.address().port +
      '; admin token: ' +
      (process.env.ADMIN_TOKEN ? 'ADMIN_TOKEN' : tokenFile),
  ),
)
function stop() {
  clearInterval(interval)
  qq.enabled = false
  qq.socket?.close()
  server.close()
  setTimeout(() => process.exit(0), 200).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
