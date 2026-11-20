import { groupPolicy, groupTime, key } from './messages.mjs'
import { cardList, relevantCards } from './cards.mjs'
import { dailyCards, historyEnabled } from './memory.mjs'

export function routingContext(store, run, policy = groupPolicy(store.config(), run.m.group)) {
  const m = run.m,
    enabled = historyEnabled(store.config(), m.group)
  const rows = enabled
    ? store.history(m.group, { until: m.at, excludeId: m.id, limit: 20 }).reverse()
    : []
  const aliases = new Map([['@bot', '助手']]),
    labels = new Map()
  let member = 0,
    quoted = 0
  const selfId = store.get('selfMember', m.group)
  if (selfId) aliases.set(selfId, '助手')
  const peerLabel = (name) => {
    const safe = String(name || '').replace(/https?:\/\/\S+|[a-f0-9]{32,}/gi, '').replace(/[\x00-\x1f「」<>]/g, '').trim().slice(0, 48)
    return safe ? '机器人「' + safe + '」' : '其他机器人'
  }
  const alias = (id) => {
    if (!id) return '未知成员'
    if (!aliases.has(id)) {
      const u = store.member(m.group, id)
      aliases.set(id, u?.bot ? peerLabel(u.name) : '成员' + ++member)
    }
    return aliases.get(id)
  }
  const clean = (v, max) =>
    String(v || '')
      .replace(/https?:\/\/[^\s<>]+/gi, '[链接]')
      .replace(/<@!?([\w-]+)>/g, (_, id) => '@' + alias(id))
      .replace(/\b[a-f0-9]{32,}\b/gi, '[标识]')
      .slice(0, max)
  for (const [i, v] of [...rows, m].entries()) {
    for (const u of v.mentions || []) {
      if (u.self) aliases.set(u.id, '助手')
      else if (u.bot && u.id && !aliases.has(u.id) && u.name) aliases.set(u.id, peerLabel(u.name))
    }
    for (const id of [v.id, v.idx].filter(Boolean)) labels.set(id, 'm' + (i + 1))
  }
  const parents = new Map()
  function quote(ref, v) {
    const parent = store.lookup(m.group, ref)
    const canonical = parent?.author === '@bot' ? parent.parts?.[0]?.source : parent?.id
    const label = labels.get(ref) || labels.get(canonical) || 'q' + ++quoted
    labels.set(ref, label)
    if (!parents.has(label)) {
      const parts = parent?.parts || v.parts?.filter((p) => p.quote === ref || p.source === ref) || []
      parents.set(label, {
        id: label,
        speaker: alias(parent?.author),
        text: clean(parent?.text || parts.map((p) => p.text || p.title || '').join(' '), 320),
        attachments: parts
          .filter((p) => p.type === 'media' || p.type === 'card')
          .map((p) => p.mime || p.type)
          .slice(0, 8),
      })
    }
    return label
  }
  const describe = (v, max) => ({
    id: labels.get(v.id),
    speaker: alias(v.author),
    at: groupTime(v.at || m.at),
    text: clean(v.text, max),
    mentions: [
      ...new Set([
        ...(v.mention ? ['助手'] : []),
        ...(v.mentions || []).map((u) => (u.scope === 'all' ? '全体' : alias(u.id))),
      ]),
    ],
    repliesTo: (v.refs || [])
      .filter((ref) => ref !== v.inferredRef)
      .slice(0, 3)
      .map((ref) => quote(ref, v)),
    attachments: (v.parts || [])
      .filter((p) => p.type === 'media' || p.type === 'card')
      .map((p) => p.mime || p.type)
      .slice(0, 8),
  })
  const history = rows.map((v) => describe(v, 240)),
    current = describe(m, 1200)
  const quotes = current.repliesTo.map((id) => parents.get(id))
  const query = [m.text, ...quotes.map((v) => v.text)].join(' ')
  const selected = enabled ? relevantCards(cardList(store, m), query) : []
  if (enabled && !selected.length) selected.push(...relevantCards(dailyCards(store, m), query))
  const cards = selected.map((c, i) => ({
    id: 'c' + (i + 1),
    text: clean(c.text, 400),
    proposedBy: [
      ...new Set(c.sources.map((s) => alias(s.author || store.lookup(m.group, s.id)?.author))),
    ],
    disputed: !!c.disputed,
  }))
  const waiting = store.get('awaitReply', key(m.group, m.author))
  const state = {
    assistantName: policy.nickname,
    otherBotsNamedHere: store.botsNamedIn(m.group, m.text || '')
      .filter((u) => aliases.get(u.id) !== '助手' && u.label !== policy.nickname)
      .map((u) => peerLabel(u.label)),
    history,
    current,
    quotes,
    quotedOutsideHistory: [...parents.values()].filter((v) => v.id.startsWith('q')),
    cards,
    addressedToBot: !!(m.mention || (policy.nickname && m.text?.includes(policy.nickname))),
    waiting:
      !!run.waitingSource ||
      (!!waiting && waiting.until >= Date.parse(m.at) && m.refs?.includes(waiting.source)),
    quotedAssistant: quotes.some((q) => q.speaker === '助手'),
  }
  // Versioned local targets are never sent to the model.
  Object.defineProperty(state, 'targets', {
    value: new Map(cards.flatMap((v, i) => (selected[i].daily ? [] : [[v.id, selected[i]]]))),
  })
  return state
}
