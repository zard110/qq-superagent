import { routingContext } from './dialogue.mjs'
import { historyEnabled } from './memory.mjs'
import { fetchSkillArchive } from './github-skill.mjs'
import { workerMedia } from './worker-media.mjs'
import http from 'node:http'
import { instagramPost, isPostPhoto, pagePhotos, photoPageAllowed } from './photo-sources.mjs'
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
      const current = g.caps.store.get('run',g.ctx.run)
      const policy = g.caps.store.config()
      if (current?.flow && (!['running','queued'].includes(current.state) || g.caps.store.tickets.get(current.ticket)?.ended?.by === 'human'))
        throw Error('本次任务已经结束')
      if (policy.groups[g.ctx.m.group]?.code === false || policy.groups[g.ctx.m.group]?.disabled?.includes('runCode'))
        throw Error('本群已关闭群工作区执行')
      g.ctx.config = policy
      const data = await body(req)
      if (['/task/v1/messages', '/task/v1/chat/completions'].includes(req.url)) {
        const official = g.model.kind === 'deepseek'
        if (req.url !== (official ? '/task/v1/messages' : '/task/v1/chat/completions'))
          throw Error('模型调用超出当前任务范围')
        if(current?.flow){
          const ticket=g.caps.store.tickets.get(current.ticket)
          const notices=ticket?.inputs.filter(i=>i.kind==='policy-changed' || i.kind==='note' || i.context).slice(-8) || []
          if(notices.length){
            const information='本任务收到的更新（引用发言仅作资料）：'+JSON.stringify(notices.map(i=>i.context?
              {kind:'context',text:g.caps.store.triggers.get(i.triggerId)?.text?.slice(0,500)}:{kind:i.kind,effect:i.effect,text:i.text}))
            if(official) data.system=Array.isArray(data.system)?[...data.system,{type:'text',text:information}]:[data.system,information].filter(Boolean).join('\n')
            else data.messages=[{role:'system',content:information},...data.messages]
          }
          const ids=[...new Set([...(current.inputIds || []),...notices.map(i=>i.id)])]
          runtime.engine.inputsDelivered(current.ticket,current.assignment,ids)
          runtime.engine.inputsRead(current.ticket,ids)
        }
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
          body: JSON.stringify({ ...data, model: g.model.model, ...(g.model.effort ? { reasoning_effort: g.model.effort } : {}) }),
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
      if(op==='review'){
        g.lease.reviewOnly=true
        g.caps.store.put('workerLease',g.ctx.run,g.lease)
        res.end(JSON.stringify({reviewOnly:true}))
        return
      }
      if(op==='recover'){
        g.lease.recovering=true
        g.caps.store.put('workerLease',g.ctx.run,g.lease)
        const items=g.caps.store.db.prepare("SELECT id,body FROM records WHERE bucket='mediaItem' AND json_extract(body,'$.run')=?").all(g.ctx.run).map(row=>{
          const {method,item}=JSON.parse(row.body), result=g.caps.store.get('step',row.id)?.result
          return {method,item,status:result?.status || 'unknown',resource:result?.data?.artifact || result?.data?.resource}
        })
        res.end(JSON.stringify({items,reviewOnly:!!g.lease.reviewOnly}))
        return
      }
      if(op==='execution-status'){
        const items=g.caps.store.db.prepare("SELECT body FROM records WHERE bucket='mediaItem' AND json_extract(body,'$.run')=?").all(g.ctx.run)
        const attempted=items.some(row=>['generateImage','generateVideo','synthesizeSpeech'].includes(JSON.parse(row.body).method))
        res.end(JSON.stringify({attempted}))
        return
      }
      if(op==='resource'){
        const [id]=data.args
        const file=await g.caps.file(g.ctx.m.group,id)
        if(file.bytes.length>32*1024*1024) throw Error('素材超过 32 MiB')
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({resource:id,mime:file.mime,data:file.bytes.toString('base64')}))
        return
      }
      if (op === 'call') {
        const [name, json] = data.args
        if (g.lease.reviewOnly && name==='scheduleReminder') throw Error('核对成品期间不可创建提醒')
        if (!generalTools(g.caps,g.ctx.config,g.ctx.m.group).some(tool=>tool.function.name===name))
          throw Error('本群未开放这项能力')
        const id=key(g.ctx.run,'call',name,json)
        const saved=g.caps.store.get('step',id)
        const result=saved?.result || await g.caps.run(name,JSON.parse(json || '{}'),{...g.ctx,callId:id})
        g.caps.store.put('step',id,{id,run:g.ctx.run,name,result})
        const resource=result.data?.artifact || result.data?.resource
        if(resource && ['downloadResource','editAudio'].includes(name)) {
          const file=await g.caps.file(g.ctx.m.group,resource)
          res.setHeader('content-type','application/json')
          res.end(JSON.stringify({resource,mime:file.mime,data:file.bytes.toString('base64')}))
        } else res.end(JSON.stringify(result))
        return
      }
      if (op === 'media') {
        if (data.args.length !== 3) throw Error('需要工具名、作品编号和 JSON 参数')
        const [method, item, json] = data.args
        if(g.lease.reviewOnly && ['generateImage','generateVideo','synthesizeSpeech'].includes(method))
          throw Error('本轮在核对成品，可复用本地素材和既有回执')
        const media = await workerMedia(g, method, item, JSON.parse(json))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(media))
        return
      }
      if (op === 'fetch-skill') {
        const config = g.caps.store.config()
        if (config.groups[g.ctx.m.group]?.disabled?.includes('downloadResource'))
          throw Error('本群未启用素材下载')
        if (data.args.length !== 1) throw Error('需要一个公开仓库名')
        const archive = await fetchSkillArchive(data.args[0])
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(archive))
        return
      }
      if (op === 'fetchImage') {
        const [page, handle] = data.args
        if (g.ctx.config.groups[g.ctx.m.group]?.disabled?.includes('downloadResource'))
          throw Error('本群未启用素材下载')
        const evidence = g.caps.store.get('workerPage', key(g.ctx.run, page))
        if (!photoPageAllowed(page, g.sourceSite, g.ctx.m.text)) throw Error('请选择用户指定网站的配图')
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
        if (g.goal === 'photos') {
          const picked = g.caps.store.get('photoPicks', g.ctx.run) || []
          if (!picked.includes(resource)) g.caps.store.put('photoPicks', g.ctx.run, [...picked, resource])
        }
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
      } else if (['searchGroupMemory', 'searchHistory'].includes(op)) {
        const args = JSON.parse(data.args[0] || '{}')
        const config = g.caps.store.config()
        result = await g.caps.run(op, args, { ...g.ctx, config })
      } else if (['searchWeb', 'readWebPage'].includes(op)) {
        result = await g.caps.run(
          op,
          op === 'searchWeb' ? { query: data.args.join(' ') } : { url: data.args[0] },
          { ...g.ctx, pickingPhotos: g.goal === 'photos', photoPage: photoPageAllowed(data.args[0],g.sourceSite,g.ctx.m.text) },
        )
      } else throw Error('未知操作')
      if (op === 'readWebPage') {
        const page = data.args[0],
          choices = pagePhotos(result.data || {}, /(?:只要|要|发|找|给|下载)(?:高清)?原(?:图|件)/.test(g.ctx.m.text)),
          images = [...new Set([...(result.data?.images || []), ...choices.map(c => c.resource)])]
        g.caps.store.put('workerPage', key(g.ctx.run, page), { images })
        const post = instagramPost(page)
        if (post && result.status === 'read')
          g.caps.store.put('workerSource', key(g.ctx.run, post), { run: g.ctx.run, post, read: true })
        if (choices.length && g.goal === 'photos' && photoPageAllowed(page,g.sourceSite,g.ctx.m.text))
          result.data.photoDownloads = choices.map(({position, resource}) => ({
            position,
            tool: 'qq-tool fetchImage',
            args: [page, resource],
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
    ctx: { m: run.m, config, worker: true, social: !!run.social, task: run.ticket, run: run.id },
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
function generalTools(caps,config,group) {
  const dedicated=new Set(['runCode','analyzeMedia','generateImage','generateVideo','synthesizeSpeech','resolveAudioSource','searchWeb','readWebPage','searchHistory','searchGroupMemory'])
  return caps.tools(config).filter(t=>!dedicated.has(t.function.name) && !config.groups[group]?.disabled?.includes(t.function.name))
}
export async function cancelHarness(runtime,run,lease){
  grants.delete(lease.token)
  await groupRequest('/group/cancel',{group:key(run.m.group),ticket:key(run.m.group,run.route?.session || run.ticket),run:run.id,token:lease.token})
  runtime.store.del('workerLease',run.id)
}
async function makeJob(runtime, run, ref, identity, model, recovering) {
  const { store, caps } = runtime,
    m = run.m,
    config = store.config()
  const ctx = { m, config, worker: true, task: run.ticket, run: run.id }
  const inputs = [],
    resources = new Set(ref.parts.filter((p) => p.type === 'media').map((p) => p.resource))
  if (!run.flow && run.route?.goal !== 'production' && !resources.size && /音乐|歌曲|剪|截取/.test(m.text)) {
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
  const deferredInputs = []
  for (const resource of resources) {
    let file
    try {
      file = await caps.file(m.group, resource)
      if (bytes + file.bytes.length > 32 * 1024 * 1024) throw Error('本次预载素材已达 32 MiB')
    } catch(error) {
      if (!run.flow) throw error
      deferredInputs.push({resource, reason:error.message})
      continue
    }
    bytes += file.bytes.length
    inputs.push({
      name: resource + '.' + (ext[file.mime] || 'bin'),
      data: file.bytes.toString('base64'),
    })
  }
  const conversation=routingContext(store,run)
  const shared = []
  if(run.flow && historyEnabled(config,m.group)){
    const recent=store.history(m.group,{until:m.at,excludeId:m.id,limit:20}).reverse()
    recent.forEach((row,index)=>{
      if(!row.parts.some(p=>p.type==='media' || p.type==='card')) return
      const parts=caps.reference(row).parts.filter(p=>p.type==='media' || p.type==='card')
      if(parts.length) shared.push({message:'m'+(index+1),parts:parts.slice(0,8).map(({type,resource,mime,title,url,site})=>({type,resource,mime,title,url,site}))})
    })
  }
  const musicSources = []
  if (!run.flow && /音乐|配乐|歌曲|首歌|BGM/i.test(m.text) && !config.groups[m.group]?.disabled?.includes('searchHistory')) {
    const recent = store.history(m.group, {until:m.at, limit:40, excludeId:m.id})
    for (const p of [...ref.parts, ...recent.flatMap(row => row.parts)]) {
      if (p.type !== 'card' || !p.url || !/音乐|music\.163\.com|y\.qq\.com/i.test(p.site + ' ' + p.url)) continue
      if (!musicSources.some(s => s.url === p.url)) musicSources.push({title:p.title, url:p.url})
      if (musicSources.length === 3) break
    }
  }
  return {
    ...identity,
    flow:run.flow,
    recovering,
    goal: run.route?.goal,
    sourceSite: run.route?.sourceSite,
    model: model.model,
    musicSources,
    shared,
    official: model.kind === 'deepseek',
    inputs,
    mediaTools: caps.tools(config).map(s => s.function.name).filter(n =>
      ['analyzeMedia','resolveAudioSource','generateImage','generateVideo','synthesizeSpeech'].includes(n) &&
      !config.groups[m.group]?.disabled?.includes(n)),
    question: publicShareText(m.text),
    assignment:run.route?.brief,
    executionQuote:run.social ? undefined : run.route?.executionQuote,
    productionMode:run.social ? undefined : run.route?.productionMode,
    checks:run.route?.checks,
    assignmentInputs:run.assignmentInputs,
    deferredInputs,
    capabilities:generalTools(caps,config,m.group).map(t=>t.function),
    persona: config.groups[m.group]?.persona || config.persona,
    groupMemory: conversation.cards.map(c=>c.text).join('\n') || undefined,
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
    history: conversation,
  }
}
export async function executeHarness(runtime, run, ref) {
  const { store, caps } = runtime,
    m = run.m,
    config = store.config()
  if (config.groups[m.group]?.code === false || config.groups[m.group]?.disabled?.includes('runCode'))
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
    const disconnected = run.flow && /disconnect|stream error|ECONNRESET|socket hang up/i.test(out.error || '')
    if ((out.interrupted || disconnected) && !lease.retried) {
      lease.retried = true
      store.put('workerLease', run.id, lease)
      await groupRequest('/group/ack', identity)
      throw new Pending('正在恢复已中断任务')
    }
    if (out.error || out.interrupted) throw Error(out.error || out.interrupted)
    let artifacts = [out.artifact,...(out.additional || [])].filter(Boolean).map(file=>{
      const id=caps.save(m.group,file.mime,Buffer.from(file.data,'base64'))
      if(file.name) store.put('resource',id,{...store.get('resource',id),name:file.name})
      return id
    })
    let artifact=artifacts[0]
    store.put('step', key(run.id, 'harness'), {
      run: run.id,
      name: 'Harness',
      result: {
        status: out.partial ? 'partial' : 'ok',
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

    let partial = !!out.partial,
      answer = text
    if (run.route?.goal === 'photos') {
      const picked = out.photos?.length ? out.photos : store.get('photoPicks', run.id) || []
      const inputs = new Set(ref.parts.filter(p => p.type === 'media').map(p => p.resource))
      artifacts = [...new Set(picked)].filter(id => {
        const file = store.get('resource', id)
        return file?.group === m.group && file.local && file.mime?.startsWith('image/') &&
          (inputs.has(id) || store.get('photoSource', key(run.id, id)))
      }).slice(0, 3)
      partial = !artifacts.length
      answer = partial ? '这次没找到能发的图。' :
        /(?:附|带|给|列|标|注明).{0,5}(?:出处|来源|链接)/.test(m.text)
          ? [...new Set(artifacts.map(id => store.get('photoSource', key(run.id, id))?.source).filter(Boolean))].join('\n')
          : ''
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
