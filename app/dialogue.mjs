import {pluginSettings} from './plugins/memes.mjs'
import { clipText, groupPolicy, groupTime, key, selectedNaturalReply } from './messages.mjs'
import { cardList, relevantCards } from './cards.mjs'
import { dailyCards, historyEnabled } from './memory.mjs'

export function routingContext(store, run, policy, candidates = []) {
  return buildContext(store, run, policy, candidates, true)
}

export function replyContext(store, run, policy) {
  return buildContext(store, run, policy, [], false)
}

function buildContext(store, run, policy = groupPolicy(store.config(), run.m.group), candidates, anonymous) {
  const m = run.m,
    enabled = historyEnabled(store.config(), m.group)
  const rows = enabled
    ? store.history(m.group, { until: run.reviewedAt || m.at, excludeId: m.id, limit: 20 }).reverse()
    : []
  const aliases = new Map([['@bot', '助手']]),
    labels = new Map()
  let member = 0,
    quoted = 0
  const selfId = store.get('selfMember', m.group)
  if (selfId) aliases.set(selfId, '助手')
  const safeName = (name) => {
    const label = String(name || '').replace(/https?:\/\/\S+|[a-f0-9]{32,}/gi, '').replace(/[\x00-\x1f「」<>]/g, '').trim()
    return clipText(label, 48)
  }
  const peerLabel = (name) => safeName(name) ? '机器人「' + safeName(name) + '」' : '其他机器人'
  const observed = new Map()
  const identities = new Map()
  const person = id => {
    if (!id) return undefined
    if (!identities.has(id)) identities.set(id, 'p' + (identities.size + 1))
    return identities.get(id)
  }
  const alias = (id, hint) => {
    if (!id) return '未知成员'
    if (!aliases.has(id)) {
      const u = store.member(m.group, id)
      const v = observed.get(id) || hint
      const name = [u?.name,v?.name,u?.username,v?.username].filter(n => n && n !== id).map(safeName).find(Boolean)
      aliases.set(id, u?.bot || v?.bot ? peerLabel(name) : anonymous ? '成员' + ++member : name || '未提供昵称的群友')
    }
    return aliases.get(id)
  }
  const clean = (v, max) => clipText(
    String(v || '')
      .replace(/https?:\/\/[^\s<>]+/gi, '[链接]')
      .replace(/<@!?([\w-]+)>/g, (_, id) => '@' + alias(id))
      .replace(/\b[a-f0-9]{32,}\b/gi, '[标识]'),
    max,
  )
  for (const [i, v] of [...new Map([...rows, m, ...candidates].map(v => [v.id, v])).values()].entries()) {
    if (v.nickname || v.username || v.authorBot)
      observed.set(v.author, {name:v.nickname, username:v.username, bot:v.authorBot})
    for (const u of v.mentions || []) {
      if (u.self) aliases.set(u.id, '助手')
      else if (u.bot && u.id && !aliases.has(u.id) && u.name) aliases.set(u.id, peerLabel(u.name))
      if (!observed.has(u.id)) observed.set(u.id, u)
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
        speaker: alias(parent?.author, {name:parent?.nickname, username:parent?.username, bot:parent?.authorBot}),
        ...(!anonymous && parent?.author ? {speakerKey:person(parent.author)} : {}),
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
    ...(!anonymous && v.author ? {speakerKey:person(v.author)} : {}),
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
    ...(!anonymous ? {naming:'在群里用 speaker 或 mentions 中的群名片、昵称称呼人。speaker 是说话的人，mentions 是被提到的人。speakerKey 只供区分同名者。历史回复中的“成员1”等旧编号不代表当前身份；缺名字时依消息内容描述发言者。'} : {}),
    ...(candidates.length ? {candidates: candidates.map(v => describe(v, 360))} : {}),
    ...(run.reviewedAt ? {afterCooldown: 'current 是本轮选中的原话。history 中也有此后发生的对话，请结合后续进展回应这个重点。'} : {}),
    memeMode:pluginSettings(store,m.group).mode,
    ...(policy.mode === 'social' ? {
      replyProbability: policy.replyProbability,
      naturalReplySelected: selectedNaturalReply(policy, m),
    } : {}),
    assistantName: policy.nickname,
    otherBotsNamedHere: store.botsNamedIn(m.group, m.text || '')
      .filter((u) => aliases.get(u.id) !== '助手' && u.label !== policy.nickname)
      .map((u) => peerLabel(u.label)),
    history,
    current,
    quotes,
    quotedOutsideHistory: [...parents.values()].filter((v) => v.id.startsWith('q')),
    cards,
    addressedToBot: !!m.mention,
    mentionsAssistantName: !!(policy.nickname && m.text?.includes(policy.nickname)),
    waiting:
      !!run.waitingSource ||
      (!!waiting && waiting.until >= Date.parse(m.at) && m.refs?.includes(waiting.source)),
    quotedAssistant: anonymous ? quotes.some(q => q.speaker === '助手') :
      quotes.some(q => q.speakerKey && (q.speakerKey === person('@bot') || q.speakerKey === person(selfId))),
  }
  // Versioned local targets are never sent to the model.
  const images = new Map()
  if (!m.refs?.length && !current.attachments.length) {
    for (const row of rows) {
      if (row.at <= m.at && row.parts?.some(p => p.type === 'media' && p.mime?.startsWith('image/')))
        images.set(labels.get(row.id), row.id)
    }
  }
  if (images.size) state.historyImages = [...images.keys()]
  if (m.inferredRef && labels.has(m.inferredRef)) state.contextSource = labels.get(m.inferredRef)
  Object.defineProperty(state, 'imageSources', {value:images})
  Object.defineProperty(state, 'targets', {
    value: new Map(cards.flatMap((v, i) => (selected[i].daily ? [] : [[v.id, selected[i]]]))),
  })
  return state
}

export function bindHistoryImage(run, context, label) {
  const source = context.imageSources.get(label)
  if (!source || run.m.refs?.length) return false
  run.m = {...run.m, refs:[source], inferredRef:source}
  return true
}
