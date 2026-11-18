import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../app/store.mjs'
import { Capabilities } from '../app/capabilities.mjs'
import { MemoryArchive, recentMemory, searchMemory } from '../app/memory.mjs'
import { key } from '../app/messages.mjs'
import { Runtime } from '../app/runtime.mjs'
import { decideConversation } from '../app/conversation.mjs'

test('自然模式在冷却中仍分派未 @ 的剧本续办，主动闲聊保持安静', async (t) => {
  const { dir, store, config } = fixture(t)
  config.groups.g = { mode: 'social', cooldown: 3600, code: true }
  store.put('config', 'main', config)
  const caps = new Capabilities(store, join(dir, 'assets'))
  let route = { action: 'continue', candidate: 0, goal: 'document', requiresFile: true }
  const app = new Runtime(store, caps, {
    model: async (_p, dialog) => {
      assert.match(dialog[0].content, /判断本条群消息的意图/)
      return { content: JSON.stringify(route) }
    },
  })
  const jobs = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).endsWith('/group/status')) return Response.json({ state: 'missing' })
    assert.ok(String(url).endsWith('/group'))
    jobs.push(JSON.parse(opts.body))
    return Response.json({ state: 'running', progress: { at: Date.now() } })
  })
  const prior = message('g', 'draft', Date.now() - 30000, '整理剧本')
  store.put('run', 'draft', {
    id: 'draft',
    m: prior,
    ticket: 'prior-ticket',
    executor: 'harness',
    state: 'done',
    answer: '已有稿件',
  })
  store.put('lastSpeech', 'g', Date.now())
  async function send(id, content) {
    app.receive('GROUP_MESSAGE_CREATE', { id, group_openid: 'g', author: { id: prior.author }, content })
    const run = store.get('run', key('g', id))
    assert.ok(run)
    await app.process({ ...run, executor: 'harness' })
    return store.get('run', run.id)
  }
  const run = await send('revise', '整理一下我刚刚发的脚本，重新发一个完整的')
  assert.equal(run.state, 'running')
  assert.equal(run.engagement, 'requested')
  assert.equal(jobs[0].ticket, key('g', 'prior-ticket'))
  assert.equal(jobs[0].requiresFile, true)
  route = { action: 'chat', goal: 'answer', participation: 'silent' }
  assert.equal((await send('aside', '他今天在群里找照片')).state, 'ignored')
  assert.equal(jobs.length, 1)
  config.groups.g.code = false
  store.put('config', 'main', config)
  route = { action: 'new', goal: 'document' }
  const disabled = await send('disabled', '帮我整理新版')
  assert.match(disabled.answer, /本群未开启/)
  assert.equal(jobs.length, 1)
})

