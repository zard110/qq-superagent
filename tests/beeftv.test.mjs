import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities, Pending } from '../app/capabilities.mjs'
import { workerMedia } from '../app/worker-media.mjs'

import { audioRequest } from '../app/audio-models.mjs'
import { workerTools } from '../app/harness.mjs'
import { QQ } from '../app/qq.mjs'

test('所有已启用的群能力都有命令与完整参数，搜索保留域和时间范围', t => {
  const {caps,s,ctx} = setup(t,'')
  new QQ({caps,store:s})
  ctx.config.routes.music = 'beeftv'
  ctx.config.groups = {g:{disabled:['generateVideo']}}
  const catalog = workerTools(caps,ctx.config,'g')
  const commands = new Map(catalog.map(t=>[t.spec.name,t]))
  assert.equal(commands.size,catalog.length)
  assert.deepEqual([...commands.keys()].sort(),caps.tools(ctx.config,ctx.m.group).map(t=>t.function.name).filter(n=>n!=='generateVideo').sort())
  assert.equal(commands.get('getGroupInfo').command,'call')
  assert.equal(commands.get('runCode').command,'shell')
  assert.equal(commands.get('searchWeb').spec.parameters.properties.timeRange.type,'string')
  assert.equal(commands.get('generateMusic').command,'media')
  assert.equal(commands.get('synthesizeSpeech').spec.parameters.properties.speed.maximum,2)
  assert.ok(!commands.has('generateVideo'))
  ctx.config.routes.music='off'
  assert.ok(!workerTools(caps,ctx.config,'g').some(t=>t.spec.name==='generateMusic'))
})

test('每个音频模型仅提交支持的参数，错误的音色不会回退成男声', () => {
  const tts = args=>audioRequest('tts',{text:'青山',...args},'请用自定义音色 Voice-123')
  assert.equal(tts({voice:'Voice-123'}).voice,'Voice-123')
  assert.equal(tts({voice:'female-chengshu',speed:0.8,emotion:'calm'}).speed,0.8)
  assert.equal(tts({model:'seed-audio-1.0',instructions:'轻声、舒缓'}).instructions,'轻声、舒缓')
  assert.equal(tts({voice:'stella'}).voice,'female-shaonv')
  assert.throws(()=>tts({voice:'不存在的音色'}),/未知音色/)
  assert.throws(()=>tts({speed:4}),/speed/)
  assert.throws(()=>tts({instructions:'温柔'}),/不支持/)
  assert.throws(()=>audioRequest('music',{prompt:'鼓',lyrics:'甲',is_instrumental:true}),/纯音乐/)
  assert.throws(()=>audioRequest('music',{prompt:'鼓',speed:1}),/不支持/)
  assert.throws(()=>audioRequest('music',{prompt:'鼓',model:'mureka-music-v8'}),/歌词/)
  assert.equal(audioRequest('music',{prompt:'鼓',model:'minimax-music-v2.6',is_instrumental:true,bitrate:128000}).bitrate,128000)
})

test('歌曲真实走音乐模型，SSE 完成后保存；台词单独传入音色、音高、语速及情感', async t => {
  const {caps,ctx,s} = setup(t,'生成一首快节奏 rap，再配一段温柔的女声旁白')
  ctx.config.routes.music='beeftv'
  s.put('config','main',ctx.config)
  ctx.run='song-voice'
  const orders=[]
  t.mock.method(globalThis,'fetch',async(u,o)=>{
    assert.equal(new URL(u).pathname,'/v1/audio/speech')
    const body=JSON.parse(o.body)
    orders.push(body)
    if (body.model.startsWith('minimax-music')) return new Response(
      ': heartbeat\r\n\r\nevent: speech.audio.delta\r\ndata: {"audio":"SUQzdGVzdA=="}\r\n\r\ndata: {"type":"speech.audio.done"}\n\n',
      {headers:{'content-type':'text/event-stream'}})
    return new Response(Buffer.from('ID3voice'))
  })
  const generate = ()=>workerMedia({caps,ctx},'generateMusic','song',{prompt:'152 BPM 中文 rap',lyrics:'[Verse] 青山',is_instrumental:false})
  const [a,b]=await Promise.all([generate(),generate()])
  assert.equal(a.resource,b.resource)
  assert.equal((await generate()).applied.model,'minimax-music-v3.0')
  const voice = await workerMedia({caps,ctx},'synthesizeSpeech','line',{text:'你好',voice:'Chinese (Mandarin)_Soft_Girl',speed:0.9,pitch:1,emotion:'calm'})
  assert.equal(voice.applied.voiceLabel,'柔和女声')
  assert.equal(orders.length,2)
  assert.equal(orders[0].lyrics,'[Verse] 青山')
  assert.equal(orders[0].input,'152 BPM 中文 rap')
  assert.ok(!('voice' in orders[0]))
  assert.equal(orders[1].input,'你好')
  assert.equal(orders[1].voice,'Chinese (Mandarin)_Soft_Girl')
  assert.equal(orders[1].pitch,1)
  assert.equal(orders[1].speed,0.9)
  assert.equal(orders[1].emotion,'calm')
  await assert.rejects(caps.run('synthesizeSpeech',{text:'歌词'},{...ctx,audioIntent:'music'}),/generateMusic/)
})

test('音乐流提前断开不交付，重试不重复付费', async t => {
  const {caps,ctx}=setup(t,'生成纯音乐')
  ctx.config.routes.music='beeftv'
  let calls=0
  t.mock.method(globalThis,'fetch',async()=>{
    calls++
    return new Response('data: {"type":"speech.audio.delta","audio":"SUQz"}\n\n',{headers:{'content-type':'text/event-stream'}})
  })
  const start=()=>caps.run('generateMusic',{prompt:'弦乐',is_instrumental:true},ctx)
  await assert.rejects(start(),/完成回执/)
  await assert.rejects(start(),/核对原任务/)
  assert.equal(calls,1)
})

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

test('并行镜头共用正在上传的参考图，短暂断流仅重传素材', async t => {
  const { caps, ctx } = setup(t, '原样生成 6秒 视频')
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
  const resource = caps.save('g', 'image/png', bytes)
  let tickets = 0, uploads = 0, completed = 0, orders = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/v1/media/uploads') {
      tickets++
      return Response.json({ticket:'upload', upload_url:'https://assets.myqcloud.com/input'})
    }
    if (path === '/input') {
      if (++uploads === 1) throw TypeError('fetch failed')
      return new Response()
    }
    if (path === '/v1/media/uploads/complete') {
      completed++
      return Response.json({url:'https://assets.myqcloud.com/ref'})
    }
    if (path === '/v1/videos') {
      assert.equal(JSON.parse(options.body).content[0].image_url.url, 'https://assets.myqcloud.com/ref')
      return Response.json({id:'v' + ++orders})
    }
    if (path.endsWith('/content')) return new Response(Buffer.from('0000ftypmp42'))
    return Response.json({status:'completed'})
  })
  const args = {prompt:'骑行镜头', seconds:6, resources:[resource]}
  const make = mediaItem => caps.run('generateVideo',args,{...ctx,run:'one-film',mediaItem})
  const results = await Promise.all([make('one'),make('two')])
  assert.deepEqual(results.map(r=>r.status),['ok','ok'])
  assert.deepEqual({tickets,uploads,completed,orders},{tickets:2,uploads:2,completed:1,orders:2})
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
