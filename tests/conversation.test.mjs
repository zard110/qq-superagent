import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'
import { decideConversation } from '../app/conversation.mjs'

test('制作期间单独补 @ 不再派单，有新增要求或事后再次询问时正常处理', async (t) => {
  const store = new Store(':memory:')
  t.after(() => store.db.close())
  store.put('config', 'main', {...store.config(), providers:{chat:{base:'http://unused',model:'fixture'}}})
  const at='2026-11-19T04:07:09.000Z'
  const m={id:'req',idx:'req',group:'g',author:'a',at,thread:'video',parts:[],refs:[],text:'制作短剧'}
  const prev=key(m.group,m.id)
  store.put('run',prev,{id:prev,state:'done',m,ticket:'work',artifact:'movie'})
  const before='2026-11-19T04:07:14.000Z', after='2026-11-19T04:10:04.000Z'
  const media=key(key(prev,'reply'),'media')
  store.put('out',media,{at:Date.parse(after)-1000,status:'sent'})
  const model=async()=>({content:JSON.stringify({action:'continue',candidate:0,goal:'work',requiresFile:true})})
  for(const [timestamp,text,nudge] of [[before,'<@bot> ',true],[before,'<@bot> 换一首配乐',false],[after,'<@bot>',false]]) {
    const run={id:'next',m:{...m,id:'ping',text,at:timestamp,mention:true,mentions:[{id:'bot',self:true}]}}
    const route=await decideConversation({store,model},run)
    assert.equal(route.acknowledgmentOf,nudge?prev:undefined)
    if(nudge) assert.equal(route.requiresFile,false)
  }
})

test('技能安装只汇报执行结果，另行索要文件仍须交付', async (t) => {
  const store = new Store(':memory:')
  t.after(() => store.db.close())
  store.put('config', 'main', {
    ...store.config(),
    providers: { chat: { base: 'http://unused', model: 'fixture' } },
  })
  const m = { group: 'group', id: 'previous', author: 'member', at: new Date().toISOString(),
    text: '安装这个技能库', thread: 'install', refs: [], parts: [] }
  store.put('run', 'previous', { id: 'previous', state: 'done', m, ticket: 'existing-session' })
  for (const [text, goal, needsFile] of [
    ['继续安装技能', 'setup', false],
    ['安装后把使用说明整理成文档发给我', 'document', true],
    ['帮我打包这个技能并发给我', 'work', true],
  ]) {
    const route = await decideConversation({
      store, model: async () => ({ content: JSON.stringify({
        action: 'continue', candidate: 0, goal, requiresFile: true,
      }) }),
    }, { id: 'current', m: { ...m, id: 'current', text } })
    assert.equal(route.action, 'continue')
    assert.equal(route.session, 'existing-session')
    assert.equal(route.requiresFile, needsFile)
  }
})

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
  s.message({ ...parent, id: 'card', idx: 'card', thread: 'card-thread', author: 'a1' })
  const edited = await decideConversation(runtime, {
    ...next,
    m: { ...next.m, author: 'a1', refs: ['card'], inferredRef: 'card' },
  })
  assert.equal(edited.action, 'continue')
  assert.equal(edited.source, key('old', 'reply'))
  action = 'chat'
  assert.equal((await decideConversation(runtime, next)).thread, 'thread1')
  s.del('run', 'old')
  action = 'continue'
  const firstTask = await decideConversation(runtime, next)
  assert.equal(firstTask.action, 'new')
  assert.equal(firstTask.source, 'reply')
})
test('明确要求安静的消息只记入历史，重复的 @ 事件不会触发回答，下一条照常处理', (t) => {
  const s = new Store(':memory:')
  t.after(() => s.db.close())
  const r = new Runtime(s, {})
  const event = {group_openid:'g', id:'quiet', author:{id:'a'}, content:'<@bot> 你先别说话'}
  r.receive('GROUP_MESSAGE_CREATE', event)
  r.receive('GROUP_AT_MESSAGE_CREATE', event)
  r.receive('GROUP_AT_MESSAGE_CREATE', {...event,id:'quiet2',content:'<@bot> 闭嘴'})
  assert.ok(s.lookup('g','quiet'))
  assert.equal(s.all('run').length,0)
  assert.equal(s.all('out').length,0)
  r.receive('GROUP_AT_MESSAGE_CREATE', {...event,id:'next',content:'你现在可以说话了'})
  assert.equal(s.all('run').length,1)
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