const message = (group, id, at, text, author = '甲') => ({
  group,
  id,
  idx: id,
  at: new Date(at).toISOString(),
  text,
  author,
  thread: id,
  parts: [{ type: 'text', source: id, text }],
  refs: [],
})
test('长转发分段延续同一原消息，末段寒暄不清空已有记忆', async (t) => {
  const { dir, store } = fixture(t)
  const m = message('g', 'forward', '2026-11-18T16:30:00+08:00', '转发记录')
  for (let i = 0; i < 6; i++) m.parts.push({ type: 'text', text: String(i).repeat(10000), source: m.id })
  store.message(m)
  let calls = 0
  const archive = new MemoryArchive(store, dir, async (_, d) => {
    const { messages } = JSON.parse(d[1].content)
    assert.ok(JSON.stringify(messages).length < 24500)
    calls++
    return {
      content: JSON.stringify({
        entries:
          calls === 1
            ? [{ kind: '话题', topic: '例会', text: '讨论例会时间', sources: [messages[0].id] }]
            : [],
      }),
    }
  })
  await archive.tick(Date.parse('2026-11-19T01:00:00+08:00'))
  assert.ok(calls > 1)
  assert.equal(store.get('memoryJob', 'g').count, 1)
  assert.equal(searchMemory(store, 'g')[0].sources[0].id, 'forward')
})
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'group-memory-'))
  const store = new Store(join(dir, 'bot.sqlite'))
  const config = { ...store.config(), providers: { chat: { model: 'test', base: 'http://unused' } } }
  store.put('config', 'main', config)
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store, config }
}
test('北京时间跨日和 01:00 边界；分段失败重启仅重做失败段，隔离群和原话', async (t) => {
  const { dir, store, config } = fixture(t)
  const before = Date.parse('2026-11-19T00:59:59+08:00'),
    due = before + 1000
  const put = (...args) => store.message(message(...args))
  put('a', 'too-early', '2026-11-17T23:59:59+08:00', '过期')
  for (let i = 0; i < 42; i++)
    put('a', 'a' + i, '2026-11-18T00:00:00+08:00', i === 41 ? '建议周五交付' : '闲聊')
  put('a', 'a-end', '2026-11-18T23:59:59.999+08:00', '我来跟进', '@bot')
  const duplicate = store.lookup('a', 'a-end')
  store.message({ ...duplicate, id: 'QQ-copy' })
  put('a', 'today', '2026-11-19T00:00:00+08:00', '今天改期，交付改为周一')
  put('b', 'private', '2026-11-18T13:00:00+08:00', '乙群的方案')
  let fail = true
  const calls = []
  const summarize = async (_, d) => {
    const { messages, previous } = JSON.parse(d[1].content)
    calls.push(messages.map((m) => m.text))
    if (fail && messages.some((m) => m.text === '建议周五交付')) throw Error('供应商离线')
    const entries = messages
      .filter((m) => m.text !== '闲聊')
      .map((m) => ({ kind: '建议', topic: '交付', text: m.text, sources: [m.id] }))
    return { content: JSON.stringify({ entries: [...previous, ...entries] }) }
  }
  const archive = new MemoryArchive(store, dir, summarize)
  await archive.tick(before)
  assert.equal(calls.length, 0)
  await Promise.all([archive.tick(due), archive.tick(due)])
  assert.equal(store.get('memoryJob', 'a').count, 40)
  assert.equal(store.get('memoryJob', 'a').status, '等待重试')
  assert.equal(store.get('memoryJob', 'b').count, 1)
  fail = false
  const freshStore = new Store(join(dir, 'bot.sqlite'))
  try {
    const restarted = new MemoryArchive(freshStore, dir, summarize)
    await restarted.tick(due + 61000)
    await restarted.tick(due + 62000)
    assert.equal(freshStore.get('memoryJob', 'a').count, 43)
    assert.equal(calls.filter((rows) => rows.length === 40).length, 1)
    const md = readFileSync(join(dir, key('a'), '2026-11-18.md'), 'utf8')
    assert.match(md, /建议.*周五/)
    assert.match(md, /2026-11-18T23:59:59.999\+08:00/)
    assert.doesNotMatch(md, /过期|乙群|今天改期|QQ-copy/)
    assert.deepEqual(readdirSync(join(dir, key('a'))), ['2026-11-18.md'])
    const m = store.lookup('a', 'today')
    const caps = new Capabilities(store, join(dir, 'assets'))
    const recalled = await caps.run(
      'searchGroupMemory',
      { keyword: '交付', from: '2026-11-18', until: '2026-11-18' },
      { m, config },
    )
    assert.ok(
      recalled.data.some((i) => i.quotes.some((q) => q.text === '建议周五交付' && q.id === 'a41')),
    )
    const follow = message('a', 'new', '2026-11-19T10:00:00+08:00', '昨天交付怎么定的，现在改了吗？')
    const app = new Runtime(store, caps, {
      model: async (_p, dialog) => {
        const question = JSON.parse(dialog[1].content)
        assert.match(question.groupMemory, /建议周五交付/)
        assert.doesNotMatch(question.groupMemory, /乙群/)
        if (dialog.at(-1).role !== 'tool')
          return {
            role: 'assistant',
            tool_calls: [
              { id: 'lookup', function: { name: 'searchGroupMemory', arguments: '{"keyword":"交付"}' } },
            ],
          }
        const matches = JSON.parse(dialog.at(-1).content).data
        assert.ok(matches.some((i) => i.laterMentions.some((q) => q.id === 'today')))
        return { role: 'assistant', content: '昨天建议周五，今天改为周一。' }
      },
    })
    await app.process({ id: key('a', 'new'), m: follow, executor: 'capability' })
    assert.match(store.get('run', key('a', 'new')).answer, /周一/)
    assert.equal(
      (await caps.run('searchHistory', { messageId: 'private' }, { m, config })).data.length,
      0,
    )
    assert.match(recentMemory(store, m), /建议周五交付/)
    assert.doesNotMatch(recentMemory(store, m), /乙群/)
    assert.equal(recentMemory(store, { ...m, at: '2026-11-22T10:00:00Z' }), '')
    config.groups.a = { disabled: ['searchHistory'] }
    store.put('config', 'main', config)
    assert.equal(recentMemory(store, m), '')
    assert.throws(() => searchMemory(store, 'a'), /关闭/)
    await restarted.tick(due + 86400000)
    assert.equal(store.get('memoryJob', 'a').status, '已关闭')
    assert.equal(store.get('memoryJob', 'b').status, '当日无消息')
    assert.deepEqual(
      store.all('out').map((o) => o.origin),
      ['new'],
    )
  } finally {
    freshStore.db.close()
  }
})
test('索引缺失但 QQ 自带引用正文时直接解释；正文缺失时只询问该引用', async (t) => {
  const { dir, store } = fixture(t),
    caps = new Capabilities(store, join(dir, 'assets'))
  const model = async (_, dialog) => {
    const input = JSON.parse(dialog[1].content)
    assert.equal(input.question.trim(), '什么意思')
    assert.ok(input.current.parts.some((p) => p.text?.includes('request failed (422)')))
    assert.doesNotMatch(JSON.stringify(input), /无关照片任务/)
    return { content: '这条回复表明模型服务拒绝了请求，现有信息不足以确定哪个字段有问题。' }
  }
  const app = new Runtime(store, caps, { model })
  const older = message('g', 'old', Date.now() - 20000, '无关照片任务')
  store.put('run', 'old', { id: 'old', m: older, state: 'done' })
  const m = app.receive('GROUP_AT_MESSAGE_CREATE', {
    id: 'current',
    group_openid: 'g',
    author: { id: 'me' },
    content: '什么意思',
    msg_elements: [
      {
        message_type: 103,
        msg_idx: 'missing-index',
        msg_elements: [{ content: 'DeepSeek Messages request failed (422)' }],
      },
    ],
  })
  const run = { id: key('g', 'current'), executor: 'harness', m }
  await app.process(run)
  const saved = store.get('run', run.id)
  assert.equal(saved.route.action, 'chat')
  assert.equal(saved.state, 'done')
  assert.match(saved.answer, /拒绝/)
  const missing = await decideConversation(app, { m: { ...m, parts: [] }, id: 'new' })
  assert.equal(missing.action, 'clarify')
  assert.match(missing.question, /重发/)
})
