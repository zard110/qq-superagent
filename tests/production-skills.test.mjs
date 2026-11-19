import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerSkills } from '../harness/production-skills.mjs'

test('整片委托使用 QQ 投产入口并复用任务素材，预览仍用群内原版', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-skills-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const installed = join(dir, 'installed')
  await mkdir(installed)
  const job = {ticket:'t', productionMode:'deliver', executionQuote:'剪好发群里', requiresFile:true}
  const plain = await workerSkills(dir, installed, job)
  assert.equal(plain.directory, installed)
  for (const name of ['short-drama','short-drama-produce','short-drama-assets']) {
    await mkdir(join(installed,name))
    await writeFile(join(installed,name,'SKILL.md'), '先看预览，确认后执行')
    await writeFile(join(installed,name,'reference.txt'), 'asset')
  }
  const view = await workerSkills(dir,installed,job)
  assert.notEqual(view.sessionId, plain.sessionId)
  assert.equal((await workerSkills(dir,installed,job)).sessionId, view.sessionId)
  assert.match(await readFile(join(view.directory,'short-drama-produce','SKILL.md'),'utf8'), /qq-tool media TOOL ITEM/)
  assert.doesNotMatch(await readFile(join(view.directory,'short-drama','SKILL.md'),'utf8'), /先看预览/)
  assert.equal(await readFile(join(view.directory,'short-drama-assets','reference.txt'),'utf8'),'asset')
  assert.equal(await readFile(join(installed,'short-drama-produce','SKILL.md'),'utf8'),'先看预览，确认后执行')
  for (const overrides of [{productionMode:undefined},{executionQuote:undefined},{requiresFile:false}])
    assert.deepEqual(await workerSkills(dir,installed,{...job,...overrides}),plain)
})
