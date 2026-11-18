// Run inside a separate Compose deployment with a model configured and QQ disconnected.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
const token = process.env.ADMIN_TOKEN || readFileSync('/state/admin-token', 'utf8').trim()
async function api(path, data) {
  const r = await fetch('http://localhost:8787/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  })
  const out = await r.json()
  assert.equal(r.status, 200, out.error)
  return out
}
assert.ok(!(await api('state')).config.qq.appId, 'Use a disconnected test instance')
const group = 'replay-' + randomUUID(),
  author = { id: 'alice' }
const event = (t, id, content, extra = {}) =>
  api('replay', { t, d: { id, group_openid: group, author, content, ...extra } })
await event('GROUP_MESSAGE_CREATE', 'music', '[卡片消息]', {
  ark_data: {
    fields: {
      title: '牵丝戏（DJ亚明版）',
      tag: '网易云音乐',
      jump_url: 'https://y.music.163.com/m/song?id=3403402315',
    },
  },
})
const question = '截取上面的音乐，从1：35后面开始'
await event('GROUP_AT_MESSAGE_CREATE', 'clip', question)
const deadline = Date.now() + 560000
while (Date.now() < deadline) {
  const snapshot = await api('state')
  const run = snapshot.runs.find((r) => r.group === group && r.question === question)
  if (run && ['done', 'failed'].includes(run.state)) {
    const detail = await api('run', { id: run.id })
    console.log(
      JSON.stringify({
        group,
        state: run.state,
        ticket: run.ticket,
        executor: detail.executor,
        route: detail.route,
        steps: detail.steps,
        answer: run.answer,
      }),
    )
    assert.equal(run.state, 'done')
    assert.ok(run.ticket)
    assert.equal(detail.executor, 'harness')
    assert.ok(detail.steps.some((s) => s.name === 'Harness' && s.detail.includes('bash')))
    const media = snapshot.deliveries.filter((o) => o.group === group && o.artifact)
    assert.equal(media.length, 1)
    console.log(JSON.stringify({ artifact: media[0].artifact }))
    await event('GROUP_AT_MESSAGE_CREATE', 'clip', question)
    assert.equal(
      (await api('state')).deliveries.filter((o) => o.group === group && o.artifact).length,
      1,
    )
    process.exit(0)
  }
  await delay(1500)
}
throw Error('QQ replay did not complete in time')
