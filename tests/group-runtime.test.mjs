import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { GroupRuntime } from '../app/group-runtime.mjs'
import { Pending } from '../app/capabilities.mjs'
import { QQ } from '../app/qq.mjs'
import { recoverMediaItems } from '../app/worker-media.mjs'
import { workerMedia } from '../app/worker-media.mjs'
import { planAssignment } from '../app/assignment.mjs'
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
test('五个独立委托执行期间仍接收和回答同群快答', async t => {
  const held = Promise.withResolvers(), started = new Set()
  const a = fixture(t,{worker: async (_, run) => {
    started.add(run.m.id)
    await held.promise
    return {text:'完成'}
  }})
  for (let i = 0; i < 5; i++) a.send('long'+i,'独立委托 '+i)
  await a.runtime.tick()
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(started.size,5)
    const c = a.store.config()
    c.vendors.jev.enabled = true
    a.store.put('config','main',c)
    t.mock.method(globalThis,'fetch', async () => Response.json({answers:{
      engagement:{choice:'requested'}, difficulty:{choice:'quick'}, memory:{choice:'none'}
    }}))
    a.send('chat','你好')
    await a.runtime.tick()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(a.read('chat').executor,'quick')
    assert.equal(a.read('chat').state,'done')
    assert.equal(a.read('long0').state,'running')
  } finally {
    held.resolve()
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('同群独立任务先完成，同任务修改恢复后按顺序，引用查询能即时取得阶段进度', async t => {
  let waiting = true
  const executed = []
  const a = fixture(t,{plan:async (_,r) => r.m.id === 'check' ?
    {action:'status',statusRun:a.read('a').id} : {action:'new',progressReports:true},
    worker:async (_,r) => {
      if (waiting && r.m.id === 'a') throw new Pending('后台执行中')
      executed.push(r.m.id)
      return {text:'完成 '+r.m.id}
    }})
  a.send('a','制作音频')
  await a.process('a')
  a.runtime.reportStage(a.read('a'),'lyrics','歌词已经写好','正在录音')
  a.send('edit','加一句歌词','a')
  await a.process('edit')
  a.send('edit2','再改节奏','a')
  await a.process('edit2')
  a.send('check','制作到哪一步了','a')
  await a.process('check')
  assert.match(a.read('check').answer,/歌词已经写好/)
  assert.equal(a.store.tickets.get(a.read('a').ticket).ended,undefined)
  a.send('b','另外制作一个表格')
  await a.process('b')
  assert.deepEqual(executed,['b'])
  waiting = false
  const restored = new GroupRuntime(a.store,a.runtime.caps,{worker:a.runtime.worker,plan:a.runtime.plan})
  for (const id of ['edit2','a','edit2','edit','edit2']) await restored.process(a.read(id))
  assert.deepEqual(executed,['b','a','edit','edit2'])
})

test('同群附件上传期间可投递另一条消息，同来源保持顺序且只发送一次', async t => {
  const a = fixture(t,{caps:{register(){}}}), s = a.store, qq = new QQ(a.runtime)
  const c = s.config()
  c.qq.appId = 'test'
  s.put('config','main',c)
  a.send('a','原消息'); a.send('b','另一条消息')
  const hold = Promise.withResolvers(), sent = []
  qq.upload = () => hold.promise
  qq.request = async (_,body) => {sent.push([body.msg_id,body.msg_seq]);return {id:'sent'+sent.length}}
  a.runtime.enqueue('file','g','a','','resource')
  a.runtime.enqueue('after','g','a','同一条消息的后续')
  a.runtime.enqueue('other','g','b','另一件事')
  const uploading = qq.flush()
  try {
    await Promise.all([qq.flush(),qq.flush()])
    assert.deepEqual(sent,[['b',1]])
  } finally {
    hold.resolve('ready'); await uploading
  }
  await qq.flush()
  assert.deepEqual(sent,[['b',1],['a',1],['a',2]])
})

test('其他机器人的 @ 和引用可被回复，重复事件仅处理一次，原委托不会被重启', async t => {
  let calls = 0
  const a = fixture(t, {jev:true, model:async (_, messages) => {
    calls++
    const context = JSON.parse(messages.at(-1).content)
    assert.equal(context.current.speaker, '机器人「测试鳄」')
    assert.equal(context.quotes[0].speaker, '助手')
    return {content:'不客气，小本本这个细节你也发现了！'}
  }})
  const ref = {id:'original',idx:'original',group:'g',author:'@bot',at:new Date(Date.now()-5000).toISOString(),text:'这张图送给你。',thread:'original-thread',parts:[],refs:[]}
  a.store.message(ref)
  const event = {id:'thanks',group_openid:'g',author:{id:'croc',bot:true,username:'测试鳄'},content:'谢谢，画得真好！',
    mentions:[{id:'self',is_you:true}],message_scene:{ext:['ref_msg_idx=original']}}
  a.runtime.receive('GROUP_MESSAGE_CREATE', event)
  a.runtime.receive('GROUP_AT_MESSAGE_CREATE', event)
  await a.process('thanks')
  a.runtime.receive('GROUP_AT_MESSAGE_CREATE', event)
  const r = a.read('thanks')
  assert.equal(r.state,'done',r.answer)
  assert.notEqual(r.m.thread,ref.thread)
  assert.equal(a.store.triggers.get(r.id).human,false)
  assert.equal(a.store.all('out').length,1)
  assert.equal(a.store.all('out')[0].origin,'thanks')
  assert.equal(calls,1)
})
test('其他机器人 @ 助手也可自然结束对话', async t => {
  const a = fixture(t,{jev:true,engagement:'silent'})
  a.runtime.receive('GROUP_AT_MESSAGE_CREATE',{group_openid:'g',id:'end',content:'互道再见后又重复了',author:{id:'peer',bot:true}})
  await a.process('end')
  assert.equal(a.read('end').state,'ignored')
  assert.equal(a.store.all('out').length,0)
})
test('未启用 Jev 时其他机器人仍可参与对话，引用不授权续办任务', async t => {
  const a = fixture(t,{plan:async()=>({action:'continue',attach:'unrelated',participation:'requested'}),
    worker:async()=>{throw Error('不应调用执行者')}})
  a.runtime.receive('GROUP_AT_MESSAGE_CREATE',{group_openid:'g',id:'peer',content:'你觉得呢？',author:{id:'peer',bot:true}})
  await a.process('peer')
  assert.equal(a.read('peer').state,'done',a.read('peer').answer)
  assert.equal(a.read('peer').answer,'好的')
  assert.notEqual(a.read('peer').ticket,'unrelated')
})
test('提到助手名只是线索，第三人称和直接称呼采用 Jev 的判断', async t => {
  const a = fixture(t, {jev:true})
  const c = a.store.config()
  c.groups.g.nickname = 'MaxShenBi'
  a.store.put('config','main',c)
  const contexts = []
  t.mock.method(globalThis,'fetch',async (_,opts) => {
    const state = JSON.parse(opts.body).state
    contexts.push(state)
    const choice = state.current.text.startsWith('你看') ? 'silent' : 'requested'
    return Response.json({answers:{engagement:{choice},difficulty:{choice:'quick'}}})
  })
  a.send('third','你看 MaxShenBi 画了什么',null,false)
  a.send('direct','MaxShenBi，你怎么看',null,false)
  await a.process('third')
  await a.process('direct')
  assert.equal(a.read('third').state,'ignored')
  assert.equal(a.read('direct').state,'done')
  assert.ok(contexts.every(c => c.mentionsAssistantName && !c.addressedToBot))
})
test('机器人引用图片查资料可用视觉、引用和网页工具，越权调用不会执行', async t => {
  const methods=['resolveReference','analyzeMedia','searchWeb','readWebPage','generateImage','runCode']
  const used=[]
  const a=fixture(t,{jev:true,caps:{
    tools:()=>methods.map(name=>({type:'function',function:{name}})),
    run:async(name)=>{used.push(name);return {status:'ok',data:{text:name}}}
  },model:async(_,dialog,tools)=>{
    assert.deepEqual(tools.map(t=>t.function.name),methods.slice(0,4))
    if (dialog.at(-1).role==='tool') return {content:'已按图片和资料回答。'}
    return {tool_calls:methods.map((name,i)=>({id:'c'+i,type:'function',function:{name,arguments:'{}'}}))}
  }})
  a.runtime.receive('GROUP_MESSAGE_CREATE',{group_openid:'g',id:'pic',author:{id:'peer',bot:true},attachments:[{content_type:'image/jpeg',url:'https://img.example/p.jpg'}]})
  a.runtime.receive('GROUP_AT_MESSAGE_CREATE',{group_openid:'g',id:'look',author:{id:'peer',bot:true},content:'看看这张，再查查出处',message_scene:{ext:['ref_msg_idx=pic']}})
  await a.process('look')
  assert.equal(a.read('look').state,'done',a.read('look').answer)
  assert.deepEqual(used,methods.slice(0,4))
  assert.equal(a.read('look').fast.lane,'responsible')
})
test('主动看图尊重规划静默，主动尝试失败也不会打扰群聊', async t => {
  let calls = 0
  const a = fixture(t, {jev:true, engagement:'proactive',
    plan:async (_, r) => ({action:r.m.id === 'silent' ? 'silent' : 'new', goal:'imageAnswer'}),
    caps:{reference:() => ({parts:[{type:'media',mime:'image/jpeg',resource:'photo'}]}),
      run:async () => { calls++; throw Error('素材连接中断') }}})
  const c = a.store.config()
  c.groups.g.cooldown = 0
  a.store.put('config', 'main', c)
  for (const id of ['silent','try']) {
    a.runtime.receive('GROUP_MESSAGE_CREATE', {group_openid:'g',id,author:{id:'member'},
      attachments:[{content_type:'image/jpeg',url:'https://example.test/photo'}]})
    await a.process(id)
  }
  assert.equal(a.read('silent').state,'ignored')
  assert.equal(a.read('try').state,'failed')
  assert.equal(calls,1)
  assert.equal(a.store.all('out').length,0)
})

test('单图解读直接使用配置的视觉能力并记录实际回执', async t => {
  const calls = []
  const a = fixture(t,{plan:async()=>({action:'new',goal:'imageAnswer',brief:'描述本条图片'}),
    worker:async()=>{throw Error('不应启动 Runner')},
    caps:{reference:()=>({parts:[{type:'media',mime:'image/png',resource:'this-image'}]}),
      run:async(name,args)=>{calls.push([name,args.resource]);return {status:'ok',data:{answer:'图上是一辆自行车。'}}}}})
  a.send('picture','分析一下图片')
  await a.process('picture')
  const r=a.read('picture')
  assert.equal(r.executor,'vision')
  assert.equal(r.answer,'图上是一辆自行车。')
  assert.deepEqual(calls,[['analyzeMedia','this-image']])
  assert.equal(a.store.all('step').find(s=>s.name==='analyzeMedia').result.status,'ok')
  assert.equal(a.store.all('out').length,1)
})
test('规划接口暂时 503 后重试，仍只交付一次', async t => {
  let calls = 0
  const a = fixture(t, {plan:planAssignment,model:async () => {
    if (++calls === 1) throw Object.assign(new Error('服务返回 HTTP 503'), {status:503})
    return {content:JSON.stringify({action:'new',goal:'answer',brief:'正常回复'})}
  }})
  a.send('plan-retry', '帮我处理')
  await a.process('plan-retry')
  assert.equal(calls, 2)
  assert.equal(a.read('plan-retry').state, 'done')
  assert.equal(a.store.all('out').length, 1)
})

test('慢速 Jev 返回后仍采用原判断，同时处理另一条消息', async t => {
  const a = fixture(t, { jev: true })
  const held = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let slowCalls = 0
  t.mock.method(globalThis, 'fetch', async (_, opts) => {
    if (JSON.parse(opts.body).state.current.text === '慢请求') {
      slowCalls++
      entered.resolve()
      await held.promise
      opts.signal?.throwIfAborted()
    }
    return Response.json({answers:{engagement:{choice:'requested'},difficulty:{choice:'quick'}}})
  })
  a.send('slow', '慢请求')
  const slow = a.process('slow')
  try {
    await entered.promise
    const thread = a.store.threads.active().find(t => t.evaluating)
    thread.evaluating.deadline = new Date(0).toISOString()
    a.store.threads.save(thread)
    a.send('second', '另一条消息')
    await a.process('second')
    assert.equal(a.read('second').state, 'done')
    assert.equal(a.read('slow').state, 'running')
    await new Promise(resolve => setTimeout(resolve, 3100))
  } finally {
    held.resolve()
    await slow
  }
  assert.equal(a.read('slow').executor, 'quick')
  assert.equal(a.read('slow').fast.fallback, undefined)
  assert.equal(slowCalls, 1)
})

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
test('恢复时已有供应商单号的镜头允许不同镜头并行，换编号重提同请求仍拦截', async t => {
  const {store} = fixture(t)
  const m = {group:'g',id:'q'}, ctx = {run:'retry',m}, grant = {ctx,lease:{recovering:true},
    caps:{store,run:async () => {throw new Pending('等待镜头')}}}
  const original={seconds:5,prompt:'开场'}
  store.put('mediaItem','old',{run:'retry',method:'generateVideo',item:'opening',
    fingerprint:key(Object.keys(original).sort().map(k=>[k,original[k]]))})
  store.put('step','old',{result:{status:'pending'}})
  store.put('paid',key('g','q','beeftv','video','opening'),{state:'submitted',receipt:{id:'provider-1'}})
  await assert.rejects(workerMedia(grant,'generateVideo','renamed',original),/原编号/)
  assert.deepEqual(await workerMedia(grant,'generateVideo','closing',{seconds:5,prompt:'收尾'}),{pending:true})
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
test('纯工具执行者把仅有歌词的答复交回音乐模型，获得音频后才交付', async t => {
  let calls=0
  const a=fixture(t,{code:false,plan:async()=>({action:'new',audioIntent:'music',requiresFile:true}),
    caps:{tools:()=>[{function:{name:'generateMusic'}}],run:async name=>{
      assert.equal(name,'generateMusic')
      a.store.put('resource','song',{group:'g',mime:'audio/mpeg'})
      return {status:'ok',data:{artifact:'song'}}
    }},
    model:async()=>{
      calls++
      if (calls===1) return {content:'一段歌词'}
      if (calls===2) return {tool_calls:[{id:'music-1',function:{name:'generateMusic',arguments:'{"prompt":"快节奏说唱"}'}}]}
      return {content:'歌曲已完成'}
    }})
  a.send('song','创作一首 rap')
  await a.process('song')
  assert.equal(calls,3)
  assert.equal(a.read('song').artifact,'song')
  assert.equal(a.read('song').state,'done')
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
test('续办读取同一原消息的前序生产回执，保留最新状态并隔离其他任务', t => {
  const {store} = fixture(t)
  const put = (id,group,resumeOf,status) => {
    const run={id,m:{group,id:'source'},ticket:'film',resumeOf}
    store.put('run',id,run)
    const item=key(id,'step')
    store.put('mediaItem',item,{run:id,method:'generateVideo',item:id==='next'?'first':id})
    store.put('step',item,{result:{status}})
    return run
  }
  put('outside','elsewhere',null,'ok')
  put('first','g','outside','pending')
  put('second','g','first','ok')
  const run=put('next','g','second','ok')
  assert.deepEqual(recoverMediaItems(store,run).map(i=>[i.item,i.status]),[['first','ok'],['second','ok']])
})
test('QQ 大文件按字节切分，兼容从 0 和从 1 开始的回执并完整上传末块', async t => {
  const bytes = Buffer.concat([Buffer.alloc(5000000,1),Buffer.alloc(321,2)])
  const a = fixture(t,{caps:{register(){},file:async()=>({bytes,mime:'video/mp4'})}})
  const qq = new QQ(a.runtime), uploaded = []
  t.mock.method(globalThis,'fetch',async (_,options)=>{
    uploaded.push(Buffer.from(options.body))
    return new Response()
  })
  for(const [first,sizes] of [[0,[5000000,321]],[1,[5000000,321]],[1,[bytes.length]]]) {
    const confirmed=[]
    uploaded.length=0
    qq.request=async (url,body)=>{
      if (url.endsWith('/upload_prepare')) return {upload_id:'u',block_size:String(sizes[0]),
        parts:sizes.map((size,i)=>({index:first+i,block_size:String(size),presigned_url:'https://example.invalid/put'})).reverse()}
      if(url.endsWith('/upload_part_finish')) {confirmed.push([body.part_index,Number(body.block_size)]);return {}}
      assert.equal(body.srv_send_msg,false)
      return {file_info:'ready'}
    }
    assert.equal(await qq.upload('g','file'),'ready')
    assert.deepEqual(confirmed,sizes.map((size,i)=>[first+i,size]))
    assert.ok(Buffer.concat(uploaded).equals(bytes))
  }
})
test('长任务阶段报告进入 Ticket，主任务合并投递，恢复去重，最终附件保留回复次数', async t => {
  let finished = false
  const a = fixture(t, {
    caps:{register() {}},
    plan:async () => ({action:'new',goal:'work',progressReports:true}),
    worker:async () => {if (!finished) throw new Pending('制作中'); return {text:'成片就绪'}},
  })
  const cfg = a.store.config()
  cfg.qq.appId = 'test'
  cfg.groups.g.active = false
  a.store.put('config','main',cfg)
  const qq = new QQ(a.runtime), sent = []
  qq.request = async (url, payload) => {sent.push(payload);return {id:'qq-stage-'+sent.length}}
  a.send('film','按阶段汇报，完成后交付')
  await a.process('film')
  const run = a.read('film')
  assert.equal(a.runtime.reportStage(run,'prep','已就绪','开始采集').accepted,true)
  assert.equal(a.runtime.reportStage(run,'prep','已就绪','开始采集').reused,true)
  assert.equal(a.runtime.reportStage(run,'collection','素材已取回','正在制作').accepted,true)
  assert.equal(a.store.tickets.get(run.ticket).assignments.at(-1).report.state,'progress')
  assert.equal(a.store.all('out').length,0)
  a.runtime.publishStages()
  a.runtime.publishStages()
  await qq.flush()
  assert.equal(sent.length,1)
  assert.match(sent[0].content,/已就绪；素材已取回\n正在制作/)
  assert.equal(sent[0].msg_seq,1)
  assert.equal(a.store.lookup('g','qq-stage-1').author,'@bot')
  a.store.put('out','used',{group:'g',origin:'film',seq:3,status:'sent'})
  a.runtime.reportStage(run,'cut','剪辑完成','正在验收')
  a.runtime.publishStages()
  await qq.flush()
  assert.equal(sent.length,1)
  a.runtime.reportStage(run,'audio','混音完成','正在导出')
  a.runtime.publishStages()
  finished=true
  await a.process('film')
  await qq.flush()
  assert.equal(sent.length,1)
  await qq.flush()
  assert.equal(sent.length,2)
  assert.equal(sent[1].msg_seq,4)
  assert.equal(a.runtime.reportStage(run,'late','迟到报告','').accepted,false)
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
