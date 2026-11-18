import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities } from '../app/capabilities.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'
import { sharedArticle, inspectArticle } from '../app/articles.mjs'
import { parseDocument } from '../app/network.mjs'

test('模型搜索后遗漏阅读时由运行时打开结果，避免反复催促失败', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-read-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  s.put('config', 'main', {
    ...s.config(),
    providers: { chat: { base: 'http://unused', model: 'fixture' } },
  })
  let calls = 0,
    reads = 0
  c.register({
    ...c.registry.get('searchWeb'),
    execute: () => ({ status: 'ok', data: [{ url: 'https://example.org/source' }] }),
  })
  c.register({
    ...c.registry.get('readWebPage'),
    execute: (args) => {
      reads++
      assert.equal(args.url, 'https://example.org/source')
      return { status: 'read', sources: [args.url], data: { text: '已读取原文' } }
    },
  })
  const r = new Runtime(s, c, {
    model: async () =>
      calls++ === 0
        ? {
            role: 'assistant',
            tool_calls: [
              {
                id: 's',
                type: 'function',
                function: { name: 'searchWeb', arguments: '{"query":"公开消息"}' },
              },
            ],
          }
        : { role: 'assistant', content: '回答' },
  })
  const m = r.receive('GROUP_AT_MESSAGE_CREATE', {
    id: 'q',
    group_openid: 'g',
    author: { id: 'u' },
    content: '搜一下最新消息',
  })
  await r.process(s.get('run', key('g', m.id)))
  assert.equal(s.get('run', key('g', m.id)).state, 'done')
  assert.equal(reads, 1)
  assert.equal(calls, 3)
})

test('知乎问题的搜索结果为多个回答时，先访问同一问题页面', async () => {
  const calls = []
  const e = await inspectArticle({ title: '如何评价WorkBuddy？', site: '知乎' }, async (name, args) => {
    calls.push([name, args.url])
    if (name === 'searchWeb')
      return {
        data: [
          {
            title: '如何评价WorkBuddy？ - 甲 的回答',
            url: 'https://www.zhihu.com/question/123/answer/456',
            indexedText: '甲的公开回答索引',
          },
          {
            title: '如何评价WorkBuddy？ - 乙 的回答',
            url: 'https://www.zhihu.com/question/123/answer/789',
          },
        ],
      }
    return { status: 'restricted', data: { detail: '登录页' } }
  })
  assert.equal(e.url, 'https://www.zhihu.com/question/123')
  assert.equal(calls[1][0], 'readWebPage')
  assert.equal(e.author, undefined)
  assert.equal(calls[2][1], 'https://www.zhihu.com/question/123/answer/456')
  assert.equal(e.relatedAnswers[0].coverage, '搜索索引中的回答')
  assert.equal(e.relatedAnswers[0].text, '甲的公开回答索引')
})

test('未引用的上一条小红书：只关联本群，保留原分享参数供直读，区分配图和推荐', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-social-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir),
    r = new Runtime(s, c)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const url = 'https://www.xiaohongshu.com/discovery/item/6aeaa745000000001503d0f9'
  const full = url + '?xsec_token=private-share'
  const card = {
    id: 'card',
    group_openid: 'g',
    author: { id: 'a' },
    content: '[卡片消息] 图文H5\ntag: 小红书\ntitle: #泡芙\njump_url: ' + full,
    ark_data: { fields: { title: '#泡芙', tag: '小红书', jump_url: full } },
  }
  r.receive('GROUP_MESSAGE_CREATE', card)
  r.receive('GROUP_MESSAGE_CREATE', { ...card, group_openid: 'other', id: 'unrelated' })
  s.put('config', 'main', { ...s.config(), groups: { g: { mode: 'social' } } })
  s.put('lastSpeech', 'g', Date.now())
  const followup = r.receive('GROUP_MESSAGE_CREATE', {
    id: 'summary',
    group_openid: 'g',
    author: { id: 'a' },
    content: '说了啥？',
  })
  assert.deepEqual(followup.refs, ['card'])
  assert.equal(s.get('run', key('g', 'summary')).state, 'queued')
  const m = r.receive('GROUP_AT_MESSAGE_CREATE', {
    id: 'q',
    group_openid: 'g',
    author: { id: 'b' },
    content: '看看上面的小红书',
  })
  assert.deepEqual(m.refs, ['card'])
  const ref = c.reference(m)
  assert.ok(!JSON.stringify(ref).includes('private-share'))
  assert.equal(s.get('shareLink', key('g', url)).url, full)
  const html =
    '<title>#泡芙 - rednote</title><meta property="og:image" content="https://example.org/1.jpg"><div class="author-detail"><span class="author-username">泡芙.</span></div><div class="author-desc-content">#泡芙</div><aside>别人的笔记</aside>'
  const page = parseDocument(
    html.replace('<aside>别人的笔记</aside>', '<div>作者的其他热门笔记</div>'),
    'https://www.rednote.com/discovery/item/6aeaa745000000001503d0f9',
  )
  assert.equal(page.author, '泡芙.')
  assert.equal(page.text, '#泡芙')
  assert.equal(page.images.length, 1)
  assert.equal(
    parseDocument(
      '<title>Log in - rednote</title><main>Welcome</main>',
      'https://www.xiaohongshu.com/login',
    ).status,
    'restricted',
  )
})

