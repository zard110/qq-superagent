import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities } from '../app/capabilities.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'

test('知乎卡片摘要与独立来源分开，模型遗漏检索时先补证，普通 @ 追问沿用本群话题', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-card-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  s.put('config', 'main', { ...s.config(), providers: { chat: { base: 'http://unused', model: 'fixture' } } })
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
    searchWeb: () => ({ status: 'ok', data: [{ url: official, title: '正式公告' }], sources: [official] }),
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
          { message_type: 3, ark_data: { fields: { title: '某条分享', desc: '价格调整', jump_url: card } } },
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
