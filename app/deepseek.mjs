import { auth, remote } from './network.mjs'
import ipaddr from 'ipaddr.js'
const url = (p, tool) => p.base.replace(/\/$/, '') + '/v1/tools/' + tool
const post = (p, tool, input) =>
  remote(url(p, tool), {
    method: 'POST',
    headers: { ...auth(p), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
export async function search(p, query, domain, range) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[range]
  const filters =
    (domain && /^[\w.-]+$/.test(domain) ? ' site:' + domain : '') +
    (days ? ' after:' + new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : '')
  if (filters.length >= 127) throw Error('搜索范围过长')
  const q = [...query.trim()].slice(0, 128 - filters.length).join('') + filters
  const { results } = await post(p, 'search', { query: q, count: 5 })
  return results.map(({ title, url, snippet, summary }) => ({ title, url, snippet: summary || snippet }))
}
export async function read(p, href) {
  const link = new URL(href)
  if (
    !['http:', 'https:'].includes(link.protocol) ||
    link.username ||
    link.password ||
    /^(localhost|127\.|\[::1\])/.test(link.hostname) ||
    /[?&](rkey|auth_token|access_token|signature)=/i.test(link.search)
  )
    throw Error('只可提交公开网页链接')
  const host = link.hostname.replace(/^\[|\]$/g, '')
  if (
    (!host.includes('.') && !ipaddr.isValid(host)) ||
    /\.(local|localhost|internal)$/i.test(host) ||
    (ipaddr.isValid(host) && ipaddr.process(host).range() !== 'unicast')
  )
    throw Error('需要公开网页地址')
  const page = await post(p, 'fetch', { url: link.href })
  return {
    title: page.title,
    url: link.href,
    text: (page.content || '').slice(0, 14000),
    status: page.content ? 'read' : 'restricted',
  }
}
export async function transcribe(p, chunks) {
  const segments = []
  for (const chunk of chunks) {
    const form = new FormData()
    form.set('file', new Blob([Buffer.from(chunk.data, 'base64')], { type: 'audio/ogg' }), 'clip.ogg')
    const result = await remote(url(p, 'asr'), { method: 'POST', headers: auth(p), body: form })
    segments.push([chunk.at, chunk.at + result.duration_ms / 1000, result.text])
  }
  return segments
}
export async function recognize(p, file) {
  const form = new FormData()
  form.set(
    'file',
    new Blob([file.bytes], { type: file.mime }),
    'input.' + ({ 'image/jpeg': 'jpg', 'application/pdf': 'pdf' }[file.mime] || file.mime.split('/')[1]),
  )
  form.set('purpose', 'text_recognition')
  const data = await remote(url(p, 'ocr'), { method: 'POST', headers: auth(p), body: form })
  return data.pages.map((page) => ({
    page: page.index + 1,
    text: page.text.slice(0, 12000),
    finish: page.finish_reason,
  }))
}
export async function synthesize(p, text, voice = 'stella') {
  if (typeof text !== 'string' || !text.trim() || [...text].length > 1000)
    throw Error('单条语音支持 1～1000 字')
  const r = await fetch(url(p, 'tts'), {
    method: 'POST',
    headers: { ...auth(p), 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'wav' }),
    redirect: 'error',
    signal: AbortSignal.timeout(100000),
  })
  if (!r.ok) throw Error('语音合成返回 HTTP ' + r.status)
  const bytes = Buffer.from(await r.arrayBuffer())
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw Error('语音合成返回格式异常')
  return bytes
}
