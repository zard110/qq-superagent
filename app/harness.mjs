import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { key } from './messages.mjs'
import { publicAddress, provider } from './network.mjs'
import { publicShareText } from './articles.mjs'
import { Pending } from './capabilities.mjs'
const grants = new Map()
const runner = () => process.env.RUNNER_URL || 'http://runner:8090'
const registries = new Set([
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'deb.debian.org',
])
async function body(req) {
  let n = 0
  const chunks = []
  for await (const b of req) {
    n += b.length
    if (n > 12e6) throw Error('请求过大')
    chunks.push(b)
  }
  return JSON.parse(Buffer.concat(chunks))
}
export function startGateway() {
  const server = http.createServer(async (req, res) => {
    try {
      const token = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(
        /^Bearer /i,
        '',
      )
      const g = grants.get(token)
      if (!g || req.method !== 'POST') {
        res.writeHead(403).end()
        return
      }
      const data = await body(req)
      if (['/task/v1/messages', '/task/v1/chat/completions'].includes(req.url)) {
        const official = g.model.kind === 'deepseek'
        if (++g.calls > 36 || req.url !== (official ? '/task/v1/messages' : '/task/v1/chat/completions'))
          throw Error('模型调用超出当前任务范围')
        const url =
          g.model.base.replace(/\/$/, '') + (official ? '/anthropic/v1/messages' : '/chat/completions')
        const headers = {
          'content-type': 'application/json',
          ...(official
            ? { 'x-api-key': g.model.key, 'anthropic-version': '2023-06-01' }
            : g.model.key
              ? { authorization: 'Bearer ' + g.model.key }
              : {}),
        }
        const r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...data, model: g.model.model }),
          redirect: 'error',
          signal: AbortSignal.timeout(120000),
        })
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' })
        if (r.body) await pipeline(Readable.fromWeb(r.body), res)
        else res.end()
        return
      }
      const op = req.url.startsWith('/task/') ? req.url.slice(6) : ''
      if (!Array.isArray(data.args) || data.args.some((a) => typeof a !== 'string'))
        throw Error('参数无效')
      let result
      if (op === 'install-deb') {
        const r = await fetch(runner() + '/install-deb', {
          method: 'POST',
          body: JSON.stringify({ token, group: g.group, packages: data.args }),
          signal: AbortSignal.timeout(250000),
        })
        result = await r.json()
        if (!r.ok) throw Error(result.error || '安装失败')
      } else if (['searchWeb', 'readWebPage'].includes(op)) {
        result = await g.caps.run(
          op,
          op === 'searchWeb' ? { query: data.args.join(' ') } : { url: data.args[0] },
          g.ctx,
        )
      } else throw Error('未知操作')
      const id = key(g.ctx.run, op, JSON.stringify(data.args))
      g.caps.store.put('step', id, {
        id,
        run: g.ctx.run,
        name: op,
        result: {
          status: 'ok',
          provider: op === 'install-deb' ? 'Debian' : result.provider,
          detail: op === 'install-deb' ? data.args.join(', ') : result.detail,
          sources: result.sources || [],
        },
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (e) {
      if (!res.headersSent) res.writeHead(422)
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => {})
    try {
      const [host, port] = req.url.split(':')
      if (port !== '443' || !registries.has(host)) throw Error()
      const ip = await publicAddress(host)
      const origin = net.connect(443, ip.address, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) origin.write(head)
        socket.pipe(origin).pipe(socket)
      })
      origin.setTimeout(120000, () => origin.destroy())
      origin.on('error', () => socket.destroy())
      socket.on('close', () => origin.destroy())
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
  })
  return server.listen(8790)
}
const ext = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
}
// Node fetch limits the wait for response headers to five minutes. A group turn may take eight.
function groupRequest(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(runner().replace(/\/$/, '') + '/group')
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', signal: AbortSignal.timeout(495000) },
      (res) => {
        let size = 0
        const chunks = []
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > 36e6) res.destroy(Error('沙箱结果过大'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(payload))
  })
}
export async function executeHarness(runtime, run, ref) {
  const { store, caps } = runtime,
    m = run.m,
    config = store.config()
  if (
    run.social ||
    config.groups[m.group]?.code === false ||
    config.groups[m.group]?.disabled?.includes('runCode')
  )
    throw Error('本群未开启通用任务执行')
  const ctx = { m, config, worker: true, task: run.ticket, run: run.id }
  const inputs = [],
    resources = new Set(ref.parts.filter((p) => p.type === 'media').map((p) => p.resource))
  const history = store.db
    .prepare(
      "SELECT body FROM records WHERE bucket='run' AND id!=? AND json_extract(body,'$.m.group')=? AND json_extract(body,'$.m.thread')=? ORDER BY rowid DESC LIMIT 6",
    )
    .all(run.id, m.group, m.thread)
    .map((row) => JSON.parse(row.body))
  if (!resources.size && /音乐|歌曲|剪|截取/.test(m.text)) {
    const song = ref.parts.find(
      (p) => p.type === 'card' && p.url && /音乐|music\.163\.com/.test(p.site + ' ' + p.url),
    )
    if (song) {
      const id = key(run.id, 'harness-audio'),
        saved = store.get('step', id)
      const result = saved?.result || (await caps.run('resolveAudioSource', { url: song.url }, ctx))
      store.put('step', id, { id, run: run.id, name: 'resolveAudioSource', result })
      resources.add(result.data.resource)
    }
  }
  let bytes = 0
  for (const resource of resources) {
    const file = await caps.file(m.group, resource)
    bytes += file.bytes.length
    if (bytes > 32 * 1024 * 1024) throw Error('任务输入超过 32 MiB')
    inputs.push({
      name: resource + '.' + (ext[file.mime] || 'bin'),
      data: file.bytes.toString('base64'),
    })
  }
  const group = key(m.group),
    model = provider(config, 'worker'),
    token = randomBytes(32).toString('hex')
  const session = key(m.group, run.route?.session || run.ticket)
  grants.set(token, { group, model, caps, ctx, calls: 0 })
  try {
    const r = await groupRequest({
      group,
      ticket: session,
      run: run.id,
      token,
      model: model.model,
      official: model.kind === 'deepseek',
      inputs,
      question: publicShareText(m.text),
      persona: config.groups[m.group]?.persona || config.persona,
      sender: { name: m.nickname || store.member(m.group, m.author)?.name, role: m.role },
      mentions: (m.mentions || []).map((u) => ({ name: u.name, bot: u.self || u.bot })),
      references: ref.parts
        .filter((p) => ['text', 'card'].includes(p.type))
        .slice(0, 20)
        .map((p) => ({
          type: p.type,
          title: p.title,
          site: p.site,
          url: p.url,
          summary: p.summary,
          text: p.text?.slice(0, 1000),
        })),
      requiresFile: run.route?.requiresFile,
      history: history
        .map((v) => [
          publicShareText(v.m.text)?.slice(0, 1200),
          publicShareText(v.answer)?.slice(0, 1500),
        ])
        .reverse(),
    })
    if (r.status === 429) throw new Pending('等待群工作区')
    const out = r.body
    if (r.status !== 200 || out.error) throw Error(out.error || 'Harness 执行失败')
    let artifact
    if (out.artifact)
      artifact = caps.save(m.group, out.artifact.mime, Buffer.from(out.artifact.data, 'base64'))
    store.put('step', key(run.id, 'harness'), {
      run: run.id,
      name: 'Harness',
      result: {
        status: 'ok',
        provider: model.model,
        detail: (out.steps || []).join(', '),
        sources: [out.session],
        data: { artifact },
      },
    })
    const text = String(out.text || '').replace(
      /\[([^\]]+)\]\((?:sandbox:|file:|\/?work\/|\.?\/?outputs\/)[^)]+\)/gi,
      '$1',
    )
    return { text, artifact }
  } catch (e) {
    if (!(e instanceof Pending))
      store.put('step', key(run.id, 'harness-error'), {
        run: run.id,
        name: 'Harness',
        result: { status: 'failed', provider: model.model, sources: [], detail: e.message },
      })
    throw e
  } finally {
    grants.delete(token)
  }
}
