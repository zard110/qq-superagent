import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../app/store.mjs'
import {Capabilities} from '../app/capabilities.mjs'
import {savePlugins} from '../app/plugins/memes.mjs'
import {workerTools} from '../app/harness.mjs'

test('按群挑选本地斗图，保留 GIF 原件，避开刚用过的图',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'memes-'))
  const store=new Store(':memory:')
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true})})
  const caps=new Capabilities(store,join(dir,'assets'))
  const items=['敲桌子','拍桌','开心'].map((title,i)=>({id:String(i+1).repeat(40),title,mime:'image/gif',pack:'015'}))
  mkdirSync(join(dir,'memes/files'),{recursive:true})
  writeFileSync(join(dir,'memes/index.json'),JSON.stringify({items}))
  for(const i of items) writeFileSync(join(dir,'memes/files',i.id),'GIF89a')
  const ctx={m:{group:'g',id:'1'},config:store.config(),social:true}
  savePlugins(store,'g',{mode:'social',packs:['015']})
  const toolNames=group=>workerTools(caps,ctx.config,group).map(v=>v.spec.name)
  assert.ok(toolNames('g').includes('pickMeme'))
  assert.ok(!toolNames('other').includes('pickMeme'))
  const search=async()=>(await caps.run('searchMemes',{query:'生气'},ctx)).data.candidates
  const hit=(await search())[0]
  assert.match(hit.caption,/桌/)
  const result=await caps.run('pickMeme',{id:hit.id},ctx)
  assert.equal((await caps.file('g',result.data.artifact)).mime,'image/gif')
  assert.notEqual((await search())[0].id,hit.id)
  savePlugins(store,'g',{mode:'requested',packs:['015']})
  await assert.rejects(caps.run('pickMeme',{id:hit.id},ctx),/未开启/)
})

