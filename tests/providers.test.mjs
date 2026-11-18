import test from 'node:test'
import assert from 'node:assert/strict'
import { settings, requireProvider, selectedProvider } from '../app/providers.mjs'
import * as deepseek from '../app/deepseek.mjs'
const config = { providers: {}, vendors: { deepseek: { key: 'test-secret' } } }
test('worker follows the live main model; explicit overrides and visual constraints', () => {
  const c = structuredClone(config)
  c.routes = settings(c).routes
  assert.equal(c.routes.worker, 'follow')
  c.routes.chat = 'deepseek-v4-pro'
  assert.deepEqual(requireProvider(c, 'worker'), requireProvider(c, 'chat'))
  assert.equal(requireProvider(c, 'vision').model, 'deepseek-flash')
  c.routes.worker = 'deepseek-flash'
  assert.equal(requireProvider(c, 'worker').model, 'deepseek-flash')
  c.routes.vision = 'follow'
  assert.throws(() => requireProvider(c, 'vision'), /图像/)
  for (const role of ['search', 'fetch', 'speech', 'ocr', 'tts'])
    assert.equal(requireProvider(c, role).key, 'test-secret')
  assert.equal(selectedProvider(c, 'image'), undefined)
})
test('adopt official legacy key, keep custom connections and avoid implicit hosted fetch without a key', () => {
  const c = {
    providers: {
      chat: { base: 'https://api.deepseek.com', model: 'deepseek-chat', key: 'old' },
      worker: { base: 'https://custom.test', key: 'different', model: 'custom' },
    },
  }
  assert.equal(requireProvider(c, 'chat').model, 'deepseek-flash')
  assert.equal(requireProvider(c, 'search').key, 'old')
  assert.deepEqual(requireProvider(c, 'worker'), c.providers.worker)
  assert.equal(selectedProvider({ providers: {} }, 'fetch').kind, 'local')
  assert.throws(() => requireProvider({ providers: {} }, 'search'), /API Key/)
})
test('official tools use shared credentials and documented request and response formats', async (t) => {
  const p = requireProvider(config, 'search'),
    paths = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    const path = new URL(url).pathname
    assert.equal(new URL(url).origin, 'https://api.deepseek.com')
    paths.push(path)
    const b = options.body
    if (path.endsWith('/search')) {
      const q = JSON.parse(b)
      assert.match(q.query, /site:example.org after:/)
      assert.ok([...q.query].length <= 128)
      assert.equal(q.count, 5)
      return Response.json({ results: [{ title: 'T', url: 'https://example.org', snippet: 'short' }] })
    }
    if (path.endsWith('/fetch')) {
      assert.equal(JSON.parse(b).url, 'https://example.org/')
      return Response.json({ title: 'Page', content: 'Full text' })
    }
    if (path.endsWith('/asr')) {
      assert.equal(b.get('file').type, 'audio/ogg')
      assert.deepEqual([...b.keys()], ['file'])
      return Response.json({ text: '语音', duration_ms: 1200 })
    }
    if (path.endsWith('/ocr')) {
      assert.equal(b.get('purpose'), 'text_recognition')
      return Response.json({ pages: [{ index: 0, text: '合同', finish_reason: 'stop' }] })
    }
    if (path.endsWith('/tts')) {
      assert.equal(JSON.parse(b).voice_id, 'tide')
      return new Response(Buffer.from('RIFF0000WAVEdata'))
    }
    throw Error(path)
  })
  assert.equal((await deepseek.search(p, '示例'.repeat(100), 'example.org', 'week'))[0].snippet, 'short')
  assert.equal((await deepseek.read(p, 'https://example.org')).text, 'Full text')
  assert.deepEqual(await deepseek.transcribe(p, [{ at: 30, data: 'YQ==' }]), [[30, 31.2, '语音']])
  assert.equal((await deepseek.recognize(p, { mime: 'image/png', bytes: Buffer.from('img') }))[0].page, 1)
  assert.equal((await deepseek.synthesize(p, '大家好', 'tide')).length, 16)
  assert.equal(paths.length, 5)
})
