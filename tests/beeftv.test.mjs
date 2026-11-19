import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities, Pending } from '../app/capabilities.mjs'
import { workerMedia } from '../app/worker-media.mjs'

function setup(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-beef-'))
  const s = new Store(join(dir, 'state.sqlite'))
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const ctx = {
    config: {
      routes: { image: 'beeftv', video: 'beeftv', tts: 'beeftv', vision: 'off' },
      vendors: { beeftv: { key: 'test' } },
    },
    m: { id: 'a', group: 'g', text, parts: [], refs: [] },
    worker: true,
  }
  return { caps: new Capabilities(s, dir), s, ctx }
}

test('中途断开的 QQ 附件重新取完整内容，之后直接读取缓存', async (t) => {
  const { caps, s } = setup(t, '')
  s.put('resource', 'photo', { group: 'g', mime: 'image/png', url: 'https://example.org/p' })
  let attempts = 0
  caps.download = async () => {
    if (++attempts === 1) throw Error('aborted')
    return { bytes: Buffer.from('complete'), mime: 'image/png' }
  }
  for (let i = 0; i < 2; i++) assert.equal((await caps.file('g', 'photo')).bytes.toString(), 'complete')
  assert.equal(attempts, 2)
  await assert.rejects(caps.file('another', 'photo'))
})

test('同一群任务由 Agent 自定镜头时长，多镜分别记账，并发与恢复均不重复下单', async (t) => {
  const {caps,s,ctx}=setup(t,'制作 30 秒短剧，加入对白和歌曲高潮')
  s.put('config','main',ctx.config)
  ctx.run='production'
  const requests=[]
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(options.method==='POST') {
      requests.push(JSON.parse(options.body))
      return Response.json({id:'v'+requests.length})
    }
    if(url.endsWith('/content')) return new Response(Buffer.from('0000ftypmp42'+url))
    return Response.json({status:'completed'})
  })
  const args={prompt:'雾中骑行',seconds:10}
  const shot=(id,a=args)=>workerMedia({caps,ctx},'generateVideo',id,a)
  const [one,duplicate]=await Promise.all([shot('s1'),shot('s1')])
  assert.equal(one.resource,duplicate.resource)
  assert.notEqual((await shot('s2')).resource,one.resource)
  assert.equal((await shot('s1')).resource,one.resource)
  await assert.rejects(shot('s1',{...args,seconds:8}),/不同参数/)
  assert.equal(requests.length,2)
  assert.equal(s.all('step').length,2)
  s.put('config','main',{...ctx.config,groups:{g:{disabled:['generateVideo']}}})
  await assert.rejects(shot('s3'),/关闭/)
})

test('带声视频取回 MP4，等待和重放只创建一次任务', async (t) => {
  const { caps, ctx } = setup(t, '原样生成 6秒 有声视频')
  let creates = 0,
    polls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body)
      assert.equal(body.seconds, '6')
      assert.equal(body.metadata.generate_audio, true)
      creates++
      return Response.json({ id: 'v1' })
    }
    if (url.endsWith('/content')) return new Response(Buffer.from('0000ftypmp42'))
    return Response.json({ status: ++polls === 1 ? 'queued' : 'completed' })
  })
  const invoke = () => caps.run('generateVideo', { prompt: '鲸娘', seconds: 6, audio: true }, ctx)
  await assert.rejects(invoke(), Pending)
  const result = await invoke()
  assert.equal(result.data.artifact, (await invoke()).data.artifact)
  assert.equal((await caps.file('g', result.data.artifact)).mime, 'video/mp4')
  assert.equal(creates, 1)
  assert.equal(polls, 2)
})

test('图片和配音保存到群素材，重试不会再次下单', async (t) => {
  const { caps, ctx } = setup(t, '原样生成图片，配音')
  const paths = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    paths.push(new URL(url).pathname)
    if (url.endsWith('/speech')) return new Response(Buffer.from('ID3audio'))
    assert.ok(options.headers['Idempotency-Key'])
    return Response.json({ data: [{ url: 'https://example.org/result' }] })
  })
  caps.download = async () => ({ bytes: Buffer.from('89504e470d0a1a0a', 'hex') })
  for (const [name, args, mime] of [
    ['generateImage', { prompt: '鲸娘' }, 'image/png'],
    ['synthesizeSpeech', { text: '你好' }, 'audio/mpeg'],
  ]) {
    for (let i = 0; i < 2; i++) {
      const r = await caps.run(name, args, ctx)
      assert.equal((await caps.file('g', r.data.artifact)).mime, mime)
    }
  }
  assert.deepEqual(paths, ['/v1/images/generations', '/v1/audio/speech'])
})
