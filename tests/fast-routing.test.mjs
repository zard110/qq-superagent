import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'
import { classify, routingContext } from '../app/fast-routing.mjs'

function setup(
  t,
  { engagement = 'requested', lane = 'quick', quick = '54 是车架尺码。', fail = false, memory = 'none' } = {},
) {
  const store = new Store(':memory:')
  t.after(() => store.db.close())
  const calls = []
  const context = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (url.endsWith('/systemone')) {
      calls.push('jev')
      context.push(body.state)
      assert.equal(body.questions.engagement.type, 'choice')
      if (fail) throw new DOMException('timeout', 'TimeoutError')
      return Response.json({
        answers: { engagement: { choice: engagement }, difficulty: { choice: lane }, memory: { choice: memory } },
      })
    }
    calls.push(body.model)
    if (body.model === 'small') assert.equal(body.tools, undefined)
    return Response.json({
      choices: [
        { message: { role: 'assistant', content: body.model === 'small' ? quick : '由负责模型回答' } },
      ],
    })
  })
  const config = {
    ...store.config(),
    groups: { g: { mode: 'social', nickname: '小搭' } },
    routes: { chat: 'openai' },
    vendors: {
      openai: { base: 'https://large.example/v1', model: 'large', key: 'one' },
      quick: { base: 'https://small.example/v1', model: 'small', key: 'two' },
      jev: {
        enabled: true,
        base: 'https://router.example/systemone',
        key: 'three',
        model: 'jev-latest',
      },
    },
  }
  store.put('config', 'main', config)
  const r = new Runtime(store, { reference: (m) => ({ parts: m.parts }), tools: () => [] })
  const event = (text, mention = true, extra = {}) =>
    r.receive(mention ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', {
      id: 'q',
      group_openid: 'g',
      author: { id: 'sender-id' },
      content: text,
      ...extra,
    })
  const run = () => store.get('run', key('g', 'q'))
  const process = () => r.process(run())
  return { calls, context, event, process, run, store }
}

test('快答走一次 Jev 和一次无工具的简单模型，重复事件不生成第二个回复', async (t) => {
  const a = setup(t)
  a.event('54码是什么意思')
  await a.process()
  a.event('54码是什么意思')
  assert.deepEqual(a.calls, ['jev', 'small'])
  assert.equal(a.store.all('out').length, 1)
  assert.equal(a.run().ticket, undefined)
  assert.equal(a.run().fast.lane, 'quick')
  assert.equal(a.run().executor, 'quick')
})
test('群友提出长期设定可以静默落卡并由后续发言按同一身份引用', async (t) => {
  const a = setup(t, { engagement: 'silent', memory: 'save' })
  a.event('青禾是我们的小组协调人', false)
  await a.process()
  assert.equal(a.run().fast.memoryStatus, 'active')
  assert.equal(a.store.all('out').length, 0)
  const m = {...a.run().m, id:'followup', text:'青禾是哪位？', refs:['q']}
  const state = routingContext(a.store, {m})
  assert.equal(state.cards[0].proposedBy[0],state.current.speaker)
  assert.equal(state.current.repliesTo[0],state.history[0].id)
  assert.equal(state.history[0].text,'青禾是我们的小组协调人')
  assert.ok(state.history[0].at.endsWith('+08:00'))
})
test('普通群聊静默，@ 的正常问题仍处理；明确要求安静省掉 Jev', async (t) => {
  const a = setup(t, { engagement: 'silent' })
  a.event('我在路上了', false)
  await a.process()
  assert.deepEqual(a.calls, ['jev'])
  assert.equal(a.store.all('out').length, 0)
  a.event('你先别说话', true, { id: 'quiet' })
  assert.equal(a.store.get('run', key('g', 'quiet')), undefined)
})
for (const [label, opts, mention, expected] of [
  ['空正文回退一次', { quick: '' }, true, ['jev', 'small', 'large']],
  ['快答要求转交', { quick: '[转交]' }, true, ['jev', 'small', 'large']],
  ['路由超时，直接提问走负责模型', { fail: true }, true, ['jev', 'large']],
  ['路由超时，普通群聊静默', { fail: true }, false, ['jev']],
  ['需要历史和工具的任务走负责模型', { lane: 'responsible' }, true, ['jev', 'large']],
  ['明确 @ 也采用 Jev 的语境判断', { engagement: 'silent' }, true, ['jev']],
])
  test(label, async (t) => {
    const a = setup(t, opts)
    a.event('请问，这个词怎么解释', mention)
    await a.process()
    assert.deepEqual(a.calls, expected)
    assert.equal(a.store.all('out').length, expected.length === 1 ? 0 : 1)
  })
