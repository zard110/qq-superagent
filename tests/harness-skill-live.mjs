// Execute inside a group worker from /opt/harness. Uses a loopback model fixture.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
const dir = await mkdtemp('/work/tasks/skill-check-'),
  name = process.argv[2] || 'novel-script'
const server = http.createServer(async (req, res) => {
  let input = ''
  for await (const chunk of req) input += chunk
  const data = JSON.parse(input)
  const second = data.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
  )
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type, fields) =>
    res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n')
  event('message_start', {
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: data.model,
      content: [],
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  })
  event('content_block_start', {
    index: 0,
    content_block: second
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: 'call_test', name: 'skill', input: {} },
  })
  event('content_block_delta', {
    index: 0,
    delta: second
      ? { type: 'text_delta', text: 'checked' }
      : { type: 'input_json_delta', partial_json: JSON.stringify({ name }) },
  })
  event('content_block_stop', { index: 0 })
  event('message_delta', {
    delta: { stop_reason: second ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: 10 },
  })
  event('message_stop', {})
  res.end()
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const h = new DeepSeekHarness({
  profile: 'sdk',
  dshHome: join(dir, '.harness'),
  processCwd: dir,
  cwd: dir,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  env: {
    ...process.env,
    DSH_AGENTS_HOME: '/work/home/.agents',
    DEEPSEEK_API_KEY: 'local-fixture',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    DSH_PERMISSION_MODE: 'danger-full-access',
  },
})
try {
  const session = h.session('skill-check')
  await session.setWorkingDirectory(dir)
  const result = await session.run('Load the installed skill.')
  const responses = result.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => JSON.stringify(e.data.message.content))
  assert.ok(
    responses.some(
      (s) =>
        s.includes(name) && s.includes('skill_content') && !s.includes('unknown or no longer available'),
    ),
    responses.map((r) => r.slice(0, 180)).join(','),
  )
  console.log('Fresh SDK session loaded', name)
} finally {
  await h.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
}
