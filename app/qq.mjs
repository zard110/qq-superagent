import { createHash } from 'node:crypto'
import { remote } from './network.mjs'
import { key, groupPolicy } from './messages.mjs'
const api = 'https://api.bot.qq.com'
const hash = (name, bytes) => createHash(name).update(bytes).digest('hex')
export class QQ {
  constructor(runtime) {
    this.app = runtime
    this.store = runtime.store
    this.status = '等待配置'
    this.enabled = false
  }
  async token() {
    if (this.cached?.until > Date.now()) return this.cached.token
    const { appId, secret } = this.store.config().qq
    const r = await remote(api + '/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }),
    })
    if (!r.access_token) throw Error('QQ 鉴权失败 ' + (r.code || ''))
    this.cached = { token: r.access_token, until: Date.now() + (Number(r.expires_in) - 60) * 1000 }
    return r.access_token
  }
  async request(path, body) {
    const token = await this.token()
    const result = await remote(api + path, {
      headers: { Authorization: 'QQBot ' + token, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
    if (result.code) throw Error('QQ 业务错误 ' + result.code)
    return result
  }
  async connect() {
    if (
      this.connecting ||
      this.socket ||
      !this.store.config().qq.appId ||
      !this.enabled ||
      Date.now() < (this.retryAt || 0)
    )
      return
    this.connecting = true
    try {
      const { url } = await this.request('/gateway'),
        token = await this.token()
      if (!this.enabled) return
      const ws = (this.socket = new WebSocket(url))
      let timer
      const send = (op, d) => ws.send(JSON.stringify({ op, d }))
      ws.onmessage = (e) => {
        try {
          const packet = JSON.parse(e.data),
            { op, t, d, s } = packet
          if (op === 10) {
            const saved = this.store.get('qq', 'gateway')
            if (saved?.app === this.store.config().qq.appId && saved.session)
              send(6, { token: 'QQBot ' + token, session_id: saved.session, seq: saved.seq })
            else send(2, { token: 'QQBot ' + token, intents: 1 << 25, shard: [0, 1], properties: {} })
            timer = setInterval(() => {
              if (ws.readyState === 1) send(1, this.store.get('qq', 'gateway')?.seq ?? null)
            }, d.heartbeat_interval)
          }
          if (op === 9 || op === 7) {
            if (op === 9) this.store.del('qq', 'gateway')
            ws.close()
            return
          }
          if (op === 0)
            this.store.atomic(() => {
              const cursor = this.store.get('qq', 'gateway') || {}
              if (t === 'READY') cursor.session = d.session_id
              this.status = '已连接'
              this.app.receive(t, d)
              this.store.put('qq', 'gateway', { ...cursor, app: this.store.config().qq.appId, seq: s })
            })
        } catch {
          ws.close()
        }
      }
      ws.onerror = () => {
        this.status = 'QQ 网关连接失败'
      }
      ws.onclose = (e) => {
        clearInterval(timer)
        if (this.socket === ws) this.socket = null
        this.status = '已断开 ' + e.code
        this.retryAt = Date.now() + 5000
        if ([4006, 4007].includes(e.code)) this.store.del('qq', 'gateway')
      }
    } catch (e) {
      this.status = e.message
      this.retryAt = Date.now() + 15000
    } finally {
      this.connecting = false
    }
  }
  reset() {
    this.socket?.close()
    this.cached = null
    this.store.del('qq', 'gateway')
    this.retryAt = 0
  }
  async upload(group, id) {
    const { bytes, mime } = await this.app.caps.file(group, id)
    const path = '/v2/groups/' + encodeURIComponent(group)
    const data = {
      file_type: mime === 'audio/wav' ? 3 : 1,
      file_name: id + (mime === 'audio/wav' ? '.wav' : mime === 'image/jpeg' ? '.jpg' : '.png'),
      srv_send_msg: false,
    }
    if (bytes.length < 5_000_000)
      return (await this.request(path + '/files', { ...data, file_data: bytes.toString('base64') })).file_info
    const prep = await this.request(path + '/upload_prepare', {
      ...data,
      file_size: String(bytes.length),
      md5: hash('md5', bytes),
      sha1: hash('sha1', bytes),
      md5_10m: hash('md5', bytes.subarray(0, 10002432)),
    })
    for (const part of prep.parts) {
      const offset = part.index * Number(prep.block_size),
        chunk = bytes.subarray(offset, offset + Number(part.block_size))
      const res = await fetch(part.presigned_url, {
        method: 'PUT',
        body: chunk,
        redirect: 'error',
        signal: AbortSignal.timeout(40000),
      })
      if (!res.ok) throw Error('QQ 分片上传失败')
      await this.request(path + '/upload_part_finish', {
        upload_id: prep.upload_id,
        part_index: part.index,
        block_size: String(chunk.length),
        md5: hash('md5', chunk),
      })
    }
    return (await this.request(path + '/files', { ...data, upload_id: prep.upload_id })).file_info
  }
  async flush() {
    if (this.sending || !this.store.config().qq.appId) return
    this.sending = true
    try {
      const s = this.store
      const o = s.nextDelivery()
      if (!o) return
      const origin = o.origin && s.lookup(o.group, o.origin)
      const passive = origin && Date.now() - Date.parse(origin.at) < 295000
      try {
        if (!passive && !groupPolicy(s.config(), o.group).active) {
          o.status = 'held'
          return
        }
        if (!passive && o.activeAttempt) {
          o.status = 'held'
          o.detail = '主动发送回执不确定，请按需领取'
          return
        }
        if (passive && !o.seq) {
          o.seq = s.nextSequence(o.group, o.origin)
          if (o.seq > 5) {
            o.status = 'held'
            return
          }
          s.put('out', o.id, o)
        }
        const body = o.artifact
          ? { msg_type: 7, media: { file_info: await this.upload(o.group, o.artifact) } }
          : { msg_type: 0, content: o.text }
        if (passive) Object.assign(body, { msg_id: origin.id, msg_seq: o.seq })
        if (!passive) {
          o.activeAttempt = true
          s.put('out', o.id, o)
        }
        const reply = await this.request('/v2/groups/' + encodeURIComponent(o.group) + '/messages', body)
        o.status = 'sent'
        o.remote = reply.id
        if (reply.id && origin) {
          const bot = s.lookup(o.group, key(key(o.group, o.sourceOrigin || o.origin), 'reply'))
          if (bot)
            s.message({
              ...bot,
              id: reply.id,
              idx: reply.message_scene?.ext?.find((x) => x.startsWith('msg_idx='))?.slice(8) || reply.id,
            })
        }
      } catch (e) {
        o.detail = e.message
        o.tries = (o.tries || 0) + 1
        o.after = Date.now() + Math.min(60, o.tries * 5) * 1000
        if (o.tries >= 3) o.status = 'held'
      } finally {
        s.put('out', o.id, o)
      }
    } finally {
      this.sending = false
    }
  }
}
