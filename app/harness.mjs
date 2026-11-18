import http from 'node:http'
import { instagramPost, isPostPhoto } from './photo-sources.mjs'
import net from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { key } from './messages.mjs'
import { publicAddress, provider } from './network.mjs'
import { publicShareText } from './articles.mjs'
import { Pending } from './capabilities.mjs'
const grants = new Map()
const gatewayInstance = randomBytes(16).toString('hex')
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
export function startGateway(runtime, port = 8790) {
  // Rebind still queued/running requests before the scheduler starts polling.
  for (const lease of runtime.store.all('workerLease')) {
    const run = runtime.store.get('run', lease.run)
    if (!run || !['running', 'queued'].includes(run.state)) {
      runtime.store.del('workerLease', lease.run)
      continue
    }
    try {
      grant(runtime, run, lease)
    } catch {
      /* The scheduler records current configuration errors when it polls. */
    }
  }
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
        if (req.url !== (official ? '/task/v1/messages' : '/task/v1/chat/completions'))
          throw Error('模型调用超出当前任务范围')
        g.lease.calls++
        g.caps.store.put('workerLease', g.ctx.run, g.lease)
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
      if (op === 'fetchImage') {
        const [page, handle] = data.args
        if (g.ctx.config.groups[g.ctx.m.group]?.disabled?.includes('downloadResource'))
          throw Error('本群未启用素材下载')
        const evidence = g.caps.store.get('workerPage', key(g.ctx.run, page))
        if (g.sourceSite === 'instagram.com' && !instagramPost(page))
          throw Error('需要 Instagram 原帖链接')
        let file
        if (evidence?.images?.includes(handle)) file = await g.caps.file(g.ctx.m.group, handle)
        else if (
          isPostPhoto(page, handle) &&
          g.caps.store.get('workerSource', key(g.ctx.run, instagramPost(page)))
        )
          file = await g.caps.download(handle, 16 * 1024 * 1024)
        else throw Error('图片须来自本轮读取页面的图片句柄或已检索到的同一原帖媒体地址')
        if (!/^image\/(jpeg|png|webp)$/.test(file.mime) || file.bytes.length > 16 * 1024 * 1024)
          throw Error('未取得支持的原图')
        const resource = g.caps.save(g.ctx.m.group, file.mime, file.bytes)
        const source = instagramPost(page) || page
        g.caps.store.put('photoSource', key(g.ctx.run, resource), { resource, run: g.ctx.run, source })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({ resource, source, mime: file.mime, data: file.bytes.toString('base64') }),
        )
        return
      }
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
      if (op === 'readWebPage') {
        const page = data.args[0],
          images = result.data?.images || []
        g.caps.store.put('workerPage', key(g.ctx.run, page), { images })
        const post = instagramPost(page)
        if (post && result.status === 'read')
          g.caps.store.put('workerSource', key(g.ctx.run, post), { run: g.ctx.run, post, read: true })
        if (images.length && g.goal === 'photos')
          result.data.photoDownloads = images.map((id) => ({
            tool: 'qq-tool fetchImage',
            args: [page, id],
          }))
      }
      for (const url of result.sources || []) {
        const post = instagramPost(url)
        if (post && !g.caps.store.get('workerSource', key(g.ctx.run, post)))
          g.caps.store.put('workerSource', key(g.ctx.run, post), { run: g.ctx.run, post })
      }
      const id = key(g.ctx.run, op, JSON.stringify(data.args))
      g.caps.store.put('step', id, {
        id,
        run: g.ctx.run,
        name: op,
        result: {
          status: result.status || 'ok',
          provider: op === 'install-deb' ? 'Debian' : result.provider,
          detail: op === 'install-deb' ? data.args.join(', ') : result.detail,
          ...(op === 'readWebPage' && {
            data: {
              title: result.data?.title,
              imageCount: result.data?.imageCount,
              videoCount: result.data?.videoCount,
              visuals: result.data?.visuals?.map(({ type, position, coverage }) => ({
                type,
                position,
                coverage,
              })),
              visualFailures: result.data?.visualFailures,
            },
          }),
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
  return server.listen(port)
}
const ext = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
}
function grant(runtime, run, lease) {
  const config = runtime.store.config(),
    model = provider(config, 'worker')
  const g = {
    group: key(run.m.group),
    model,
    lease,
    caps: runtime.caps,
    sourceSite: run.route?.sourceSite,
    goal: run.route?.goal,
    ctx: { m: run.m, config, worker: true, task: run.ticket, run: run.id },
  }
  grants.set(lease.token, g)
  return g
}
async function groupRequest(path, payload) {
  let response
  try {
    response = await fetch(runner() + path, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    throw new Pending('等待 Runner 连接恢复')
  }
  if (response.status === 429) throw new Pending('等待群工作区')
  const out = await response.json()
  if (response.status >= 500) throw new Pending('等待 Runner 恢复')
  if (!response.ok) throw Error(out.error || 'Runner 请求失败')
  return out
}
async function makeJob(runtime, run, ref, identity, model, recovering) {
  const { store, caps } = runtime,
    m = run.m,
    config = store.config()
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
  return {
    ...identity,
    recovering,
    goal: run.route?.goal,
    sourceSite: run.route?.sourceSite,
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
      .map((v) => [publicShareText(v.m.text)?.slice(0, 1200), publicShareText(v.answer)?.slice(0, 1500)])
      .reverse(),
  }
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
  const saved = store.get('harnessResult', run.id)
  if (saved) return saved
  const lease =
    store.get('workerLease', run.id) ||
    store.put('workerLease', run.id, { run: run.id, token: randomBytes(32).toString('hex'), calls: 0 })
  const { model } = grant(runtime, run, lease)
  const identity = {
    gateway: gatewayInstance,
    group: key(m.group),
    ticket: key(m.group, run.route?.session || run.ticket),
    run: run.id,
    token: lease.token,
  }
  let terminal = false
  try {
    let status = await groupRequest('/group/status', identity)
    if (status.state === 'missing') {
      const recovering = !!lease.submitted
      status = await groupRequest(
        '/group',
        await makeJob(runtime, run, ref, identity, model, recovering),
      )
      lease.submitted = true
      store.put('workerLease', run.id, lease)
      if (recovering) run.recovering = true
    }
    if (status.state === 'running') {
      run.progress = { ...status.progress, calls: lease.calls, recovering: !!run.recovering }
      throw new Pending('后台执行中')
    }
    if (status.state !== 'finished') throw Error('Runner 返回了未知状态')
    const out = status.result
    if (out.interrupted && !lease.retried) {
      lease.retried = true
      store.put('workerLease', run.id, lease)
      await groupRequest('/group/ack', identity)
      throw new Pending('正在恢复已中断任务')
    }
    if (out.error || out.interrupted) throw Error(out.error || out.interrupted)
    let artifact
    if (out.artifact) {
      artifact = caps.save(m.group, out.artifact.mime, Buffer.from(out.artifact.data, 'base64'))
      if (out.artifact.name)
        store.put('resource', artifact, { ...store.get('resource', artifact), name: out.artifact.name })
    }
    store.put('step', key(run.id, 'harness'), {
      run: run.id,
      name: 'Harness',
      result: {
        status: 'ok',
        provider: model.model,
        detail: lease.calls + ' 次模型调用 · ' + (out.steps || []).join(', '),
        sources: [out.session],
        data: { artifact },
      },
    })
    const text = String(out.text || '').replace(
      /\[([^\]]+)\]\((?:sandbox:|file:|\/?work\/|\.?\/?outputs\/)[^)]+\)/gi,
      '$1',
    )
    let artifacts = artifact ? [artifact] : []
    let partial = false,
      answer = text
    if (run.route?.goal === 'photos') {
      const verified = (out.photos || [])
        .map((id) => store.get('photoSource', key(run.id, id)))
        .filter(Boolean)
      artifacts = [...new Set(verified.map((v) => v.resource))].slice(0, 3)
      partial = !artifacts.length
      answer = partial ? '本次没有取得可核验、可发送的原图。' : text
      const links = partial
        ? store
            .all('workerSource')
            .filter((v) => v.run === run.id && v.read)
            .map((v) => v.post)
        : verified.map((v) => v.source)
      const cited = new Set(
        (answer.match(/https?:\/\/[^\s)）>]+/g) || []).map((v) => instagramPost(v) || v),
      )
      const extra = [...new Set(links)].filter((v) => !cited.has(v)).slice(0, 3)
      if (extra.length) answer += '\n' + extra.join('\n')
      artifact = artifacts[0]
    }
    const result = { text: answer, artifact, artifacts, partial }
    store.put('harnessResult', run.id, result)
    terminal = true
    return result
  } catch (e) {
    if (!(e instanceof Pending)) {
      terminal = true
      store.put('step', key(run.id, 'harness-error'), {
        run: run.id,
        name: 'Harness',
        result: { status: 'failed', provider: model.model, sources: [], detail: e.message },
      })
    }
    throw e
  } finally {
    if (terminal) {
      grants.delete(lease.token)
      store.del('workerLease', run.id)
      void groupRequest('/group/ack', identity).catch(() => {})
    }
  }
}
