import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities, Pending } from '../app/capabilities.mjs'

test('fal 提交后用真实 SQLite 重启，从已保存的状态 URL 继续，改图携带原图', async (t) => {
  let calls = 0,
    polls = 0,
    base,
    submitted
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST') {
      calls++
      let b = ''
      for await (const part of req) b += part
      submitted = JSON.parse(b)
      res.end(
        JSON.stringify({ request_id: '42', status_url: base + '/status', response_url: base + '/result' }),
      )
    } else if (req.url === '/status') {
      polls++
      res.end(JSON.stringify({ status: polls === 1 ? 'IN_PROGRESS' : 'COMPLETED' }))
    } else res.end(JSON.stringify({ images: [{ url: 'https://example.org/generated.png' }] }))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  t.after(() => server.close())
  base = 'http://127.0.0.1:' + server.address().port
  const dir = mkdtempSync(join(tmpdir(), 'qq-fal-'))
  let s = new Store(join(dir, 'state.sqlite')),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const resource = c.save('g', 'image/png', Buffer.from('input')),
    ctx = {
      m: { group: 'g', id: '1' },
      config: { providers: { image: { base, model: 'create', editModel: 'edit', key: 'test' } } },
      callId: 'first',
    }
  const args = { prompt: '保留报名日期，横版', resource }
  await assert.rejects(c.generate(ctx, args), Pending)
  s.db.close()
  s = new Store(join(dir, 'state.sqlite'))
  c = new Capabilities(s, dir)
  c.download = async () => ({ bytes: Buffer.from('result'), mime: 'image/png' })
  const result = await c.generate({ ...ctx, callId: 'recovered' }, args)
  assert.ok(result.artifact)
  assert.equal(calls, 1)
  assert.equal(polls, 2)
  assert.equal(submitted.image_urls[0], 'data:image/png;base64,aW5wdXQ=')
  assert.equal((await c.file('g', result.artifact)).bytes.toString(), 'result')
})
