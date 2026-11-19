import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../app/store.mjs'
import { decideConversation } from '../app/conversation.mjs'
import { parseDocument } from '../app/network.mjs'
import { fetchSkillArchive } from '../app/github-skill.mjs'

test('换人补充公开搜索关键词可以接着查，保持独立工作区', async (t) => {
  const store = new Store(':memory:')
  t.after(() => store.db.close())
  store.put('config', 'main', {
    ...store.config(),
    providers: { chat: { model: 'fixture', base: 'http://unused' } },
  })
  const m = {
    id: 'previous',
    idx: 'previous',
    group: 'g',
    author: 'a',
    at: '2026-11-19T00:00:00Z',
    text: '请查市级资助项目',
    thread: 'old',
    parts: [],
    refs: [],
  }
  store.message(m)
  store.put('run', 'previous', {
    id: 'previous',
    m,
    state: 'done',
    ticket: 'other-work',
    answer: '找到了项目名录',
  })
  const route = await decideConversation(
    {
      store,
      model: async () => ({
        content: JSON.stringify({
          action: 'continue',
          candidate: 0,
          productTool: 'searchWeb',
          goal: 'answer',
          requiresFile: false,
        }),
      }),
    },
    { id: 'next', m: { ...m, id: 'next', author: 'b', text: '再加上园区关键词查一下' } },
  )
  assert.equal(route.action, 'chat')
  assert.equal(route.productTool, 'searchWeb')
  assert.equal(route.session, undefined)
  assert.equal(route.followupContext.request, m.text)
})

test('移动搜索结果提取落地链接，忽略无效的跳转项', () => {
  const site = 'https://example.org/details'
  const target = Buffer.from(site).toString('base64url')
  const html =
    '<title>Search results</title><ul><li class="b_algo"><a href="/ck/a?u=a1' +
    target +
    '">查阅原始公告详情</a><p>公示</p></li></ul>'
  assert.equal(parseDocument(html, 'https://www.bing.com/search?q=test').resultLinks[0].url, site)
})

test('公开技能获取只访问指定仓库的归档，不转发凭据或跟随跳转', async () => {
  let calls = 0
  const download = async (url, limit, redirects) => {
    calls++
    assert.equal(url, 'https://codeload.github.com/org/repo/zip/HEAD')
    assert.equal(redirects, 0)
    assert.ok(limit > 0)
    return { bytes: Buffer.from([80, 75, 3, 4]) }
  }
  for (const input of [
    'org/..',
    'org/repo?next=foo',
    'https://other.example/org/repo',
    'https://a:b@github.com/org/repo',
  ])
    await assert.rejects(fetchSkillArchive(input, download))
  assert.equal((await fetchSkillArchive('https://github.com/org/repo.git', download)).repo, 'org/repo')
  assert.equal(calls, 1)
})
