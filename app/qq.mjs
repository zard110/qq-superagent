import { createHash } from 'node:crypto'
import { taskStatus } from './task-status.mjs'
import { remote } from './network.mjs'
import { key, groupPolicy } from './messages.mjs'
const api = 'https://api.bot.qq.com'
const hash = (name, bytes) => createHash(name).update(bytes).digest('hex')
export function documentParts(text) {
  const sections = text
    .replace(/\r\n/g, '\n')
    .split(/(?=^#{1,4} |^第[零一二三四五六七八九十百\d]+[集场])/mu)
  const chunks = []
  let chunk = ''
  for (const section of sections) {
    if (chunk && chunk.length + section.length > 1400) {
      chunks.push(chunk)
      chunk = ''
    }
    for (const line of section.split(/(?<=\n)/u)) {
      if (chunk && chunk.length + line.length > 1400) {
        chunks.push(chunk)
        chunk = ''
      }
      for (const char of line) {
        if (chunk.length + char.length > 1400) {
          chunks.push(chunk)
          chunk = ''
        }
        chunk += char
      }
    }
  }
  if (chunk) chunks.push(chunk)
  return chunks
}
export class QQ {
  constructor(runtime) {
    this.app = runtime
    this.store = runtime.store
    this.status = '等待配置'
    this.enabled = false
    this.directoryLoads = new Map()
    this.initializedGroups = new Set()
    runtime.caps.register({
      spec: {
        type: 'function',
        function: {
          name: 'getGroupInfo',
          description:
            'info 查群名和人数；bot_state 查接收范围；member 用 query 按 ID 或准确昵称查本群已知成员（可能同名）；members 按页读取首次缓存的正式名单。仅在用户要求更新名单时设置 refresh。',
          parameters: {
            type: 'object',
            properties: {
              topic: { type: 'string', enum: ['info', 'bot_state', 'member', 'members'] },
              cursor: { type: 'string' },
              query: { type: 'string' },
              refresh: { type: 'boolean' },
            },
            required: ['topic'],
            additionalProperties: false,
          },
        },
      },
      provider: 'QQ',
      media: [],
      output: 'QQ 群资料、接收设置或一页成员名单及权限状态',
      execute: (args, ctx) =>
        this.groupInfo(ctx.m.group, {
          ...args,
          refresh: args.refresh === true && /刷新|同步|更新|重新(查|拉|获取)/.test(ctx.m.text || ''),
        }),
    })
  }
  warmDirectory(group) {
    if (
      !group ||
      this.initializedGroups.has(group) ||
      this.store.config().groups[group]?.disabled?.includes('getGroupInfo')
    )
      return
    this.initializedGroups.add(group)
    void this.directory(group).catch(() => {
      // Explicit member lookups can retry transient failures; normal messages stay offline.
    })
  }
  async directory(group, refresh = false) {
    const pending = this.directoryLoads.get(group)
    if (pending) return pending
    const cached = this.store.get('memberRoster', group)
    if (cached && !refresh) return cached
    const task = this.loadDirectory(group)
    this.directoryLoads.set(group, task)
    try {
      return await task
    } finally {
      this.directoryLoads.delete(group)
    }
  }
  async loadDirectory(group) {
    const pages = [],
      members = [],
      seen = new Set()
    const at = new Date().toISOString()
    let cursor = ''
    try {
      do {
        if (seen.has(cursor)) throw Error('群成员名单分页游标重复')
        seen.add(cursor)
        if (cursor) await new Promise((resolve) => setTimeout(resolve, 1050))
        const page = await this.request(
          '/v2/groups/' +
            encodeURIComponent(group) +
            '/members' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        )
        const people = page.members.map((m) => ({
          id: m.member_openid,
          name: m.member_nickname,
          username: m.username,
          role: m.member_role,
          bot: !!m.bot,
        }))
        pages.push({ cursor, ids: people.map((p) => p.id), nextCursor: page.next_cursor || null })
        members.push(...people)
        cursor = page.next_cursor
      } while (cursor)
    } catch (e) {
      if (Number(e.code) !== 11253) throw e
      return this.store.put('memberRoster', group, { status: 'restricted', code: 11253, at })
    }
    return this.store.atomic(() => {
      for (const member of members) this.store.rememberMember(group, member, at)
      return this.store.put('memberRoster', group, { status: 'ok', pages, at })
    })
  }
  async groupInfo(group, { topic, cursor, query, refresh }) {
    if (!['info', 'bot_state', 'member', 'members'].includes(topic)) throw Error('未知的群资料类型')
    const source = '/v2/groups/' + encodeURIComponent(group) + '/' + topic
    const result = { capability: 'getGroupInfo', provider: 'QQ', sources: [source] }
    if (topic === 'member') {
      if (!query?.trim()) throw Error('请提供群昵称或成员 ID')
      const value = query.trim()
      const lookup = () => {
        const member = this.store.member(group, value)
        return member ? [member] : this.store.namedMembers(group, value)
      }
      let matches = lookup()
      const byId = matches.length === 1 && matches[0].id === value
      if (byId && (!matches[0].name || refresh)) {
        if (refresh || !this.store.get('memberDetailDenied', group)) {
          try {
            const person = await this.request(
              '/v2/groups/' + encodeURIComponent(group) + '/members/' + encodeURIComponent(value),
            )
            if (person.member_openid === value)
              this.store.rememberMember(
                group,
                {
                  id: value,
                  username: person.username,
                  role: person.member_role,
                  bot: person.bot,
                },
                new Date().toISOString(),
              )
            this.store.del('memberDetailDenied', group)
          } catch (e) {
            if (Number(e.code) !== 11253) throw e
            this.store.put('memberDetailDenied', group, true)
          }
          matches = lookup()
        }
      } else if (!matches.length || refresh) {
        await this.directory(group, refresh)
        matches = lookup()
      }
      return {
        ...result,
        provider: '本群成员缓存',
        sources: [],
        status: 'ok',
        data: {
          matches,
          scope:
            '本群已知的 OpenID 或昵称。未命中不能用来判断此人是否在群，普通 QQ 号无法换算为群成员 OpenID。',
        },
      }
    }
    if (topic === 'members') {
      const roster = await this.directory(group, refresh)
      if (roster.status === 'restricted')
        return {
          ...result,
          status: 'restricted',
          data: {
            code: roster.code,
            ...this.store.observedMembers(group, cursor),
            complete: false,
            detail:
              '以下是本群已记录的身份。完整名册未获授权；无法按个人 QQ 号判断是否在群。若要识别尚未记录的人，可请群友在本群 @ 对方或由对方发言。',
          },
        }
      const page = roster.pages.find((p) => p.cursor === (cursor || ''))
      if (!page) throw Error('名单游标已失效，请从第一页开始')
      return {
        ...result,
        status: 'ok',
        data: {
          members: page.ids.map((id) => this.store.member(group, id)),
          nextCursor: page.nextCursor,
          asOf: roster.at,
        },
      }
    }
    try {
      if (topic === 'info' && !refresh) {
        const cached = this.store.get('groupInfo', group)
        if (cached && Date.now() - cached.at < 300000)
          return { ...result, status: 'ok', data: cached.data }
      }
      const row = await this.request(source)
      let data
      if (topic === 'info') {
        data = { name: row.group_name, memberCount: row.group_member_num }
        this.store.put('groupInfo', group, { at: Date.now(), data })
      }
      if (topic === 'bot_state')
        data = {
          messageScope: row.recv_msg_setting,
          proactive: row.allow_proactive_msg,
          joinedAt: row.joined_at,
        }
      return { ...result, status: 'ok', data }
    } catch (e) {
      if (Number(e.code) !== 11253) throw e
      return {
        ...result,
        status: 'restricted',
        data: {
          code: 11253,
          detail: 'QQ 未向当前机器人开放此接口。群总人数可另查 info，已发言者可查本群留存历史。',
        },
      }
    }
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
    if (result.code) throw Object.assign(Error('QQ 业务错误 ' + result.code), { code: result.code })
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
              if (t === 'READY') {
                cursor.session = d.session_id
                cursor.selfId = d.user?.id
              }
              this.status = '已连接'
              const message = this.app.receive(t, d)
              if (message) this.warmDirectory(message.group)
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
    const document = ['text/plain', 'text/markdown'].includes(mime)
    if (!document && !/^(audio|video|image)\//.test(mime)) throw Error('QQ 不支持该文件类型')
    const data = {
      file_type: document ? 4 : mime.startsWith('audio/') ? 3 : mime.startsWith('video/') ? 2 : 1,
      file_name: document
        ? this.store.get('resource', id)?.name || '文稿.' + (mime === 'text/markdown' ? 'md' : 'txt')
        : id +
          ({
            'audio/wav': '.wav',
            'audio/mpeg': '.mp3',
            'audio/flac': '.flac',
            'video/mp4': '.mp4',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
          }[mime] || '.png'),
      srv_send_msg: false,
    }
    if (bytes.length < 5_000_000)
      return (await this.request(path + '/files', { ...data, file_data: bytes.toString('base64') }))
        .file_info
    const prep = await this.request(path + '/upload_prepare', {
      ...data,
      file_size: String(bytes.length),
      md5: hash('md5', bytes),
      sha1: hash('sha1', bytes),
      md5_10m: hash('md5', bytes.subarray(0, 10002432)),
    })
    // QQ responses use both zero-based and one-based indices. The index identifies the
    // part in the acknowledgement. Slice the file by the validated sequence of byte lengths.
    const parts = [...prep.parts].sort((a,b) => a.index - b.index)
    const first = parts[0]?.index
    let offset = 0
    if (![0,1].includes(first)) throw Error('QQ 返回的分片序号无效')
    for (const [i,part] of parts.entries()) {
      const size = Number(part.block_size ?? prep.block_size)
      if (part.index !== first+i || !Number.isSafeInteger(size) || size <= 0 || offset >= bytes.length)
        throw Error('QQ 返回的分片范围无效')
      const chunk = bytes.subarray(offset, offset + size)
      offset += chunk.length
      if ((i === parts.length - 1) !== (offset === bytes.length))
        throw Error('QQ 返回的分片未覆盖整个文件')
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
  async splitDocument(o, e) {
    const s = this.store
    const file = s.get('resource', o.artifact)
    if (!['text/plain', 'text/markdown'].includes(file?.mime) || ![400, 403, 415].includes(e.status))
      return false
    const text = (await this.app.caps.file(o.group, o.artifact)).bytes.toString('utf8')
    const chunks = documentParts(text)
    s.atomic(() => {
      let previous
      for (const [i, chunk] of chunks.entries()) {
        const id = key(o.id, 'text', i)
        if (!s.get('out', id))
          s.put('out', id, {
            id,
            group: o.group,
            origin: o.origin,
            sourceOrigin: o.sourceOrigin,
            text: '【' + (file.name || '剧本') + ' ' + (i + 1) + '/' + chunks.length + '】\n' + chunk,
            status: 'pending',
            at: Date.now(),
            plain: true,
            previous,
            replyId: o.replyId,
          })
        previous = id
      }
      o.status = 'split'
      o.detail = '文件上传受限，改为分段正文'
      s.put('out', o.id, o)
    })
    return true
  }
  async flush() {
    const s = this.store
    if (!s.config().qq.appId) return
    this.sending ||= new Set()
    const o = s.nextDelivery([...this.sending])
    if (!o) return
    const source = JSON.stringify([o.group, o.origin || o.replyId || o.id])
    this.sending.add(source)
    try {
      const origin = o.origin && s.lookup(o.group, o.origin)
      let passive = origin && Date.now() - Date.parse(origin.at) < 295000
      try {
        if (o.progressRun) {
          const run = s.get('run', o.progressRun)
          // Keep passive reply slots for the final text and attachment.
          if (passive && !o.seq && s.nextSequence(o.group, o.origin) > 3) passive = false
          if (run?.state !== 'running' || (!passive && (o.seq || !groupPolicy(s.config(), o.group).active))) {
            o.status = 'superseded'
            return
          }
        }
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
        let info
        if (o.artifact) {
          try {
            info = await this.upload(o.group, o.artifact)
          } catch (e) {
            if (!(await this.splitDocument(o, e))) throw e
            return
          }
        }
        if (o.statusRun) o.text = taskStatus(s, o.group, o.statusRun)
        const body = o.artifact
          ? { msg_type: 7, media: { file_info: info } }
          : o.plain
            ? { msg_type: 0, content: o.text }
            : { msg_type: 2, markdown: { content: o.text } }
        if (passive) Object.assign(body, { msg_id: origin.id, msg_seq: o.seq })
        if (!passive) {
          o.activeAttempt = true
          s.put('out', o.id, o)
        }
        const reply = await this.request('/v2/groups/' + encodeURIComponent(o.group) + '/messages', body)
        o.status = 'sent'
        o.remote = reply.id
        s.put('out', o.id, o)
        if (reply.id && o.progressRun) {
          const run = s.get('run', o.progressRun)
          s.message({group:o.group, id:reply.id, idx:reply.message_scene?.ext?.find(x => x.startsWith('msg_idx='))?.slice(8) || reply.id,
            author:'@bot', nickname:'机器人', at:new Date().toISOString(), thread:run.m.thread,
            text:o.text, parts:[{type:'text', text:o.text, source:reply.id}], refs:[], mentions:[]})
        } else if (reply.id && origin) {
          const bot = s.lookup(
            o.group,
            o.replyId || key(key(o.group, o.sourceOrigin || o.origin), 'reply'),
          )
          if (bot)
            s.message({
              ...bot,
              ...(o.statusRun && {text:o.text,parts:[{type:'text', text:o.text, source:reply.id}]}),
              id: reply.id,
              idx: reply.message_scene?.ext?.find((x) => x.startsWith('msg_idx='))?.slice(8) || reply.id,
            })
        }
      } catch (e) {
        if (o.status === 'sent') return
        if (o.artifact && [400, 415].includes(e.status) && (await this.splitDocument(o, e))) return
        o.detail = e.message
        o.tries = (o.tries || 0) + 1
        o.after = Date.now() + Math.min(60, o.tries * 5) * 1000
        if (o.tries >= 3) o.status = 'held'
      } finally {
        s.put('out', o.id, o)
      }
    } finally {
      this.sending.delete(source)
    }
  }
}
