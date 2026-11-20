import {packs,pluginSettings,savePlugins} from './plugins/memes.mjs'
import { MemoryArchive } from './memory.mjs'
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Store, persona } from './store.mjs'
import { Capabilities, Pending } from './capabilities.mjs'
import { GroupRuntime as Runtime } from './group-runtime.mjs'
import { QQ } from './qq.mjs'
import { startGateway, executeHarness } from './harness.mjs'
import { key } from './messages.mjs'
import { publicShareLink } from './articles.mjs'
import { settings, selectedProvider, compatibleEndpoint } from './providers.mjs'
import { classify } from './fast-routing.mjs'
import { chat } from './network.mjs'

const dir = resolve(process.env.STATE_DIR || 'state')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const tokenFile = join(dir, 'admin-token')
if (!process.env.ADMIN_TOKEN && !existsSync(tokenFile))
  writeFileSync(tokenFile, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' })
const token = process.env.ADMIN_TOKEN || readFileSync(tokenFile, 'utf8').trim()
const store = new Store(join(dir, 'bot.sqlite')),
  caps = new Capabilities(store, join(dir, 'assets')),
  app = new Runtime(store, caps),
  archive = new MemoryArchive(store, join(dir, 'memory')),
  qq = new QQ(app)
qq.enabled = true
if (process.env.RUNNER_URL) startGateway(app)
if (store.config().qq.appId) {
  for (const { g } of store.db.prepare('SELECT DISTINCT g FROM messages').all()) qq.warmDirectory(g)
}
function publicConfig() {
  const c = store.config()
  const profile = settings(c)
  c.routes = profile.routes
  c.vendors = profile.vendors
  for (const vendor of Object.values(c.vendors)) vendor.key = vendor.key ? '••••' : ''
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
  const previous = settings(old)
  c.vendors ??= previous.vendors
  if (typeof c.vendors.deepseek?.key !== 'string') throw Error('供应商配置格式不正确')
  if (c.vendors.deepseek.key === '••••') c.vendors.deepseek.key = previous.vendors.deepseek.key
  c.vendors.beeftv ??= previous.vendors.beeftv
  if (typeof c.vendors.beeftv.key !== 'string') throw Error('BeefTV Key 格式错误')
  if (c.vendors.beeftv.key === '••••') c.vendors.beeftv.key = previous.vendors.beeftv.key
  for (const role of ['openai','quick']) {
    const prior = previous.vendors[role]
    const vendor = c.vendors[role] ??= { ...prior }
    if (![vendor.base, vendor.key, vendor.model, vendor.effort].every(v => typeof v === 'string')) throw Error('聊天接口配置格式不正确')
    Object.assign(vendor, compatibleEndpoint(vendor, prior))
    vendor.model = vendor.model.trim()
    if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(vendor.effort)) throw Error('无效的思考强度')
  }
  const jev = c.vendors.jev ??= { ...previous.vendors.jev }
  if (typeof jev.enabled !== 'boolean' || ![jev.base,jev.key,jev.model].every(v=>typeof v === 'string')) throw Error('Jev 配置格式不正确')
  Object.assign(jev, compatibleEndpoint(jev, previous.vendors.jev))
  if (jev.enabled && (!jev.key.trim() || !jev.model.trim() || !c.vendors.quick.model))
    throw Error('启用路由前请先保存简单模型，并填写 Jev 模型和 Key')
  c.routes = {...previous.routes,...c.routes}
  if (Object.values(c.routes).includes('openai') && !c.vendors.openai.model) throw Error('请填写 OpenAI 模型名')
  const vision = selectedProvider(c, 'vision')
  if (c.routes.vision === 'follow' && vision?.kind === 'deepseek' && vision.model !== 'deepseek-flash')
    throw Error('主模型不支持图像输入，请将「图像理解」设为 Flash')
  for (const [role, item] of Object.entries(settings(c).catalog)) {
    if (!item.options.some(([id]) => id === c.routes[role])) throw Error('无效的能力配置：' + item.label)
  }
  if (c.qq.secret === '••••') c.qq.secret = old.qq.secret
  for (const [k, p] of Object.entries(c.providers)) {
    if (p.key === '••••') p.key = old.providers[k]?.key
    if (p.base && !['https:', 'http:'].includes(new URL(p.base).protocol))
      throw Error('供应商地址须为 HTTP(S)')
  }
  for (const g of Object.values(c.groups)) {
    if (!['quiet', 'social', 'rules'].includes(g.mode) || !Array.isArray(g.rules))
      throw Error('群策略格式错误')
    if (g.replyProbability !== undefined &&
        (!Number.isFinite(g.replyProbability) || g.replyProbability < 0 || g.replyProbability > 1))
      throw Error('回复概率须为 0 到 1 的数字')
  }
  store.atomic(()=>{
    store.put('config', 'main', c)
    app.policyUpdated(old,c)
  })
  if (JSON.stringify(old.qq) !== JSON.stringify(c.qq)) qq.reset()
  return publicConfig()
}
function schedules() {
  const now = Date.now()
  for (const t of store.all('schedule'))
    if (t.enabled && t.next <= now)
      store.atomic(() => {
        const id = key(t.id, t.next)
        app.scheduled(t, id)
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
        "default-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
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
        providerCatalog: settings(store.config()).catalog,
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
            question: r.m.text || (r.m.parts || []).filter(p => p.type === 'media' || p.type === 'card').map(p => '[' + (p.mime || p.type) + ']').join(' '),
            state: r.progress?.recovering && r.state === 'running' ? 'recovering' : r.state,
            ticket: r.ticket,
            answer: r.answer,
            fast: r.fast,
          })),
        deliveries: store.all('out').slice(0, 50),
        schedules: store.all('schedule'),
        memories: store
          .all('memoryJob')
          .map(({ group, day, next, count, status, error }) => ({
            group,
            day,
            next,
            count,
            status,
            error,
          })),
      })
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const body = await payload(req)
    if (path === '/api/plugins') {
      const groups = new Set([...Object.keys(store.config().groups), ...store.db.prepare('select distinct g from messages').all().map(x=>x.g)])
      if (!groups.has(body.group)) throw Error('请选择已接入的群')
      const {group, action} = body
      if (action === 'save') savePlugins(store,group,body.settings)
      if (action === 'preview') {
        const item = caps.memes.load().find(x=>x.id===body.id)
        if (!item) throw Error('找不到表情')
        res.setHeader('Content-Type',item.mime)
        return res.end(caps.memes.bytes(item))
      }
      const operations = {login:'check', refresh:'refresh', logout:'logout'}
      const op = Object.hasOwn(operations,action) ? operations[action] : 'status'
      let luckin
      try {
        const response = await fetch(process.env.LUCKIN_BROWSER_URL + '/' + op,{
          method:op==='status'?'GET':'POST',signal:AbortSignal.timeout(23000)})
        luckin = await response.json()
      } catch {luckin={state:'error', detail:'未连接瑞幸专用浏览器'}}
      const library = caps.memes.load()
      const settings = pluginSettings(store,group)
      return json({settings,luckin,packs,counts:Object.fromEntries(Object.keys(packs).map(p=>[p,library.filter(i=>i.pack===p).length])),
        examples:caps.memes.search({...settings,packs:body.previewPack && Object.hasOwn(packs,body.previewPack)?[body.previewPack]:settings.packs},String(body.query||''),[],String(Date.now())).slice(0,5)})
    }
    if (path === '/api/test-routing') {
      const vendors = settings(store.config()).vendors
      const started = Date.now()
      if (body.role === 'quick') {
        if (!vendors.quick.model) throw Error('请先保存简单模型')
        const msg = await chat(vendors.quick,[{role:'user',content:'请只回答 OK'}],undefined,AbortSignal.timeout(12000))
        if (!msg.content?.trim()) throw Error('简单模型未返回正文')
        return json({answer:msg.content.trim().slice(0,200),ms:Date.now()-started})
      }
      if (body.role !== 'jev' || !vendors.jev.key) throw Error('请先保存 Jev 密钥')
      const result = await classify(vendors.jev,{current:{speaker:'成员1',text:'公路车 54 码是什么意思？',attachments:[]},history:[],quotes:[],addressedToBot:true,waiting:false})
      return json({...result,ms:Date.now()-started})
    }
    if (path === '/api/models') {
      const role = body.role === 'quick' ? 'quick' : 'openai'
      const { base, key } = compatibleEndpoint(body, settings(store.config()).vendors[role])
      const response = await fetch(base + '/models', {
        headers: key ? { Authorization: 'Bearer ' + key } : {},
        redirect: 'error', signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) throw Error('模型列表读取失败（HTTP ' + response.status + '）')
      const list = (await response.json()).data
      if (!Array.isArray(list)) throw Error('接口未返回模型列表')
      return json({models:[...new Set(list.map(item => item?.id).filter(id => typeof id === 'string' && id.trim()))].sort()})
    }
    if (path === '/api/run') {
      const run = store.get('run', String(body.id))
      if (!run) throw Error('找不到任务')
      const disposition=store.triggers.disposition(run.trigger || run.id)
      const decision=disposition?.decisionId && store.decisions.get(disposition.decisionId)
      const ticket=run.ticket && store.tickets.get(run.ticket)
      const assignment=ticket?.assignments.find(a=>a.id===run.assignment)
      return json({
        lifecycle:run.flow ? {decision:decision?.kind,subscribed:!!run.subscribed,assignment:assignment?.state,report:assignment?.report?.state,outcome:ticket?.ended?.outcome} : undefined,
        state: run.state,
        progress: run.progress,
        waitReason: run.state === 'running' ? run.waitReason : undefined,
        executor: run.executor || 'legacy',
        fast: run.fast,
        route: run.route,
        ticket: run.ticket,
        steps: store
          .all('step')
          .filter((s) => s.run === run.id)
          .reverse()
          .map(({ name, result }) => ({
            name,
            provider: result.provider,
            status: result.status,
            sources: result.sources?.map(publicShareLink),
            detail: result.detail || result.data?.detail,
            ...(name === 'readWebPage'
              ? {
                  title: result.data?.title,
                  charactersRead: result.data?.text?.length || 0,
                  imagesFound: result.data?.imageCount,
                  videosFound: result.data?.videoCount,
                  analyzed: result.data?.visuals?.map(({ type, position, coverage }) => ({
                    type,
                    position,
                    coverage,
                  })),
                  mediaFailures: result.data?.visualFailures,
                }
              : {}),
          })),
        answer: run.answer,
      })
    }
    if (path === '/api/resume') {
      const prior = store.get('run', String(body.id)),
        request = String(body.question || '').trim()
      if (!prior?.ticket || prior.executor !== 'harness' || !request || !['failed','partial'].includes(prior.state))
        throw Error('需要失败的 Harness Ticket 和续办指令')
      const id = key(prior.id, 'resume', request)
      if (prior.flow) app.resume(prior,request,id)
      else if (!store.get('run', id))
        store.put('run', id, {
          id,
          m: { ...prior.m, text: request },
          ticket: prior.ticket,
          state: 'queued',
          executor: 'harness',
          recovering: true,
          route: {
            action: 'continue',
            thread: prior.m.thread,
            session: prior.route?.session || prior.ticket,
            goal: body.document ? 'document' : 'work',
            requiresFile: !!body.document,
          },
        })
      return json({ id, ticket: prior.ticket })
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
      if (body.name === 'harness') {
        const run = {
          id: key('test', id),
          ticket: key('@test', body.session || id),
          m: { ...m, thread: key('@test', body.session || id) },
          route: {
            requiresFile: typeof body.requiresFile === 'boolean' ? body.requiresFile : undefined,
          },
        }
        if (body.file) {
          const resource = caps.save(group, body.file.mime, Buffer.from(body.file.data, 'base64'))
          m.parts.push({ type: 'media', mime: body.file.mime, resource, source: id })
        }
        if (body.routeAction) {
          const { decideConversation } = await import('./conversation.mjs')
          run.route = await decideConversation(app, run)
          if (!['new', 'continue'].includes(run.route.action) || run.route.productTool)
            throw Error('请求未进入行动工作区')
        }
        let result
        for (;;) {
          try {
            result = await executeHarness(app, run, caps.reference(run.m))
            break
          } catch (e) {
            if (!(e instanceof Pending)) throw e
            await new Promise((ok) => setTimeout(ok, 1500))
          }
        }
        return json({
          status: result.partial ? 'partial' : 'ok',
          route: run.route,
          session: body.session || id,
          answer: result.text,
          artifact: result.artifact,
          artifacts: result.artifacts,
          execution: store.get('step', key(run.id, 'harness'))?.result,
        })
      }
      if (body.file) {
        if (
          !/^(image|video)\//.test(body.file.mime) &&
          !(body.name === 'editAudio' && /^audio\//.test(body.file.mime)) &&
          !(body.name === 'recognizeText' && body.file.mime === 'application/pdf')
        )
          throw Error('不支持的测试文件类型')
        args.resource = caps.save(group, body.file.mime, Buffer.from(body.file.data, 'base64'))
      }
      if (
        ![
          'analyzeMedia',
          'readWebPage',
          'searchWeb',
          'recognizeText',
          'synthesizeSpeech',
          'generateMusic',
          'editAudio',
          'resolveAudioSource',
          'chat',
          'worker',
        ].includes(body.name)
      )
        throw Error('请选择测试能力')
      if (body.name === 'chat' || body.name === 'worker') {
        const { chat, provider } = await import('./network.mjs')
        const p = provider(store.config(), body.name)
        return json({
          status: 'ok',
          provider: p.model,
          data: (await chat(p, [{ role: 'user', content: m.text }])).content,
        })
      }
      try {
        const result = await caps.run(body.name, args, { config: store.config(), m, adminTest: true })
        if (['synthesizeSpeech','generateMusic','editAudio'].includes(body.name) && result.data?.artifact) {
          const file = await caps.file(group, result.data.artifact)
          result.audio = file.bytes.toString('base64')
          result.audioMime = file.mime
        }
        return json(result)
      } catch (e) {
        const adapter = caps.registry.get(body.name)
        return json({
          status: 'failed',
          capability: body.name,
          provider: selectedProvider(store.config(), adapter.provider)?.base || adapter.provider,
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
app.archive = job => archive.archive(job)
const archiveTick = () => void archive.tick(Date.now(),job=>app.archiveDue(job)).catch((e) => console.error('群记忆调度失败', e.message))
archiveTick()
const archiveTimer = setInterval(archiveTick, 15000)
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
  clearInterval(archiveTimer)
  qq.enabled = false
  qq.socket?.close()
  server.close()
  setTimeout(() => process.exit(0), 200).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
