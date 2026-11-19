import { key } from './messages.mjs'

const words = new Intl.Segmenter('zh', { granularity: 'word' })
const stop = new Set('我 你 他 的 了 是 吗 什么 怎么 一个 那个 这个 群里 记住 设定 帮我'.split(' '))
function terms(text) {
  const value = String(text || '')
    .toLowerCase()
    .replace(/<@!?[\w-]+>|https?:\/\/[^\s<>]+/gi, ' ')
  return new Set(
    [...words.segment(value)].filter((v) => v.isWordLike && !stop.has(v.segment)).map((v) => v.segment),
  )
}
export function cardsFor(store, g, status = 'active') {
  return store.db
    .prepare('SELECT body FROM group_cards WHERE g=? AND status=? ORDER BY rowid DESC')
    .all(g, status)
    .map((row) => JSON.parse(row.body))
}
export function relevantCards(cards, query, limit = 3) {
  const tokens = terms(query)
  return cards
    .map((card) => {
      const haystack = card.text.toLowerCase()
      const own = terms(haystack)
      let score = 0
      for (const word of tokens)
        if (own.has(word) || (word.length >= 2 && haystack.includes(word)))
          score += Math.min(6, word.length)
      return { card, score }
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score || b.card.at.localeCompare(a.card.at))
    .slice(0, limit)
    .map((v) => v.card)
}
function put(store, g, c) {
  store.db
    .prepare(
      'INSERT INTO group_cards VALUES(?,?,?,?) ON CONFLICT(g,id) DO UPDATE SET status=excluded.status,body=excluded.body',
    )
    .run(g, c.id, c.status, JSON.stringify(c))
  return c
}
export function cardList(store, m) {
  return cardsFor(store, m.group).filter((c) => c.at <= m.at)
}
export function saveStatement(store, m, action, target) {
  if (
    !action ||
    action === 'none' ||
    !m.text?.trim() ||
    m.author === '@bot' ||
    store.config().groups?.[m.group]?.disabled?.includes('searchHistory')
  )
    return
  return store.atomic(() => {
    const receipt = key(m.group, m.id)
    const previous = store.get('cardReceipt', receipt)
    if (previous) return previous
    const id = key('card', m.group, m.id)
    let status = action === 'candidate' ? 'candidate' : 'active'
    if (action === 'correct' && !target) status = 'candidate'
    const text = m.text.replace(/https?:\/\/[^\s<>]+/gi, '[链接]').trim()
    const source = { id: m.id, author: m.author, at: m.at }
    // Corrections are effective immediately only on the version actually seen by the classifier.
    if (target && action === 'correct') {
      const live = store.db
        .prepare('SELECT body FROM group_cards WHERE g=? AND id=? AND status=?')
        .get(m.group, target.id, 'active')
      if (live && JSON.parse(live.body).version === target.version && target.at <= m.at)
        put(store, m.group, { ...target, status: 'superseded', replacement: id })
      else status = 'candidate'
    }
    const saved = put(store, m.group, {
      id,
      status,
      text,
      at: m.at,
      version: receipt,
      sources: [source],
    })
    return store.put('cardReceipt', receipt, { id: saved.id, status })
  })
}

// Apply the daily model's decisions only to human source messages in this batch and cards it actually saw.
export function reconcileCards(store, g, changes, shown, sources) {
  if (!Array.isArray(changes)) throw Error('群卡片整理结果格式无效')
  for (const change of changes) {
    if (
      !['keep', 'correct', 'disputed', 'discard'].includes(change.action) ||
      !Array.isArray(change.sources) ||
      !change.sources.length
    )
      throw Error('群卡片缺少有效的处理动作或来源')
    const originals = change.sources.map((id) => sources.get(id)).map((v) => v && store.lookup(g, v.id))
    if (originals.some((m) => !m || m.author === '@bot')) throw Error('群卡片来源无效')
    const refs = originals
      .map((m) => ({ id: m.id, at: m.at, author: m.author }))
      .sort((a, b) => a.at.localeCompare(b.at))
    const at = refs.at(-1).at
    const target = change.target ? shown.get(change.target) : undefined
    if (change.target && !target) throw Error('群卡片目标无效')
    const read = (id) => {
      const row = store.db.prepare('SELECT body FROM group_cards WHERE g=? AND id=?').get(g, id)
      return row && JSON.parse(row.body)
    }
    const sourceCards = refs.map((v) => read(key('card', g, v.id))).filter(Boolean)
    if (change.action === 'discard') {
      for (const card of sourceCards)
        if (card.status === 'candidate') put(store, g, { ...card, status: 'archived' })
      continue
    }
    const text = change.text?.trim()
    if (!text || text.length > 800) throw Error('群卡片正文无效')
    const id = target?.id || key('card', g, refs[0].id)
    const live = read(id)
    if (
      live &&
      (live.at > at || live.status === 'superseded' || (target && live.version !== target.version))
    )
      continue
    const all = [...new Map([...(live?.sources || []), ...refs].map((s) => [s.id, s])).values()]
    put(store, g, {
      id,
      at,
      text,
      status: 'active',
      disputed: change.action === 'disputed',
      sources: all,
      version: key(id, text, all),
    })
    for (const card of sourceCards)
      if (card.id !== id && card.at <= at && ['active', 'candidate'].includes(card.status))
        put(store, g, { ...card, status: 'superseded', replacement: id })
  }
}
