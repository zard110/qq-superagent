import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'
import { decideConversation } from '../app/conversation.mjs'

test('引用旧作品时保留版本，独立请求分叉，候选按群隔离', async (t) => {
  const s = new Store(':memory:')
  t.after(() => s.db.close())
  s.put('config', 'main', {
    ...s.config(),
    providers: { chat: { base: 'http://unused', model: 'test' } },
  })
  const m = {
    id: 'one',
    group: 'a',
    author: 'a1',
    thread: 'thread1',
    text: '制作甲的海报',
    refs: [],
    parts: [],
    at: new Date().toISOString(),
  }
  s.put('run', 'old', { id: 'old', ticket: 'ticket1', state: 'done', artifact: 'old-file', m })
  s.put('run', 'else', { id: 'else', ticket: 'else', m: { ...m, group: 'b', text: '其他群的私有消息' } })
  const parent = { ...m, id: 'reply', idx: 'reply', author: '@bot', text: '海报已完成' }
  s.message(parent)
  const next = { id: 'next', m: { ...m, id: 'two', author: 'a2', text: '也给我一版', refs: ['reply'] } }
  let action = 'new'
  const runtime = {
    store: s,
    model: async (_p, dialog) => {
      assert.ok(!dialog[1].content.includes('其他群的私有消息'))
      return { content: JSON.stringify({ action, candidate: 0, reason: '引用了甲的作品' }) }
    },
  }
  const fork = await decideConversation(runtime, next)
  assert.equal(fork.source, 'reply')
  assert.equal(fork.thread, key('a', 'two'))
  assert.equal(fork.session, undefined)
  action = 'continue'
  const follow = await decideConversation(runtime, next)
  assert.equal(follow.thread, 'thread1')
  assert.equal(follow.session, 'ticket1')
  action = 'chat'
  assert.equal((await decideConversation(runtime, next)).thread, 'thread1')
  s.del('run', 'old')
  action = 'continue'
  const firstTask = await decideConversation(runtime, next)
  assert.equal(firstTask.action, 'new')
  assert.equal(firstTask.source, 'reply')
})
test('等待答复按发言人保存，其他人的插话不会取走等待记录', (t) => {
  const s = new Store(':memory:')
  t.after(() => s.db.close())
  const r = new Runtime(s, {})
  const at = new Date().toISOString(),
    parent = {
      group: 'g',
      id: 'question',
      idx: 'question',
      author: '@bot',
      thread: 'current',
      refs: [],
      parts: [],
      at,
      text: '从哪里开始？',
    }
  s.message(parent)
  s.put('awaitReply', key('g', 'alice'), { source: 'question', until: Date.now() + 30000 })
  const receive = (id, author, content) =>
    r.receive('GROUP_MESSAGE_CREATE', {
      id,
      group_openid: 'g',
      author: { id: author },
      timestamp: at,
      content,
    })
  receive('b', 'bob', '1:35')
  const m = receive('a', 'alice', '1:35')
  assert.deepEqual(m.refs, ['question'])
  assert.equal(m.thread, 'current')
  assert.ok(s.get('run', key('g', 'a')))
})