test('重放只有标题和预览图的小程序卡片：精确搜原站并读匹配页，正文受限也交付结果', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-mini-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  s.put('config', 'main', {
    ...s.config(),
    providers: { chat: { base: 'http://unused', model: 'fixture' } },
  })
  const url = 'https://zhuanlan.zhihu.com/p/123',
    title = '同名示例',
    calls = []
  for (const [name, fn] of Object.entries({
    searchWeb: (args) => {
      assert.equal(args.domain, 'zhihu.com')
      assert.equal(args.includeContent, true)
      return {
        status: 'ok',
        data: [
          { title, url: 'https://other.test/post', snippet: '作者：错误的人' },
          { title, url, indexedText: '# 同名示例\n\n文章内容。' },
        ],
      }
    },
    readWebPage: (args) => {
      assert.equal(args.url, url)
      return { status: 'partial', data: { detail: 'HTTP 404' }, sources: [url] }
    },
  }))
    c.register({
      ...c.registry.get(name),
      execute: (args) => {
        calls.push(name)
        return fn(args)
      },
    })
  const r = new Runtime(s, c, {
    model: () => {
      throw Error('纯来源问题无需模型猜测署名')
    },
  })
  const msg = r.receive('GROUP_AT_MESSAGE_CREATE', {
    id: 'ask',
    group_openid: 'g',
    content: '这是哪个网站的文章，作者是谁',
    author: { id: 'u' },
    msg_elements: [
      {
        message_type: 103,
        msg_elements: [
          {
            content:
              '[卡片消息] 小程序\nsource: 知乎\ntitle: 同名示例\npreview: https://cdn.test/cover.png',
            ark_data: { fields: { title } },
          },
        ],
      },
    ],
  })
  const id = key('g', msg.id)
  await r.process(s.get('run', id))
  const done = s.get('run', id)
  assert.equal(done.state, 'done')
  assert.match(done.answer, /来源是知乎/)
  assert.ok(done.answer.includes(url))
  assert.match(done.answer, /索引中的正文/)
  assert.match(done.answer, /没有可核实的作者/)
  assert.deepEqual(calls, ['searchWeb', 'readWebPage'])
})
test('优先读卡片自带的文章 URL；同标题多个候选不猜链接', async () => {
  const card = sharedArticle({
    parts: [{ type: 'card', title: '文章', site: '知乎', url: 'https://zhuanlan.zhihu.com/p/123' }],
  })
  const evidence = await inspectArticle(card, async (name, args) => {
    assert.equal(name, 'readWebPage')
    assert.equal(args.url, card.url)
    return { status: 'read', data: { text: '正文', author: '小林' } }
  })
  assert.equal(evidence.author, '小林')
  assert.equal(evidence.coverage, '原文网页')
  const ambiguous = await inspectArticle({ ...card, url: undefined }, async (name) => {
    assert.equal(name, 'searchWeb')
    return {
      data: [
        { title: '文章', url: 'https://zhuanlan.zhihu.com/p/1' },
        { title: '文章', url: 'https://zhuanlan.zhihu.com/p/2' },
      ],
    }
  })
  assert.equal(ambiguous.url, undefined)
})

test('知乎卡片摘要与独立来源分开，模型遗漏检索时先补证，普通 @ 追问沿用本群话题', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-card-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  s.put('config', 'main', {
    ...s.config(),
    providers: { chat: { base: 'http://unused', model: 'fixture' } },
  })
  const card = 'https://www.zhihu.com/question/123',
    official = 'https://example.org/notice'
  const tool = (name, args, id) => ({
    role: 'assistant',
    tool_calls: [{ type: 'function', id, function: { name, arguments: JSON.stringify(args) } }],
  })
  for (const [name, fn] of Object.entries({
    readWebPage: ({ url }) =>
      url === card
        ? { status: 'restricted', data: { card: { summary: '价格调整' } }, sources: [card] }
        : { status: 'read', data: { text: '正式公告自周五起生效' }, sources: [official] },
    searchWeb: () => ({
      status: 'ok',
      data: [{ url: official, title: '正式公告' }],
      sources: [official],
    }),
  }))
    c.register({ ...c.registry.get(name), execute: fn })
  let step = 0
  const r = new Runtime(s, c, {
    model: async () =>
      [
        { role: 'assistant', content: '未经核查的草稿' },
        tool('readWebPage', { url: card }, 'read-card'),
        tool('searchWeb', { query: '价格调整 公告' }, 'search'),
        tool('readWebPage', { url: official }, 'read-site'),
        { role: 'assistant', content: '卡片仅显示价格调整。独立公告写明周五生效。' },
      ][step++],
  })
  const d = {
    id: 'one',
    group_openid: 'g',
    author: { member_openid: 'a' },
    content: '作者怎么说？帮我查证',
    msg_elements: [
      {
        message_type: 103,
        msg_elements: [
          {
            message_type: 3,
            ark_data: { fields: { title: '某条分享', desc: '价格调整', jump_url: card } },
          },
        ],
      },
    ],
  }
  const m = r.receive('GROUP_AT_MESSAGE_CREATE', d),
    id = key('g', 'one')
  await r.process(s.get('run', id))
  const done = s.get('run', id)
  assert.equal(done.state, 'done')
  assert.ok(done.ticket)
  assert.equal(step, 5)
  assert.ok(done.answer.includes(official))
  assert.ok(!done.answer.includes('草稿'))
  const next = r.receive('GROUP_AT_MESSAGE_CREATE', {
    ...d,
    id: 'two',
    msg_elements: [],
    content: '有官方来源吗？',
  })
  assert.equal(next.thread, m.thread)
})
