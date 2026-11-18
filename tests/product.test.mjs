import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { Store } from '../app/store.mjs'
import { normalize, resolve, key } from '../app/messages.mjs'
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
  r.enqueue('reply', 'g', 'req', '结果')
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
  assert.equal(sent.msg_seq, 1)
  assert.equal(sent.msg_id, 'get')
  assert.equal(s.get('out', 'reply').status, 'sent')
  assert.ok(m)
})
