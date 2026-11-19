import { key } from './messages.mjs'
import { Pending } from './capabilities.mjs'

const methods = new Set([
  'analyzeMedia',
  'resolveAudioSource',
  'generateImage',
  'generateVideo',
  'synthesizeSpeech',
])
const paid = new Set(['generateImage', 'generateVideo', 'synthesizeSpeech'])
const pendingCalls = new Map()

// The worker chooses the tool and assigns a stable name to each shot, asset or voice line.
// The gateway keeps credentials, group permissions, receipts and file ownership on the server.
export async function workerMedia(grant, method, item, args) {
  if (
    !methods.has(method) ||
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
  if (paid.has(method) && ctx.social) throw Error('生成媒体需要群友交办')
  const id = key(ctx.run, 'media', method, item)
  const fingerprint = key(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  )
  const previous = caps.store.get('mediaItem', id)
  if (previous && previous.fingerprint !== fingerprint)
    throw Error('同一作品编号对应了不同参数；重试请沿用原参数，新版本使用新编号')
  if(!previous && grant.lease?.recovering && paid.has(method)){
    const earlier=caps.store.db.prepare("SELECT id FROM records WHERE bucket='mediaItem' AND json_extract(body,'$.run')=? AND json_extract(body,'$.method')=?").all(ctx.run,method)
    if(earlier.some(row=>caps.store.get('step',row.id)?.result?.status!=='ok'))
      throw Error('恢复时该工具还有未完成或回执不确定的项目，请按原编号核对')
  }
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
  return { resource, mime: file.mime, data: file.bytes.toString('base64') }
}
