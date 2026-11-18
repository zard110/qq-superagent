import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { Store } from '../app/store.mjs'
import { normalize, resolve, key, replyMentions } from '../app/messages.mjs'
import { Capabilities, Pending } from '../app/capabilities.mjs'
import { Runtime } from '../app/runtime.mjs'
import { QQ } from '../app/qq.mjs'
import { publicFile } from '../app/network.mjs'

const at = '2020-01-01T05:00:00Z',
  mention = 'GROUP_AT_MESSAGE_CREATE',
  all = 'GROUP_MESSAGE_CREATE'
function event(id, group, text, author = 'a', extra = {}) {
  return {
    id,
    group_openid: group,
    content: text,
    timestamp: at,
    author: { member_openid: author },
    message_scene: { ext: ['msg_idx=idx-' + id] },
    ...extra,
  }
}
function fixture(t, model) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-studio-')),
    db = join(dir, 'demo.sqlite')
  let s
  function open() {
    s = new Store(db)
    const c = new Capabilities(s, dir),
      r = new Runtime(s, c, { model })
    return { s, c, r }
  }
  const initial = open()
  s.put('config', 'main', { ...s.config(), providers: { chat: { base: 'http://unused', model: 'test' } } })
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    ...initial,
    restart() {
      s.db.close()
      return open()
    },
  }
}
const call = (name, args, id) => ({
  role: 'assistant',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const say = (text) => ({ role: 'assistant', content: text })
test('回复艾特我绑定发信人，模型照抄的机器人标签不会发到群里', async (t) => {
  let context
  const f = fixture(t, async (_p, dialog) => {
    context = JSON.parse(dialog.find((msg) => msg.role === 'user').content)
    return say('<@robot> 收到。')
  })
  const m = f.r.receive(
    all,
    event('reply-me', 'g', '<@robot> 回我的时候要艾特我', 'user', {
      timestamp: new Date().toISOString(),
      author: { member_openid: 'user', member_nickname: '群主', member_role: 'owner' },
      mentions: [
        { member_openid: 'robot', is_you: true },
        { member_openid: 'friend', member_nickname: '小周' },
      ],
    }),
  )
  await f.r.process(f.s.get('run', key('g', 'reply-me')))
  assert.deepEqual(context.sender, { id: 'user', name: '群主', role: 'owner' })
  assert.equal(context.mentions[0].self, true)
  assert.equal(context.mentions[1].name, '小周')
  assert.equal(context.addressedToBot, true)
  assert.equal(f.s.nextDelivery().text, '<@user> 收到。')
  assert.equal(replyMentions('<@sender> 知道了', { ...m, text: '请不要艾特我' }, f.s), '知道了')
  assert.equal(replyMentions('我看一下', { ...m, text: '今天谁艾特我了？' }, f.s), '我看一下')
  assert.equal(replyMentions('<@friend> 好', { ...m, text: '帮我艾特小周' }, f.s), '<@friend> 好')
  assert.equal(replyMentions('<@elsewhere> 好', m, f.s), '<@user> 好')
})
test('首次分页建群成员缓存，重启后本地查；保留同名成员并更新群昵称', async (t) => {
  const f = fixture(t)
  const qq = new QQ(f.r)
  let requests = 0
  qq.request = async (path) => {
    requests++
    if (path.endsWith('?cursor=a%2Bb')) return { members: [{ member_openid: 'b', username: '小杨' }] }
    return { members: [{ member_openid: 'a', username: '小杨' }], next_cursor: 'a+b' }
  }
  await Promise.all([qq.directory('g'), qq.directory('g')])
  assert.equal(requests, 2)
  const second = f.restart()
  const resumed = new QQ(second.r)
  resumed.request = () => {
    throw Error('缓存命中不应访问网络')
  }
  const lookup = (query) => resumed.groupInfo('g', { topic: 'member', query })
  assert.equal((await lookup('小杨')).data.matches.length, 2)
  assert.equal((await resumed.groupInfo('g', { topic: 'members', cursor: 'a+b' })).data.members[0].id, 'b')
  second.r.receive(
    all,
    event('id', 'g', '在', 'a', {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      author: { member_openid: 'a', member_nickname: '大杨', username: '小杨' },
    }),
  )
  assert.equal((await lookup('大杨')).data.matches[0].id, 'a')
  assert.equal(second.s.member('other', 'a'), undefined)
})
test('历史按北京时间检索，统计本群发言者并忽略投递副本', async (t) => {
  const { s, c, r } = fixture(t)
  const at = '2026-11-18T00:05:00+08:00'
  const m = r.receive(
    all,
    event('past', 'g', '预算草案', 'a', {
      timestamp: at,
      author: { member_openid: 'a', member_nickname: '小杨' },
    }),
  )
  r.receive(all, event('elsewhere', 'else', '不属于本群', 'other', { timestamp: at }))
  const reply = {
    ...m,
    id: 'reply',
    idx: 'reply',
    author: '@bot',
    parts: [{ type: 'text', text: '收到', source: 'reply' }],
  }
  s.message(reply)
  s.message({ ...reply, id: 'remote-copy', idx: 'remote-idx' })
  const now = r.receive(mention, event('now', 'g', '谁发过言', 'b', { timestamp: at }))
  const query = (args) => c.run('searchHistory', args, { m: now, config: s.config() })
  const one = await query({ author: '小杨', from: '2026-11-18', until: '2026-11-18' })
  assert.deepEqual(
    one.data.map((v) => v.id),
    ['past'],
  )
  assert.equal(one.data[0].at, '2026-11-18T00:05:00.000+08:00')
  assert.equal(one.memberHistory.messages, 2)
  assert.equal(one.memberHistory.speakers, 2)
  assert.equal((await query({ until: '2026-11-17' })).data.length, 0)
  assert.equal((await query({})).data.length, 2)
  assert.equal(s.lookup('g', 'remote-idx').id, 'remote-copy')
})
test('官方群信息按当前群查询，区别群总人数、全量模式和名单未获授权', async (t) => {
  const { s, c, r } = fixture(t)
  const qq = new QQ(r)
  const ctx = { m: { group: 'g' }, config: s.config() }
  const query = (topic, cursor) => c.run('getGroupInfo', { topic, cursor }, ctx)
  qq.request = async (path) => {
    if (path === '/v2/groups/g/info') return { group_member_num: 3, group_name: '测试群' }
    if (path === '/v2/groups/g/bot_state') return { recv_msg_setting: 'all' }
    throw Object.assign(Error('未授权'), { code: 11253 })
  }
  assert.equal((await query('info')).data.memberCount, 3)
  assert.equal((await query('bot_state')).data.messageScope, 'all')
  assert.equal((await query('members')).status, 'restricted')
  qq.request = () => {
    throw Error('不应重复查询已知权限')
  }
  assert.equal((await query('members')).status, 'restricted')
})
test('群成员有哪些：缓存名单受限时列出本群已知身份，学到第三位后立即可见', async (t) => {
  const { s, r } = fixture(t, () => {
    throw Error('名册问答不应猜测身份')
  })
  const qq = new QQ(r)
  let calls = 0
  qq.request = async (path) => {
    calls++
    if (path.endsWith('/info')) return { group_member_num: 3, group_name: '测试' }
    throw Object.assign(Error('名单未获授权'), { code: 11253 })
  }
  s.rememberMember('g', { id: 'bot', name: '小搭', bot: true }, at)
  s.rememberMember('other', { id: 'z', name: '他群的人' }, at)
  async function ask(id, mentions = []) {
    const m = r.receive(
      mention,
      event(id, 'g', '<@bot> 群成员有哪些？', 'a', {
        author: { member_openid: 'a', member_nickname: 'FTP', member_role: 'owner' },
        mentions,
      }),
    )
    const run = s.get('run', key('g', m.id))
    await r.process(run)
    return s.get('run', run.id).answer
  }
  const partial = await ask('one')
  assert.match(partial, /3 位成员/)
  assert.match(partial, /FTP（群主）/)
  assert.match(partial, /小搭（机器人）/)
  assert.match(partial, /1 位未对应/)
  assert.doesNotMatch(partial, /11253|QQ 号|他群的人/)
  const completeObserved = await ask('two', [{ member_openid: 'c', member_nickname: '小林' }])
  assert.match(completeObserved, /小林/)
  assert.doesNotMatch(completeObserved, /未对应/)
  assert.equal(calls, 2)
})
test('QQ 嵌套引用、聊天记录、卡片与附件可组合，历史检索严格按群和日期', (t) => {
  const { s, r, c } = fixture(t)
  const nested = {
    msg_elements: [
      {
        message_type: 103,
        msg_elements: [
          { message_type: 102, msg_elements: [{ content: '最后定了 A3，报名到周五', msg_idx: 'quote' }] },
          {
            message_type: 3,
            ark_data: {
              fields: { title: '知乎讨论', jump_url: 'https://www.zhihu.com/question/100', desc: '卡片摘要' },
            },
          },
          {
            attachments: [
              { url: 'https://example.org/a.jpg', content_type: 'image/jpeg' },
              { url: 'https://example.org/v.mp4', content_type: 'video/mp4' },
            ],
          },
        ],
      },
    ],
  }
  r.receive(all, event('one', 'g', '活动', 'a', nested))
  r.receive(all, event('one', 'other', '另一个群的私有结论'))
  const m = normalize(
    mention,
    event('two', 'g', '哪天截止？', 'a', { message_scene: { ext: ['ref_msg_idx=idx-one'] } }),
  )
  const ref = c.reference(m)
  assert.equal(ref.parts.find((p) => p.source === 'quote').text, '最后定了 A3，报名到周五')
  assert.equal(ref.parts.find((p) => p.type === 'card').title, '知乎讨论')
  assert.equal(ref.parts.filter((p) => p.type === 'media').length, 2)
  assert.ok(!JSON.stringify(ref).includes('a.jpg'))
  assert.deepEqual(resolve(s, { ...m, refs: ['lost'] }).missing, ['lost'])
  assert.equal(s.history('g', { from: '2027' }).length, 0)
  assert.equal(s.history('other', { keyword: '私有' }).length, 1)
  assert.equal(s.history('g', { keyword: '私有' }).length, 0)
})
test('真实 Engine 持久化双任务，重启续办、重复事件、引用助手回复均不串线', async (t) => {
  const f = fixture(t, async () => say('已分析，预算在 00:18。'))
  for (const [id, author] of [
    ['one', 'a'],
    ['two', 'b'],
  ]) {
    f.r.receive(mention, event(id, 'group', '请分析视频 ' + id, author))
    const run = f.s.get('run', key('group', id))
    await f.r.process(run)
    assert.equal(f.s.get('run', run.id).state, 'done')
  }
  assert.equal(f.s.tickets.list().length, 2)
  const { s, r } = f.restart(),
    out = key(key('group', 'two'), 'reply')
  const m = r.receive(
    mention,
    event('three', 'group', '只看后半段', 'b', { message_scene: { ext: ['ref_msg_idx=' + out] } }),
  )
  assert.equal(m.thread, s.lookup('group', 'two').thread)
  const run = s.get('run', key('group', 'three'))
  await r.process(run)
  assert.equal(s.get('run', run.id).ticket, s.get('run', key('group', 'two')).ticket)
  assert.notEqual(s.get('run', run.id).ticket, s.get('run', key('group', 'one')).ticket)
  assert.equal(r.receive(mention, event('three', 'group', '只看后半段', 'b')), undefined)
  assert.equal(s.all('out').length, 3)
})
test('挂起的生成工具跨重启恢复同一请求，产物进入媒体出站记录', async (t) => {
  const f = fixture(t, async (p, d) =>
    d.at(-1).role === 'tool' ? say('已完成横版') : call('generateImage', { prompt: '横版' }, 'img1'),
  )
  const config = f.s.config()
  config.providers.image = { base: 'https://fixture.test', model: 'create' }
  f.s.put('config', 'main', config)
  let starts = 0,
    polls = 0
  const remoteState = new Map()
  function install(c) {
    c.generate = async (ctx) => {
      const id = key(ctx.m.id, ctx.callId)
      if (!remoteState.has(id)) {
        starts++
        remoteState.set(id, 'running')
        throw new Pending()
      }
      polls++
      return { artifact: c.save(ctx.m.group, 'image/png', Buffer.from('fixture')) }
    }
  }
  install(f.c)
  f.r.receive(mention, event('poster', 'g', '生成横版海报'))
  const id = key('g', 'poster')
  await f.r.process(f.s.get('run', id))
  assert.equal(f.s.get('run', id).state, 'running')
  const { s, c, r } = f.restart()
  install(c)
  await r.process(s.get('run', id))
  assert.equal(s.get('run', id).state, 'done')
  assert.equal(starts, 1)
  assert.equal(polls, 1)
  const [output] = s.all('out').filter((v) => v.artifact)
  assert.equal((await c.file('g', output.artifact)).bytes.toString(), 'fixture')
  await assert.rejects(c.file('other', output.artifact))
})
test('网页部分可读时返回卡片摘要；阻止本地地址和跨群资源', async (t) => {
  const { s, c } = fixture(t),
    url = 'http://127.0.0.1/private'
  const m = normalize(
    mention,
    event('card', 'g', '说法靠谱吗', 'a', {
      ark_data: { fields: { title: '文章', desc: '已知摘要', jump_url: url } },
    }),
  )
  const result = await c.run('readWebPage', { url }, { m, config: s.config() })
  assert.equal(result.status, 'partial')
  assert.equal(result.data.card.summary, '已知摘要')
  await assert.rejects(publicFile('http://[::1]/'))
})
test('实际 HTTP 搜索适配、站点约束、引用素材识别和多模态供应商调用', async (t) => {
  let last
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    last = JSON.parse(raw)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url === '/search'
          ? { results: [{ title: '公告', url: 'https://example.org/news', content: '今日变动' }] }
          : { choices: [{ message: say('海报截止周五') }] },
      ),
    )
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  t.after(() => server.close())
  const { s, c } = fixture(t),
    base = 'http://127.0.0.1:' + server.address().port
  const config = {
    ...s.config(),
    providers: { vision: { base, model: 'vision' }, search: { base: base + '/search' } },
  }
  const m = normalize(mention, event('now', 'g', '有官方来源吗？'))
  const result = await c.run(
    'searchWeb',
    { query: '公开公告', domain: 'example.org', timeRange: 'week' },
    { m, config },
  )
  assert.deepEqual(result.sources, ['https://example.org/news'])
  assert.deepEqual(last.include_domains, ['example.org'])
  assert.equal(last.time_range, 'week')
  const id = c.save('g', 'image/png', Buffer.from('png'))
  const answer = await c.run('analyzeMedia', { question: '报名日期', resource: id }, { m, config })
  assert.equal(answer.data.answer, '海报截止周五')
  assert.ok(last.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'))
})
test('QQ 投递超时转待领取；只有原群原成员可取，文本与产物分别发送', async (t) => {
  const { s, r } = fixture(t, async () => say('完成'))
  const config = s.config()
  config.qq = { appId: 'test' }
  s.put('config', 'main', config)
  const m = r.receive(mention, event('req', 'g', '测试'))
  const formatted = '能帮你做这些事：\n\n1. **查资料**：搜索网页\n2. **看图片**：识别文字'
  r.enqueue('reply', 'g', 'req', formatted)
  const qq = new QQ(r)
  await qq.flush()
  assert.equal(s.get('out', 'reply').status, 'held')
  r.receive(mention, event('steal', 'g', '领取结果', 'b'))
  assert.equal(s.get('out', 'reply').status, 'held')
  r.receive(mention, event('get', 'g', '领取结果', 'a', { timestamp: new Date().toISOString() }))
  assert.equal(s.get('out', 'reply').origin, 'get')
  let sent
  qq.request = async (path, b) => {
    sent = b
    return { id: 'remote' }
  }
  await qq.flush()
  assert.deepEqual(sent, { msg_type: 2, markdown: { content: formatted }, msg_id: 'get', msg_seq: 1 })
  assert.equal(s.get('out', 'reply').status, 'sent')
  assert.ok(m)
})
