import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../app/store.mjs'
import { Capabilities } from '../app/capabilities.mjs'
import { Runtime } from '../app/runtime.mjs'
import { key } from '../app/messages.mjs'
import { createHash } from 'node:crypto'
import { audioClipRequest, musicSource, packageWheels } from '../app/sandbox-tools.mjs'

test('安装包接受 py2.py3 wheel，校验 PyPI 摘要后才交给沙箱', async () => {
  const bytes = Buffer.from('wheel fixture'),
    url = 'https://files.pythonhosted.org/packages/test.whl'
  const metadata = {
    info: { name: 'pydub', version: '0.25.1' },
    urls: [
      {
        filename: 'pydub-0.25.1-py2.py3-none-any.whl',
        url,
        size: bytes.length,
        digests: { sha256: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
  }
  const download = async (link) => ({
    bytes: link === url ? bytes : Buffer.from(JSON.stringify(metadata)),
  })
  assert.equal((await packageWheels(['pydub==0.25.1'], download))[0].version, '0.25.1')
  metadata.urls[0].digests.sha256 = 'wrong'
  await assert.rejects(packageWheels(['pydub==0.25.1'], download), /校验失败/)
})

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-audio-')),
    s = new Store(':memory:'),
    c = new Capabilities(s, dir)
  t.after(() => {
    s.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  s.put('config', 'main', {
    ...s.config(),
    providers: { chat: { base: 'http://unused', model: 'fixture' } },
  })
  return { s, c }
}
test('上一条音乐卡片自动关联并走实际裁剪，音频入队且跨群不可访问', async (t) => {
  const { s, c } = setup(t)
  const r = new Runtime(s, c, {
    model: () => {
      throw Error('明确剪辑无需模型猜测')
    },
  })
  c.download = async (url) => {
    assert.equal(url, 'https://music.163.com/song/media/outer/url?id=3403402315.mp3')
    return { mime: 'audio/mpeg', bytes: Buffer.from('source') }
  }
  c.sandbox = async (body) => {
    assert.equal(body.op, 'audio')
    assert.equal(body.start, 95)
    return { data: Buffer.from('clip').toString('base64'), end: 180, duration: 85 }
  }
  r.receive('GROUP_MESSAGE_CREATE', {
    id: 'song',
    group_openid: 'g',
    author: { id: 'u' },
    content: '[卡片消息]',
    ark_data: {
      fields: {
        title: '牵丝戏',
        tag: '网易云音乐',
        jump_url: 'https://y.music.163.com/m/song?id=3403402315',
      },
    },
  })
  const m = r.receive('GROUP_AT_MESSAGE_CREATE', {
    id: 'cut',
    group_openid: 'g',
    author: { id: 'u' },
    content: '截取上面的音乐，从1：35后面开始',
  })
  assert.deepEqual(m.refs, ['song'])
  await r.process(s.get('run', key('g', 'cut')))
  const run = s.get('run', key('g', 'cut'))
  assert.equal(run.state, 'done')
  assert.ok(run.ticket)
  assert.equal((await c.file('g', run.artifact)).mime, 'audio/mpeg')
  assert.equal(s.all('out').filter((o) => o.artifact).length, 1)
  await assert.rejects(c.file('other', run.artifact))
})
test('音源受限时保留实际失败，不能宣称剪辑成功', async (t) => {
  const { s, c } = setup(t)
  const ctx = { config: s.config(), m: { group: 'g' } }
  c.download = async () => ({ mime: 'text/html', bytes: Buffer.from('login') })
  await assert.rejects(
    c.run('resolveAudioSource', { url: 'https://music.163.com/song?id=123' }, ctx),
    /未提供公开音频/,
  )
  assert.equal(s.all('resource').length, 0)
})
test('沙箱输出收回作品，拒绝关闭群、越界文件名与安装命令注入', async (t) => {
  const { s, c } = setup(t),
    m = { group: 'g' }
  c.sandbox = async () => ({
    exit: 0,
    output: 'ok',
    files: [{ name: 'cut.mp3', data: Buffer.from('clip').toString('base64') }],
  })
  const result = await c.run(
    'runCode',
    { code: 'pass', outputs: ['cut.mp3'] },
    { config: s.config(), m, worker: true },
  )
  assert.ok(result.data.artifact)
  await assert.rejects(
    c.run('runCode', { code: 'pass', outputs: ['../cut.mp3'] }, { config: s.config(), m, worker: true }),
    /输出需/,
  )
  await assert.rejects(
    c.run(
      'runCode',
      { code: 'pass' },
      { config: { ...s.config(), groups: { g: { code: false } } }, m, worker: true },
    ),
    /未授权/,
  )
  await assert.rejects(packageWheels(['--index-url=https://evil.invalid']), /包名/)
  assert.deepEqual(audioClipRequest('截取音频，从1：35到2:10'), { start: 95, end: 130 })
  assert.equal(musicSource('https://music.163.com.evil.invalid/song?id=1'), undefined)
})
