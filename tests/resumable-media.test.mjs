import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities, Pending } from '../app/capabilities.mjs'
import { executeHarness, startGateway } from '../app/harness.mjs'
import { parseDocument } from '../app/network.mjs'
import { stalled } from '../runner/groups.mjs'
import { key } from '../app/messages.mjs'
import { QQ, documentParts } from '../app/qq.mjs'
import { isPostPhoto } from '../app/photo-sources.mjs'

function setup(t) {
  const store = new Store(':memory:'),
    dir = mkdtempSync(join(tmpdir(), 'qq-media-test-'))
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, caps: new Capabilities(store, dir) }
}

test('网页只取正文媒体和原帖声明的配图，视觉失败保留可用帧和序号', async (t) => {
  const { store, caps } = setup(t)
  const page = parseDocument(
    '<title>旅行</title><article><p>我的游记</p><img src="/a.jpg"><video><source src="/trip.mp4"></video><aside><img src="/ad.png"></aside></article>',
    'https://example.org/post',
  )
  assert.deepEqual(page.images, ['https://example.org/a.jpg'])
  assert.deepEqual(page.videos, ['https://example.org/trip.mp4'])
  const ctx = { config: store.config(), m: { group: 'g', id: 'q', text: '说了啥？' } }
  page.browserImages = [{ resource: 'decoded', position: 2 }]
  let attempts = 0
  caps.register({
    spec: { function: { name: 'analyzeMedia' } },
    execute: async ({ resource }) => {
      attempts++
      if (resource === 'decoded')
        return { status: 'ok', data: { answer: '图中可见 16:30', coverage: '图片' } }
      throw Error('视频已过期')
    },
  })
  await caps.inspectPageMedia(page, ctx)
  await caps.inspectPageMedia(page, ctx)
  assert.equal(attempts, 2)
  assert.equal(page.visuals[0].position, 2)
  assert.equal(page.visualFailures[0].reason, '视频已过期')
  ctx.config.groups.g = { disabled: ['analyzeMedia'] }
  await caps.inspectPageMedia(page, ctx)
  assert.equal(page.visuals.length, 0)
  assert.equal(attempts, 2)
})
test('超过 36 次调用，停滞后用相同会话和凭证恢复一次，已完成结果可重读', async (t) => {
  const runtime = setup(t),
    { store } = runtime
  let state = { state: 'missing' },
    submissions = [],
    calls = 0
  const server = http
    .createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      let result = {}
      if (req.url === '/group/status') result = state
      else if (req.url === '/group') {
        submissions.push(JSON.parse(text))
        result = state = { state: 'running', progress: { at: Date.now(), step: '读取草稿' } }
      } else if (req.url === '/group/ack') {
        state = { state: 'missing' }
        result = state
      } else if (req.url === '/chat/completions') {
        calls++
        result = { choices: [] }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    })
    .listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port
  const previous = process.env.RUNNER_URL
  process.env.RUNNER_URL = base
  t.after(() => {
    if (previous) process.env.RUNNER_URL = previous
    else delete process.env.RUNNER_URL
    server.close()
  })
  store.put('config', 'main', { ...store.config(), providers: { worker: { model: 'test', base } } })
  const m = { id: 'q', group: 'g', author: 'a', text: '继续原稿', parts: [], refs: [], thread: 'thread' }
  const run = { id: key('run'), m, ticket: 'ticket', route: { goal: 'document' }, state: 'running' }
  const tick = () => executeHarness(runtime, run, { parts: [] })
  await assert.rejects(tick, Pending)
  store.put('run', run.id, run)
  const gateway = startGateway(runtime, 0)
  await once(gateway, 'listening')
  t.after(() => gateway.close())
  for (let i = 0; i < 40; i++) {
    const r = await fetch('http://127.0.0.1:' + gateway.address().port + '/task/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + submissions[0].token },
      body: '{}',
    })
    await r.text()
    assert.equal(r.status, 200)
  }
  assert.equal(calls, 40)
  assert.equal(stalled(9 * 60000, 10 * 60000), false)
  assert.equal(stalled(60000, 9 * 60000), true)
  state = { state: 'finished', result: { interrupted: '无进展' } }
  await assert.rejects(tick, Pending)
  await assert.rejects(tick, Pending)
  assert.equal(submissions.length, 2)
  assert.equal(submissions[1].recovering, true)
  assert.equal(submissions[1].ticket, submissions[0].ticket)
  assert.equal(submissions[1].token, submissions[0].token)
  state = {
    state: 'finished',
    result: {
      text: '剧本',
      artifact: {
        name: '剧本.md',
        mime: 'text/markdown',
        data: Buffer.from('第 1 集').toString('base64'),
      },
      steps: ['read'],
    },
  }
  const done = await tick()
  assert.equal((await runtime.caps.file('g', done.artifact)).bytes.toString(), '第 1 集')
  assert.deepEqual(await tick(), done)
  assert.equal(store.get('workerLease', run.id), undefined)
})
test('文稿退回分段正文，逐段取得回执，重复刷新不会重发', async (t) => {
  const app = setup(t),
    s = app.store,
    q = new QQ(app)
  s.put('config', 'main', { ...s.config(), qq: { appId: 'test' }, groups: { g: { active: true } } })
  const text = '第1集\n' + '台词🐰'.repeat(1000) + '\n第2集\n完'
  const id = app.caps.save('g', 'text/markdown', Buffer.from(text))
  s.put('out', 'doc', { id: 'doc', group: 'g', artifact: id, status: 'pending', at: Date.now() })
  q.upload = async () => {
    throw Object.assign(Error('不支持文件'), { status: 415 })
  }
  const posted = []
  q.request = async (_, body) => {
    posted.push(body.content)
    return { id: 'm' + posted.length }
  }
  await q.flush()
  assert.equal(s.get('out', 'doc').status, 'split')
  for (let i = 0; i < 10; i++) await q.flush()
  assert.equal(posted.map((p) => p.slice(p.indexOf('\n') + 1)).join(''), text)
  assert.equal(posted.length, documentParts(text).length)
  assert.ok(
    s
      .all('out')
      .filter((o) => o.plain)
      .every((o) => o.remote),
  )
  assert.equal(
    isPostPhoto('https://www.instagram.com/p/abc/', 'https://www.instagram.com/p/diff/media/'),
    false,
  )
})
