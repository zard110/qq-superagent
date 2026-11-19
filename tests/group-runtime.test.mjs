import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { GroupRuntime } from '../app/group-runtime.mjs'
import { Pending } from '../app/capabilities.mjs'
import { workerMedia } from '../app/worker-media.mjs'
import { key } from '../app/messages.mjs'

function fixture(t, options = {}) {
  const store = new Store(':memory:')
  t.after(() => store.db.close())
  const c = store.config()
  c.groups.g = { mode: 'social', code: options.code !== false }
  c.vendors = {
    openai: { base: 'https://example.invalid/v1', model: 'main' },
    quick: { base: 'https://quick.invalid/v1', model: 'quick' },
    jev: { enabled: !!options.jev, base: 'https://jev.invalid', key: 'test', model: 'router' },
  }
  c.routes = { chat: 'openai', worker: 'follow' }
  store.put('config', 'main', c)
  if (options.jev)
    t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(
        Response.json({
          answers: {
            engagement: { choice: options.engagement || 'requested' },
            difficulty: { choice: 'quick' },
            memory: { choice: 'none' },
          },
        }),
      ),
    )
  const caps = { reference: (m) => ({ parts: m.parts }), tools: () => [], ...options.caps }
  const runtime = new GroupRuntime(store, caps, {
    plan: async () => ({ action: 'new', goal: 'answer', brief: '交给群执行者' }),
    model: async () => ({ content: '好的' }),
    worker: async () => ({ text: '已处理' }),
    ...options,
  })
  const send = (id, text, ref, mention = true, author = 'A') =>
    runtime.receive(mention ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', {
      id,
      content: text,
      group_openid: 'g',
      author: { id: author },
      message_scene: { ext: ref ? ['ref_msg_idx=' + ref] : [] },
    })
  const read = (id) => store.get('run', key('g', id))
  const process = (id) => runtime.process(read(id))
  return { store, runtime, send, read, process }
}
test('Jev 超时后的自然续句仍由规划模型结合群聊决定是否接话', async (t) => {
  let planned = 0
  const a = fixture(t, {
    jev: true,
    plan: async () => {
      planned++
      return { action: 'new', participation: 'requested', quick: true }
    },
  })
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('timeout', 'TimeoutError')
  })
  a.send('a', '你好快', null, false)
  a.send('b', '吗', null, false)
  await a.process('b')
  assert.equal(planned, 1)
  assert.equal(a.read('b').state, 'done')
  assert.equal(a.read('b').executor, 'quick')
})
test('快答也有 Trigger、Decision、Assignment、报告和一次 Channel 投递', async (t) => {
  const a = fixture(t, { jev: true })
  a.send('q', '你好')
  await a.process('q')
  a.send('q', '你好')
  await a.process('q')
  const r = a.read('q'),
    ticket = a.store.tickets.get(r.ticket)
  assert.equal(r.state, 'done', r.answer)
  assert.equal(r.executor, 'quick')
  assert.equal(ticket.ended.outcome, 'completed')
  assert.equal(ticket.assignments[0].report.state, 'ready')
  assert.equal(a.store.all('channel').length, 1)
  assert.equal(a.store.all('out').length, 1)
})
test('中断恢复时，先对账在途镜头，不能换编号再次提交', async (t) => {
  const a = fixture(t),
    run = 'resume-job',
    m = { group: 'g' },
    id = key(run, 'media', 'generateVideo', 'shot-one')
  a.store.put('mediaItem', id, { method: 'generateVideo', item: 'shot-one', run })
  a.store.put('step', id, { result: { status: 'pending' } })
  const grant = {
    lease: { recovering: true },
    ctx: { m, run },
    caps: { store: a.store, run: () => assert.fail('不应提交订单') },
  }
  await assert.rejects(() => workerMedia(grant, 'generateVideo', 'shot-retry', { seconds: 6 }), /原编号/)
})
test('快答需要工具时在原 Ticket 上交给群 Agent', async (t) => {
  let called = 0
  const a = fixture(t, {
    jev: true,
    model: async () => ({ content: '[转交]' }),
    worker: async () => {
      called++
      return { text: '工具回执' }
    },
  })
  a.send('q', '帮忙看看')
  await a.process('q')
  assert.equal(called, 1)
  assert.equal(a.store.all('ticket').length, 1)
  assert.equal(a.read('q').executor, 'harness')
  assert.equal(a.read('q').answer, '工具回执')
})
test('普通消息可静默，后来到达的 QQ @ 事件复用原消息', async (t) => {
  const a = fixture(t)
  const c = a.store.config()
  c.groups.g.mode = 'quiet'
  a.store.put('config', 'main', c)
  a.send('q', '你好', null, false)
  await a.process('q')
  assert.equal(a.read('q').state, 'ignored')
  assert.equal(a.store.all('out').length, 0)
  a.send('q', '你好')
  await a.process('q')
  assert.equal(a.read('q').state, 'done', a.read('q').answer)
  assert.equal(a.store.all('out').length, 1)
})
test('明确引用的跨成员追问恢复原 Ticket，回复地址指向发起追问的消息', async (t) => {
  const a = fixture(t)
  a.send('q', '查资料')
  await a.process('q')
  const first = a.read('q')
  a.send('r', '加一个关键词继续查', key(first.id, 'reply'), true, 'B')
  await a.process('r')
  const r = a.read('r')
  assert.equal(r.state, 'done', r.answer)
  assert.equal(r.ticket, first.ticket)
  assert.equal(a.store.tickets.get(r.ticket).assignments.length, 2)
  assert.equal(a.store.all('decision').length, 1)
  assert.equal(a.store.get('out', key(r.id, 'reply')).origin, 'r')
})
test('只开放产品工具的群也能查资料，按真实工具回执作答', async (t) => {
  const calls = []
  const a = fixture(t, {
    code: false,
    caps: {
      tools: () => [{ function: { name: 'searchWeb' } }, { function: { name: 'runCode' } }],
      run: async (name) => {
        calls.push(name)
        return { status: 'ok', data: { title: '检索结果' } }
      },
    },
    model: async (p, dialog, tools) => {
      assert.deepEqual(
        tools.map((t) => t.function.name),
        ['searchWeb'],
      )
      return dialog.at(-1).role === 'tool'
        ? { content: '检索结果' }
        : {
            tool_calls: [
              { id: 'one', function: { name: 'searchWeb', arguments: '{"query":"公开资料"}' } },
            ],
          }
    },
  })
  a.send('q', '查资料')
  await a.process('q')
  assert.equal(a.read('q').state, 'done', a.read('q').answer)
  assert.deepEqual(calls, ['searchWeb'])
})
test('每日归档经内核分派，失败后保留进度，完成也没有 QQ 投递', async (t) => {
  const a = fixture(t),
    job = { group: 'g', next: '2026-01-02' }
  let attempts = 0
  a.runtime.archive = async (j) => {
    if (!attempts++) throw Error('模型暂不可用')
    a.store.put('memoryJob', j.group, { ...j, next: '2026-01-03', status: '已归档' })
  }
  a.runtime.archiveDue(job)
  a.runtime.archiveDue(job)
  const id = key('daily-archive', 'g', job.next)
  await a.runtime.process(a.store.get('run', id))
  assert.equal(a.store.get('run', id).state, 'running')
  await a.runtime.process(a.store.get('run', id))
  const run = a.store.get('run', id)
  assert.equal(run.state, 'done')
  assert.equal(a.store.tickets.get(run.ticket).ended.outcome, 'completed')
  assert.equal(a.store.all('channel').length, 0)
  assert.equal(a.store.all('out').length, 0)
})
test('一条引用送达两个订阅者，分别记录真实回执', async (t) => {
  let hold = true
  const a = fixture(t, {
    worker: async (_, r) => {
      if (hold) throw new Pending('执行中')
      return { text: '进度 ' + r.ticket }
    },
  })
  a.send('one', '工作一')
  await a.process('one')
  a.send('two', '工作二')
  await a.process('two')
  a.runtime.engine.bindThread(a.read('two').ticket, { source: 'qq', id: a.read('one').m.thread }, true)
  hold = false
  a.send('follow', '分别报告', 'one')
  await a.process('one')
  await a.process('two')
  const runs = a.store.pendingRuns()
  assert.equal(runs.length, 2)
  for (const r of runs) await a.runtime.process(r)
  assert.equal(a.store.all('out').filter((o) => o.origin === 'follow').length, 2)
})
test('执行期间修改群策略只通知受影响 Ticket，未授权成员无法叫停他人工作', async (t) => {
  let target
  const a = fixture(t, {
    worker: async () => {
      throw new Pending('工作中')
    },
    plan: async (_, r) =>
      r.m.text === '停止'
        ? { action: 'stop', stop: target, question: '请原发起人确认' }
        : { action: 'new' },
  })
  a.send('q', '查资料')
  await a.process('q')
  target = a.read('q').ticket
  const before = a.store.config(),
    after = structuredClone(before)
  after.groups.g.disabled = ['generateVideo']
  a.store.put('config', 'main', after)
  a.runtime.policyUpdated(before, after)
  assert.ok(a.store.tickets.get(target).inputs.some((i) => i.kind === 'policy-changed'))
  a.send('stop', '停止', null, true, 'B')
  await a.process('stop')
  assert.equal(a.store.tickets.get(target).ended, undefined)
})
test('原 Ticket 收到明确的免回复补充时无额外投递', async (t) => {
  const a = fixture(t, {
    plan: async (_, r) =>
      r.m.text === '收到，不用回' ? { action: 'silent', quiet: true } : { action: 'new' },
  })
  a.send('q', '查资料')
  await a.process('q')
  a.send('r', '收到，不用回', key(a.read('q').id, 'reply'))
  await a.process('r')
  assert.equal(a.read('r').state, 'ignored')
  assert.equal(a.store.all('out').length, 1)
})
test('定时触发去重，提醒走独立来源和同一 Channel', async (t) => {
  const a = fixture(t),
    id = key('schedule', 123)
  for (let i = 0; i < 2; i++) a.runtime.scheduled({ group: 'g', next: 123, text: '交接班' }, id)
  await a.runtime.process(a.store.get('run', id))
  assert.equal(a.store.get('run', id).state, 'done', a.store.get('run', id).answer)
  assert.equal(a.store.triggers.get(id).human, false)
  assert.equal(a.store.all('out')[0].origin, '')
  assert.equal(a.store.all('channel').length, 1)
})
test('重启后继续同一任务，部分交付保留原因且不会报告完成', async (t) => {
  let calls = 0
  const worker = async () => {
    if (!calls++) throw new Pending('排队')
    return { partial: true, text: '第三镜生成失败，已保存前两镜' }
  }
  const a = fixture(t, { worker })
  a.send('q', '制作多段短片')
  await a.process('q')
  const first = a.read('q')
  assert.equal(first.state, 'running')
  const restored = new GroupRuntime(a.store, a.runtime.caps, {
    worker,
    plan: async () => assert.fail('重复规划'),
  })
  await restored.process(first)
  assert.equal(a.read('q').state, 'partial', a.read('q').answer)
  assert.equal(a.read('q').ticket, first.ticket)
  assert.equal(a.store.tickets.get(first.ticket).assignments[0].report.state, 'blocked')
  assert.equal(a.store.all('out').length, 1)
})
test('明确叫停正在运行的任务后，迟到结果不能进入发送队列', async (t) => {
  let target
  const a = fixture(t, {
    worker: async () => {
      throw new Pending('等待生成')
    },
    plan: async (_, r) => (r.m.text === '取消' ? { action: 'stop', stop: target } : { action: 'new' }),
  })
  a.send('q', '制作')
  await a.process('q')
  const original = a.read('q')
  target = original.ticket
  a.send('stop', '取消', original.m.id)
  await a.process('stop')
  assert.equal(a.store.tickets.get(target).ended?.by, 'human')
  a.runtime.finish(original, '已完成')
  assert.equal(a.read('q').state, 'stopped')
  assert.equal(a.store.all('out').length, 0)
})
