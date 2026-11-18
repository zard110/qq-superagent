import { createHash } from 'node:crypto'
export const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
const clean = (v) => (typeof v === 'string' ? v.slice(0, 16000) : '')
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
    d.author?.bot ||
    !d.group_openid ||
    !d.id
  )
    return
  const meta = fields(d.message_scene),
    parts = [],
    refs = new Set(),
    group = d.group_openid
  if (meta.ref_msg_idx) refs.add(meta.ref_msg_idx)
  function walk(e, depth = 0) {
    if (depth > 12 || parts.length >= 120) return
    const source = clean(e.msg_idx || d.id),
      text = clean(e.content)
    if (text) parts.push({ type: 'text', text, source })
    if (e.message_type === 103 && e.msg_idx) refs.add(e.msg_idx)
    for (const a of (e.attachments || []).slice(0, 12))
      if (a.url) parts.push({ type: 'media', mime: clean(a.content_type), url: clean(a.url), source })
    if (e.ark_data) {
      const f = e.ark_data.fields || {}
      parts.push({
        type: 'card',
        title: clean(f.title),
        summary: clean(f.desc || e.ark_data.prompt),
        url: clean(f.jump_url),
        source,
      })
    }
    for (const child of e.msg_elements || []) walk(child, depth + 1)
  }
  walk(d)
  return {
    group,
    id: d.id,
    idx: meta.msg_idx || d.id,
    author: d.author?.member_openid || d.author?.id || '',
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
    refs: [...refs],
    mention: type === 'GROUP_AT_MESSAGE_CREATE' || d.mentions?.some((m) => m.is_you) === true,
  }
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
      if (!m.parts.some((p) => p.source === ref)) missing.push(ref)
      return
    }
    parts.push(...original.parts)
    original.refs.forEach((r) => visit(r, depth + 1))
  }
  m.refs.forEach((r) => visit(r, 0))
  return {
    parts: parts.filter((p, i, a) => a.findIndex((o) => JSON.stringify(o) === JSON.stringify(p)) === i),
    missing,
  }
}
export function groupPolicy(config, g) {
  return { mode: 'quiet', nickname: '小搭', rules: [], cooldown: 90, active: false, ...config.groups[g] }
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
  if (policy.mode === 'social') {
    const last = store.get('lastSpeech', m.group) || 0
    return Date.now() - last > 1000 * policy.cooldown && !!m.text.trim()
  }
  if (/(谁(能|知道)|请问.{1,50}[？?]|有人(知道|能帮)|帮忙查一下)/.test(m.text)) return true
  return (
    continuation &&
    !!previous &&
    Date.parse(m.at) - Date.parse(previous.at) < 180000 &&
    store.history(m.group, { thread: m.thread, author: '@bot', limit: 1 }).length > 0
  )
}
