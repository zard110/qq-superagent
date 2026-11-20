import { createHash } from 'node:crypto'
export const key = (...parts) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
// Keep the UTF-16 size bound without splitting a character at the boundary.
export function clipText(value, limit) {
  const prefix = value.slice(0, limit)
  return (value.length > limit ? prefix.replace(/[\uD800-\uDBFF]$/u, '') : prefix).toWellFormed()
}
const clean = (v) => (typeof v === 'string' ? clipText(v, 16000) : '')
export function groupTime(iso) {
  return iso && new Date(Date.parse(iso) + 8 * 3600000).toISOString().replace('Z', '+08:00')
}
export function historyBound(value, end = false) {
  if (!value) return undefined
  let time = value.trim()
  if (/^\d{4}-\d\d-\d\d$/.test(time)) time += end ? 'T23:59:59.999' : 'T00:00:00'
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(time)) time += '+08:00'
  if (!Number.isFinite(Date.parse(time))) throw Error('历史查询需要 ISO 日期或时间')
  return new Date(time).toISOString()
}
function fields(scene) {
  return Object.fromEntries(
    (scene?.ext || [])
      .filter((x) => typeof x === 'string' && x.includes('='))
      .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]),
  )
}
export function normalize(type, d) {
  if (
    !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type) ||
    d.author?.is_you ||
    !d.group_openid ||
    !d.id
  )
    return
  const meta = fields(d.message_scene),
    parts = [],
    refs = new Set(),
    group = d.group_openid
  if (meta.ref_msg_idx) refs.add(meta.ref_msg_idx)
  function walk(e, depth = 0, quoted) {
    if (depth > 12 || parts.length >= 120) return
    if (e.message_type === 103 && e.msg_idx) quoted = clean(e.msg_idx)
    const origin = quoted ? { quote: quoted } : {}
    const source = clean(e.msg_idx || quoted || d.id),
      text = clean(e.content)
    if (text) parts.push({ type: 'text', text, source, ...origin })
    if (e.message_type === 103 && e.msg_idx) refs.add(e.msg_idx)
    for (const a of (e.attachments || []).slice(0, 12))
      if (a.url)
        parts.push({ type: 'media', mime: clean(a.content_type), url: clean(a.url), source, ...origin })
    if (e.ark_data) {
      const f = e.ark_data.fields || {}
      parts.push({
        type: 'card',
        ...origin,
        title: clean(f.title),
        site: clean(f.source || f.tag),
        preview: clean(f.preview),
        summary: clean(f.desc || e.ark_data.prompt),
        url: clean(f.jump_url || f.url),
        source,
      })
    }
    for (const child of e.msg_elements || []) walk(child, depth + 1, quoted)
  }
  walk(d)
  const mentions = (d.mentions || []).map((user) => ({
    id: clean(user.member_openid || user.id),
    name: clean(user.member_nickname || user.username),
    memberName: clean(user.member_nickname),
    username: clean(user.username),
    role: clean(user.member_role),
    bot: !!(user.bot || user.is_you),
    self: !!user.is_you,
    scope: user.scope === 'all' ? 'all' : 'single',
  }))
  return {
    group,
    id: d.id,
    idx: meta.msg_idx || d.id,
    author: d.author?.member_openid || d.author?.id || '',
    ...(d.author?.bot ? { authorBot: true } : {}),
    nickname: clean(d.author?.member_nickname || d.author?.username),
    memberName: clean(d.author?.member_nickname),
    username: clean(d.author?.username),
    role: d.author?.member_role || 'member',
    at: new Date(d.timestamp || Date.now()).toISOString(),
    text:
      clean(d.content) ||
      clean(
        (d.msg_elements || [])
          .filter((e) => e.message_type === 0)
          .map((e) => clean(e.content))
          .join(' '),
      ),
    parts,
    mentions,
    refs: [...refs],
    mention: type === 'GROUP_AT_MESSAGE_CREATE' || d.mentions?.some((m) => m.is_you) === true,
  }
}
export function replyMentions(text, m, store) {
  if (!text) return text
  // Only the current message can request a notification; resolved quotes and history cannot.
  const request = m.text || ''
  const selfRequest =
    /(?:^|[\s，。！？、：,!:>]|请|要|记得|记住|直接|可以|能|再|先|时|时候|你|一下)(?:@|艾特|at)\s*我(?!们|的|了)/i.test(
      request,
    )
  const skipSelf = /(?:别|不要|不用|不必|无需|禁止|不需要)\s*(?:再|特意|你)?\s*(?:@|艾特|at)\s*我/i.test(
    request,
  )
  const sender = /^[\w-]+$/.test(m.author || '') && m.author !== 'all' ? m.author : ''
  const sent = new Set()
  const content = text
    .replace(/<@!?([\w-]+)>/g, (_, id) => {
      if (id === 'sender') id = sender
      if (id === sender && (selfRequest || skipSelf)) return ''
      const tagged = m.mentions?.find((u) => u.id === id)
      const person = store.member(m.group, id)
      if (selfRequest && id !== sender && !tagged && !(person?.name && request.includes(person.name)))
        return ''
      if (
        !id ||
        id === 'all' ||
        tagged?.self ||
        tagged?.bot ||
        person?.bot ||
        (!person && id !== sender && !tagged) ||
        sent.has(id)
      )
        return ''
      sent.add(id)
      return '<@' + id + '>'
    })
    .trim()
  return selfRequest && !skipSelf && sender ? ('<@' + sender + '> ' + content).trim() : content
}
export function resolve(store, m) {
  const parts = [...m.parts],
    missing = [],
    seen = new Set([m.id])
  function visit(ref, depth) {
    if (depth > 8 || parts.length > 160 || seen.has(ref)) return
    seen.add(ref)
    const original = store.lookup(m.group, ref)
    if (!original) {
      if (!m.parts.some((p) => p.source === ref || p.quote === ref)) missing.push(ref)
      return
    }
    parts.push(...original.parts)
    original.refs.forEach((r) => visit(r, depth + 1))
  }
  m.refs.forEach((r) => visit(r, 0))
  // Some QQ mini-apps repeat the card fields in a text element. Older stored
  // cards retained this text but discarded the source label.
  const enriched = parts.map((p) => {
    if (p.type !== 'card' || (p.site && p.url && p.preview)) return p
    const cardText = parts.find(
      (v) =>
        v.type === 'text' &&
        v.source === p.source &&
        v.text.startsWith('[卡片消息]') &&
        v.text.split(/\r?\n/).some((line) => line.trim() === 'title: ' + p.title),
    )
    if (!cardText) return p
    const site = cardText.text.match(/^(?:source|tag):[ \t]*([^\r\n]+)/m)?.[1]?.trim()
    const preview = cardText.text.match(/^preview:[ \t]*(https?:\/\/[^\s]+)/m)?.[1]
    const url = cardText.text.match(/^(?:jump_url|url):[ \t]*(https?:\/\/[^\s]+)/m)?.[1]
    return { ...p, site: p.site || site, url: p.url || url || '', preview: p.preview || preview }
  })
  return {
    parts: enriched.filter(
      (p, i, a) => a.findIndex((o) => JSON.stringify(o) === JSON.stringify(p)) === i,
    ),
    missing,
  }
}
// Stable per QQ message so retries and duplicate deliveries get the same draw.
export function selectedNaturalReply(policy, m) {
  const draw = parseInt(key('natural-reply', m.group, m.id).slice(0, 8), 16) / 0x100000000
  return draw < policy.replyProbability
}
export function proactiveHold(policy, m, lastSpeech, selected = selectedNaturalReply(policy, m)) {
  if (policy.mode === 'social' && !selected) return '回复概率未命中'
  if (Date.now() - (lastSpeech || 0) < policy.cooldown * 1000) return '自然发言冷却中'
}
export function groupPolicy(config, g) {
  return { mode: 'quiet', nickname: '小搭', rules: [], cooldown: 90, replyProbability: 0.75, active: false, ...config.groups[g] }
}
export function route(store, m, config) {
  const policy = groupPolicy(config, m.group)
  const parent = m.refs.map((ref) => store.lookup(m.group, ref)).find(Boolean)
  const previous = store.history(m.group, { author: m.author, limit: 1 })[0]
  const continuation = /^(再|继续|换成|改成|只看|有官方来源|那[么呢]|上一个)/.test(m.text.trim())
  m.thread =
    parent?.thread ||
    (m.refs[0] && key(m.group, m.refs[0])) ||
    (continuation && previous?.thread) ||
    key(m.group, m.id)
  if (m.mention) return true
  if (policy.mode === 'rules') return policy.rules.some((x) => x && m.text.includes(x))
  if (parent?.author === '@bot' || (policy.nickname && m.text.includes(policy.nickname))) return true
  if (policy.mode === 'social') return !!m.text.trim()
  if (/(谁(能|知道)|请问.{1,50}[？?]|有人(知道|能帮)|帮忙查一下)/.test(m.text)) return true
  return (
    continuation &&
    !!previous &&
    Date.parse(m.at) - Date.parse(previous.at) < 180000 &&
    store.history(m.group, { thread: m.thread, author: '@bot', limit: 1 }).length > 0
  )
}