test('Jev 在 TLS 握手前重置可重连，已发送的请求不重复', async t => {
  const reset = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {code:'ECONNRESET'})
  const request = () => classify({base:'https://router.example',key:'test',model:'jev'}, {})
  let calls = 0
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (++calls < 3) throw new TypeError('fetch failed', {cause:reset})
    return Response.json({answers:{engagement:{choice:'requested'},difficulty:{choice:'quick'}}})
  })
  const result = await request()
  assert.equal(result.jevAttempts, 3)
  assert.equal(result.lane, 'quick')
  fetch.mock.mockImplementation(async () => {
    throw new TypeError('fetch failed', {cause:Object.assign(new Error('socket hang up'), {code:'ECONNRESET'})})
  })
  await assert.rejects(request(), /fetch failed/)
  assert.equal(fetch.mock.callCount(), 4)
  fetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed', {cause:reset}) })
  await assert.rejects(request(), /连续三次未能建立连接/)
  assert.equal(fetch.mock.callCount(), 7)
})

test('同群其他机器人的普通和 @ 事件去重入历史，后续问题可区分两台机器人', async t => {
  const a = setup(t)
  const self = {id:'self-private', username:'小搭', bot:true, is_you:true}
  const peer = {id:'peer-private', username:'测试鳄', bot:true}
  a.event('你们看看', true, {id:'both', mentions:[self, peer]})
  const event = {id:'peer-speech', author:{id:peer.id}, mentions:[self]}
  a.event('这是我的观点', false, event)
  a.event('这是我的观点', true, event)
  a.event('自己的回声', false, {id:'echo', author:{id:self.id, bot:true}})
  assert.equal(a.store.get('run', key('g', event.id)), undefined)
  assert.equal(a.store.lookup('g','echo'), undefined)
  a.event('测试鳄刚刚怎么说的？', true, {message_scene:{ext:['ref_msg_idx=peer-speech']}})
  await a.process()
  const state = a.context[0]
  assert.deepEqual(state.history.find(m => m.text === '你们看看').mentions, ['助手','机器人「测试鳄」'])
  assert.equal(state.history.filter(m => m.speaker === '机器人「测试鳄」').length, 1)
  assert.equal(state.quotes[0].text, '这是我的观点')
  assert.equal(state.quotes[0].speaker, '机器人「测试鳄」')
  assert.deepEqual(state.otherBotsNamedHere, ['机器人「测试鳄」'])
  assert.doesNotMatch(JSON.stringify(state), /peer-private|self-private/)
  a.event('新机器人', false, {id:'new-bot', author:{id:'new-private', bot:true, username:'新搭'}})
  assert.equal(a.store.lookup('g','new-bot').authorBot, true)
})

test('第三方只获得同群二十条短消息、发言人代号和引用摘要', (t) => {
  const { store, event } = setup(t)
  for (let i = 0; i < 22; i++) {
    const id = 'old' + i
    store.message({
      group: 'g',
      id,
      idx: id,
      thread: 't',
      author: 'private-person',
      at: new Date(i * 1000).toISOString(),
      parts: [],
      refs: [],
      text: '文字' + i + ' https://example.org/test?sig=private-signature',
    })
  }
  store.message({
    group: 'x',
    id: 'other',
    idx: 'other',
    thread: 't',
    author: 'other',
    at: new Date(8000).toISOString(),
    parts: [],
    refs: [],
    text: 'other-group-secret',
  })
  const m = event('那个呢')
  m.refs = ['old0']
  const ctx = routingContext(store, { m }, {})
  assert.equal(ctx.history.length, 20)
  assert.match(ctx.history[0].text, /文字2/)
  assert.match(ctx.quotes[0].text, /文字0/)
  assert.doesNotMatch(JSON.stringify(ctx), /private-|other-group|sender-id/)
})

test('Jev 判为快答时，带附件的消息仍交给负责模型', async t => {
  const a = setup(t)
  a.event('你看看',true,{attachments:[{content_type:'image/png',url:'https://example.org/p?sig=secret'}]})
  await a.process()
  assert.deepEqual(a.calls,['jev','large'])
  assert.deepEqual(a.context[0].current.attachments,['image/png'])
  assert.doesNotMatch(JSON.stringify(a.context),/sig=secret/)
})

test('主动介入遵守群冷却时间；失败后恢复的任务不会再次请求 Jev', async t => {
  const a = setup(t,{engagement:'proactive'})
  a.store.put('lastSpeech','g',Date.now())
  a.event('大家聊聊',false)
  await a.process()
  assert.deepEqual(a.calls,['jev'])
  assert.equal(a.run().state,'ignored')
  a.event('请回答',true,{id:'resumed'})
  const id=key('g','resumed')
  const run=a.store.get('run',id)
  run.fast={lane:'classifying',started:Date.now()}
  const r=new Runtime(a.store,{reference:m=>({parts:m.parts}),tools:()=>[]})
  await r.process(run)
  assert.deepEqual(a.calls,['jev','large'])
  assert.equal(a.store.all('out').length,1)
})
