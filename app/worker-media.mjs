import { audioRequest } from './audio-models.mjs'
import { key } from './messages.mjs'
import { Pending } from './capabilities.mjs'

export const mediaMethods = new Set([
  'analyzeMedia',
  'resolveAudioSource',
  'generateImage',
  'generateVideo',
  'generateMusic',
  'synthesizeSpeech',
])
export const paidMedia = new Map([['generateImage','image'],['generateVideo','video'],['generateMusic','music'],['synthesizeSpeech','tts']])
const pendingCalls = new Map()

export function recoverMediaItems(store, current) {
  const items = new Map(), seen = new Set()
  const query = store.db.prepare("SELECT id,body FROM records WHERE bucket='mediaItem' AND json_extract(body,'$.run')=?")
  for (let run = current; run && !seen.has(run.id); run = run.resumeOf && store.get('run',run.resumeOf)) {
    if (run.ticket !== current.ticket || run.m.group !== current.m.group || run.m.id !== current.m.id) break
    seen.add(run.id)
    for (const row of query.all(run.id)) {
      const {method,item,fingerprint} = JSON.parse(row.body), result = store.get('step',row.id)?.result
      const id = key(method,item)
      if (!items.has(id)) items.set(id,{method,item,fingerprint,status:result?.status || 'unknown',
        resource:result?.data?.artifact || result?.data?.resource})
    }
  }
  return [...items.values()]
}

// The worker chooses the tool and assigns a stable name to each shot, asset or voice line.
// The gateway keeps credentials, group permissions, receipts and file ownership on the server.
export async function workerMedia(grant, method, item, args) {
  if (
    !mediaMethods.has(method) ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    throw Error('无效的媒体工具或作品编号')
  const { caps, ctx } = grant
  const config = caps.store.config()
  if (
    config.groups?.[ctx.m.group]?.code === false ||
    config.groups?.[ctx.m.group]?.disabled?.includes(method) ||
    (caps.tools && !caps.tools(config).some(tool=>tool.function.name===method))
  )
    throw Error('本群已关闭该工具')
  const spec = caps.tools?.(config).find(t=>t.function.name===method)?.function.parameters
  if (spec?.additionalProperties === false) {
    for (const [key,value] of Object.entries(args)) {
      if (!Object.hasOwn(spec.properties,key)) throw Error(method+' 不支持参数 '+key)
      const field = spec.properties[key]
      const validType = field.type === 'array' ? Array.isArray(value) && value.every(v=>typeof v === field.items.type)
        : field.type === 'integer' ? Number.isInteger(value) : typeof value === field.type
      if (!validType || (field.enum && !field.enum.includes(value)) || value < field.minimum || value > field.maximum ||
          (Array.isArray(value) && value.length > field.maxItems)) throw Error(method+' 的参数 '+key+' 无效')
    }
  }
  if (paidMedia.has(method) && ctx.social) throw Error('生成媒体需要群友交办')
  const id = key(ctx.run, 'media', method, item)
  const fingerprint = key(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  )
  const previous = caps.store.get('mediaItem', id)
  if (previous && previous.fingerprint !== fingerprint)
    throw Error('同一作品编号对应了不同参数；重试请沿用原参数，新版本使用新编号')
  if (!previous && grant.lease?.recovering && paidMedia.has(method)) {
    const run = caps.store.get('run',ctx.run) || {id:ctx.run, m:ctx.m}
    const earlier = recoverMediaItems(caps.store,run).filter(row => row.method === method)
    const original = earlier.find(row => row.item === item)
    if (original?.fingerprint && original.fingerprint !== fingerprint)
      throw Error('同一作品编号对应了不同参数；请沿用原参数')
    const kind = paidMedia.get(method)
    if (!original && earlier.some(row => {
      if (row.status === 'ok') return false
      const order = caps.store.get('paid',key(ctx.m.group,ctx.m.id,'beeftv',kind,row.item))
      if (order?.state === 'done' && order.artifact) return false
      // A distinct shot can proceed alongside a known provider order. An unacknowledged
      // submission, or the same pending request renamed, must first be reconciled.
      return row.fingerprint === fingerprint || !row.fingerprint || !order?.receipt?.id || order.state !== 'submitted'
    })) throw Error('恢复时该工具还有回执不确定或相同的项目，请按原编号核对')
  }
  if (!previous && (method === 'generateMusic' || (method === 'synthesizeSpeech' && config.routes?.tts === 'beeftv')))
    audioRequest(paidMedia.get(method),args,ctx.m.text)
  if (!previous) caps.store.put('mediaItem', id, { fingerprint, run: ctx.run, method, item })
  const execute = async () => {
    const saved = caps.store.get('step', id)
    if (saved?.result?.status === 'ok') return saved.result.data
    try {
      const result = await caps.run(method, args, { ...ctx, config, mediaItem: item, callId: id })
      if (result.status !== 'ok') throw Error(result.detail || '媒体工具未完成')
      caps.store.put('step', id, { id, run: ctx.run, name: method, item, result })
      return result.data
    } catch (e) {
      const status = e instanceof Pending ? 'pending' : 'failed'
      caps.store.put('step', id, {
        id,
        run: ctx.run,
        name: method,
        item,
        result: { status, detail: e.message },
      })
      if (e instanceof Pending) return { pending: true }
      throw e
    }
  }
  let operation = pendingCalls.get(id)
  if (!operation) {
    operation = execute().finally(() => pendingCalls.delete(id))
    pendingCalls.set(id, operation)
  }
  const result = await operation
  if (result.pending || method === 'analyzeMedia') return result
  const resource = result.artifact || result.resource
  const file = await caps.file(ctx.m.group, resource)
  return { resource, mime: file.mime, data: file.bytes.toString('base64'), ...(result.applied && {applied:result.applied}) }
}
