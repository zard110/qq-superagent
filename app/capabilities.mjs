import { key, resolve } from './messages.mjs'
import { provider, auth, remote, readPage, publicFile, chat } from './network.mjs'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const str = { type: 'string' }
const definitions = {
  resolveReference: ['读取当前消息引用的文本、卡片与媒体句柄', {}],
  searchHistory: [
    '检索本群留存的原始消息。按关键词、成员 ID、起止 ISO 时间筛选',
    { keyword: str, author: str, from: str, until: str },
  ],
  analyzeMedia: ['分析指定图片或视频；回答具体问题，视频引用时间码', { resource: str, question: str }],
  readWebPage: ['读取引用卡片、普通网址或搜索结果的网页正文', { url: str }],
  searchWeb: [
    '搜索公开网页以查证事实，query 只含公开关键词，可选站点和时间范围',
    { query: str, domain: str, timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'] } },
  ],
  generateImage: ['生成图片或根据指定参考素材改图，仅在用户要求创作时调用', { prompt: str, resource: str }],
  scheduleReminder: [
    '按群管理员的明确请求创建提醒，at 使用含时区的未来 ISO 时间，interval 为 once/daily/weekly',
    { text: str, at: str, interval: { type: 'string', enum: ['once', 'daily', 'weekly'] } },
  ],
  runCode: ['在一次性沙箱中运行 Python 数据处理程序，返回 stdout', { code: str }],
}
export const toolSpecs = Object.entries(definitions).map(([name, [description, properties]]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      additionalProperties: false,
      required:
        {
          analyzeMedia: ['resource', 'question'],
          readWebPage: ['url'],
          searchWeb: ['query'],
          generateImage: ['prompt'],
          runCode: ['code'],
          scheduleReminder: ['text', 'at'],
        }[name] || [],
    },
  },
}))
const expected = {
  analyzeMedia: 'vision',
  readWebPage: 'HTTP',
  searchWeb: 'search',
  generateImage: 'image',
  runCode: 'Docker',
  resolveReference: 'QQ',
  searchHistory: 'SQLite',
}
export class Pending extends Error {}
export class Capabilities {
  constructor(store, dir) {
    this.store = store
    this.dir = dir
    this.registry = new Map()
    this.download = publicFile
    mkdirSync(dir, { recursive: true })
    for (const spec of toolSpecs) {
      const name = spec.function.name
      this.register({
        spec,
        provider: expected[name] || 'scheduler',
        output: {
          resolveReference: '引用片段与缺失索引',
          searchHistory: '带来源与时间的消息列表',
          readWebPage: '正文或受限原因',
          searchWeb: '候选来源列表',
          analyzeMedia: '发现与读取范围',
          generateImage: '群内产物句柄',
          scheduleReminder: '触发计划',
          runCode: '退出状态与标准输出',
        }[name],
        media: name === 'analyzeMedia' ? ['image/*', 'video/*'] : name === 'generateImage' ? ['image/*'] : [],
        execute: (args, ctx) => this.builtin(name, args, ctx),
      })
    }
  }
  register(adapter) {
    this.registry.set(adapter.spec.function.name, adapter)
  }
  tools() {
    return [...this.registry.values()].map((a) => a.spec)
  }
  async run(name, args, ctx) {
    const adapter = this.registry.get(name)
    if (!adapter) throw Error('未知能力')
    if (ctx.config.groups?.[ctx.m.group]?.disabled?.includes(name)) throw Error('管理员已在本群关闭此能力')
    return adapter.execute(args, ctx)
  }
  save(group, mime, bytes) {
    const id = key(group, bytes.toString('base64'))
    if (!existsSync(join(this.dir, id))) {
      writeFileSync(join(this.dir, id + '.tmp'), bytes)
      renameSync(join(this.dir, id + '.tmp'), join(this.dir, id))
    }
    this.store.put('resource', id, { id, group, mime, local: true })
    return id
  }
  reference(m) {
    const { parts, missing } = resolve(this.store, m)
    return {
      missing,
      parts: parts.map((p) => {
        if (p.type !== 'media') return p
        const id = p.resource || key(m.group, p.source, p.url)
        if (!p.resource && !this.store.get('resource', id))
          this.store.put('resource', id, { id, group: m.group, mime: p.mime, url: p.url })
        return { type: 'media', mime: p.mime, resource: id, source: p.source }
      }),
    }
  }
  async file(g, id) {
    const r = this.store.get('resource', id)
    if (!r || r.group !== g) throw Error('本群找不到此素材，请重新发送')
    if (!r.local) {
      const { bytes } = await publicFile(r.url, 32 * 1024 * 1024)
      writeFileSync(join(this.dir, id), bytes)
      this.store.put('resource', id, { id, group: g, mime: r.mime, local: true })
    }
    return { bytes: readFileSync(join(this.dir, id)), mime: r.mime }
  }
  async builtin(name, a, ctx) {
    const { m, config } = ctx
    const backend = this.registry.get(name).provider
    const backendConfig =
      config.providers[backend] || (backend === 'vision' ? config.providers.chat : undefined)
    const label = backendConfig?.model || backendConfig?.base || backend
    const result = (data, sources = [], status = 'ok') => ({
      capability: name,
      provider: label,
      status,
      sources,
      data,
    })
    if (name === 'scheduleReminder') {
      if (!['owner', 'admin'].includes(m.role) || !m.mention || !/提醒|定时|通知/.test(m.text))
        throw Error('请由群管理员 @ 机器人明确指定提醒')
      const next = Date.parse(a.at),
        every = { once: 0, daily: 86400000, weekly: 604800000 }[a.interval || 'once']
      if (!(next > Date.now()) || !a.text?.trim() || every === undefined)
        throw Error('提醒需要未来时间和明确内容')
      const id = key(m.group, m.id, 'schedule')
      const item =
        this.store.get('schedule', id) ||
        this.store.put('schedule', id, { id, group: m.group, text: a.text, next, every, enabled: true })
      return result(item, [m.id])
    }
    if (name === 'resolveReference') return result(this.reference(m), [m.id])
    if (name === 'searchHistory') {
      const rows = this.store.history(m.group, a).filter((v) => v.id !== m.id)
      return result(
        rows.map((v) => ({
          id: v.id,
          at: v.at,
          text: v.text,
          author: v.author,
          parts: this.reference(v).parts.slice(0, 12),
        })),
        rows.map((v) => v.id),
      )
    }
    if (name === 'readWebPage') {
      try {
        const page = await readPage(a.url)
        if (page.status === 'restricted')
          page.card = this.reference(m).parts.find((p) => p.type === 'card' && p.url === a.url)
        return result(page, [a.url], page.status)
      } catch (e) {
        return result(
          {
            detail: e.message,
            card: this.reference(m).parts.find((p) => p.type === 'card' && p.url === a.url),
          },
          [a.url],
          'partial',
        )
      }
    }
    if (name === 'searchWeb') {
      const p = provider(config, 'search')
      const q = String(a.query || '').slice(0, 350)
      if (!q || /https?:\/\/|(?:rkey|auth_token)=|[A-Fa-f0-9]{32}/.test(q))
        throw Error('搜索词请只使用公开关键词')
      const response = await remote(p.base, {
        method: 'POST',
        headers: { ...auth(p), 'content-type': 'application/json' },
        body: JSON.stringify({
          query: q,
          max_results: 5,
          ...(a.domain ? { include_domains: [a.domain] } : {}),
          ...(a.timeRange ? { time_range: a.timeRange } : {}),
        }),
      })
      const hits = (response.results || []).map(({ title, url, content }) => ({
        title,
        url,
        snippet: content?.slice(0, 800),
      }))
      return result(
        hits,
        hits.map((h) => h.url),
      )
    }
    if (name === 'runCode') {
      if (!ctx.worker || !config.groups[m.group]?.code) throw Error('该群尚未授权沙箱代码执行')
      return result(await this.sandbox({ op: 'python', code: a.code }))
    }
    if (name === 'generateImage') {
      if (!ctx.worker || ctx.social) throw Error('生成作品需要群友明确发起的任务')
      const images = this.reference(m).parts.filter((p) => p.type === 'media' && p.mime.startsWith('image/'))
      const resource =
        a.resource ||
        (images.length === 1 && /照|参考|改|重做|横版|横屏/.test(m.text) ? images[0].resource : undefined)
      return result(await this.generate(ctx, { ...a, resource }))
    }
    const file = await this.file(m.group, a.resource)
    const p = provider(config, 'vision'),
      question = a.question || m.text
    let content = [{ type: 'text', text: question + '。请给出可核查的画面或原话，不能确定时说明。' }]
    let detail = '图片'
    if (file.mime.startsWith('video/')) {
      const sample = await this.sandbox({ op: 'video', data: file.bytes.toString('base64') })
      detail = '视频抽样，时长 ' + sample.duration + ' 秒'
      for (const f of sample.frames)
        content.push(
          { type: 'text', text: f.at + ' 秒' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + f.data } },
        )
      if (sample.audio && !config.providers.speech) {
        detail += '；未配置音轨转写，仅有画面证据'
        content.push({ type: 'text', text: detail })
      }
      if (sample.audio && config.providers.speech) {
        const speech = provider(config, 'speech'),
          form = new FormData()
        form.set('model', speech.model)
        form.set('file', new Blob([Buffer.from(sample.audio, 'base64')], { type: 'audio/mpeg' }), 'clip.mp3')
        form.set('response_format', 'verbose_json')
        form.append('timestamp_granularities[]', 'segment')
        const transcript = await remote(speech.base.replace(/\/$/, '') + '/audio/transcriptions', {
          method: 'POST',
          headers: auth(speech),
          body: form,
        })
        content.push({
          type: 'text',
          text:
            '音轨转录及秒数 ' +
            JSON.stringify(
              transcript.segments?.map((s) => [s.start, s.end, s.text]) || transcript.text,
            ).slice(0, 24000),
        })
      }
    } else if (file.mime.startsWith('image/'))
      content.push({
        type: 'image_url',
        image_url: { url: 'data:' + file.mime + ';base64,' + file.bytes.toString('base64') },
      })
    else throw Error('该素材格式暂不支持视觉分析')
    const answer = await chat(p, [{ role: 'user', content }])
    return result({ answer: answer.content, coverage: detail }, [m.id, a.resource])
  }
  async sandbox(body) {
    const endpoint = process.env.RUNNER_URL || 'http://runner:8090'
    return remote(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  async generate(ctx, args) {
    const { config, m } = ctx,
      p = provider(config, 'image')
    const jobKey = key(m.group, m.id, 'image')
    let job = this.store.get('paid', jobKey)
    if (job?.artifact) return { artifact: job.artifact }
    if (!job) {
      const prompt = args.prompt
      const path = args.resource ? p.editModel : p.model
      if (!path) throw Error('请配置对应的生图或改图模型')
      let image_urls
      if (args.resource) {
        const f = await this.file(m.group, args.resource)
        image_urls = ['data:' + f.mime + ';base64,' + f.bytes.toString('base64')]
      }
      const base = p.base.replace(/\/$/, '')
      this.store.put('paid', jobKey, { state: 'submitting' })
      const submitted = await remote(base + '/' + path, {
        method: 'POST',
        headers: { Authorization: 'Key ' + p.key, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, ...(image_urls ? { image_urls } : {}) }),
      })
      if (!submitted.request_id || !submitted.status_url || !submitted.response_url)
        throw Error('供应商未返回任务回执')
      job = this.store.put('paid', jobKey, {
        id: submitted.request_id,
        status: submitted.status_url,
        response: submitted.response_url,
        state: 'submitted',
      })
    }
    if (!job.id) throw Error('生成请求已发出但回执不确定，请在供应商后台核对，避免重复扣费')
    for (const url of [job.status, job.response])
      if (new URL(url).origin !== new URL(p.base).origin) throw Error('供应商回执域名不匹配')
    const options = { headers: { Authorization: 'Key ' + p.key } }
    let status
    try {
      status = await remote(job.status, options)
    } catch (e) {
      if (!e.status || e.status === 429 || e.status >= 500) throw new Pending('等待供应商恢复')
      throw e
    }
    if (['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Pending('等待图片生成')
    if (status.status !== 'COMPLETED') throw Error('图片任务状态 ' + status.status)
    const output = await remote(job.response, options)
    const f = await this.download(output.images[0].url, 24 * 1024 * 1024)
    const artifact = this.save(m.group, f.mime, f.bytes)
    this.store.put('paid', jobKey, { ...job, artifact, state: 'done' })
    return { artifact }
  }
}
