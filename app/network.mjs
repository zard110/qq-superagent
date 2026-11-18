import https from 'node:https'
import http from 'node:http'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { load } from 'cheerio'

export async function publicFile(input, limit = 2_000_000, redirects = 4) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw Error('仅支持标准端口的公开网页')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let ips = await lookup(host, { all: true })
  // Some desktop VPNs return benchmark-range synthetic addresses for every public hostname.
  // Resolve the public name independently, then apply the same address check and pin the connection.
  const synthetic = ipaddr.parseCIDR('198.18.0.0/15')
  if (
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) &&
    ips.length &&
    ips.every(({ address }) => {
      const ip = ipaddr.process(address)
      return ip.kind() === 'ipv4' && ip.match(synthetic)
    })
  ) {
    const dns = await remote('https://dns.google/resolve?type=A&name=' + encodeURIComponent(host), {
      signal: AbortSignal.timeout(6500),
    })
    ips = (dns.Answer || []).filter((row) => row.type === 1).map((row) => ({ address: row.data, family: 4 }))
  }
  if (!ips.length || ips.some((ip) => ipaddr.process(ip.address).range() !== 'unicast'))
    throw Error('地址不属于公开网络')
  const ip = ips[0]
  const response = await new Promise((ok, fail) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        agent: false,
        autoSelectFamily: false,
        lookup: (name, opts, cb) => cb(null, ip.address, ip.family),
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': 'GroupStudio/1.0', 'accept-encoding': 'identity' },
      },
      ok,
    )
    req.on('error', fail)
  })
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects) {
    response.destroy()
    return publicFile(new URL(response.headers.location, url), limit, redirects - 1)
  }
  if (response.statusCode !== 200) {
    response.destroy()
    throw Error('网页或附件返回 HTTP ' + response.statusCode)
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of response) {
    bytes += chunk.length
    if (bytes > limit) {
      response.destroy()
      throw Error('资源超过大小限制')
    }
    chunks.push(chunk)
  }
  return {
    bytes: Buffer.concat(chunks),
    mime: (response.headers['content-type'] || '').split(';')[0],
    url: String(url),
  }
}
export async function readPage(url) {
  const file = await publicFile(url)
  if (!/text\/html|application\/xhtml|text\/plain/.test(file.mime)) throw Error('链接没有返回可读网页')
  const $ = load(file.bytes.toString())
  $('script,style,nav,footer,form,header,aside,noscript').remove()
  const title = $('title').text().trim()
  const text = ($('article').first().text() || $('main').first().text() || $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14000)
  const restricted =
    !text ||
    /^(安全验证|登录|sign in|just a moment)/i.test(title) ||
    /请.{0,4}登录后.{0,4}(查看|阅读)|访问异常|验证后继续/.test(text.slice(0, 500))
  return { title, url: file.url, text: restricted ? '' : text, status: restricted ? 'restricted' : 'read' }
}
export async function remote(url, options = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(100_000), redirect: 'error', ...options })
  if (!r.ok) {
    const e = Error('服务返回 HTTP ' + r.status)
    e.status = r.status
    throw e
  }
  return r.json()
}
export function provider(config, role) {
  const p = config.providers[role] || (['vision', 'worker'].includes(role) ? config.providers.chat : null)
  if (!p?.base || (!p.model && ['chat', 'worker', 'vision', 'speech'].includes(role)))
    throw Error('请在面板配置 ' + role + ' 供应商与模型')
  return p
}
export const auth = (p) => (p.key ? { Authorization: 'Bearer ' + p.key } : {})
export async function chat(p, messages, tools) {
  const data = await remote(p.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { ...auth(p), 'content-type': 'application/json' },
    body: JSON.stringify({ model: p.model, messages, ...(tools?.length ? { tools } : {}) }),
  })
  if (!data.choices?.[0]?.message) throw Error('模型响应缺少消息')
  return data.choices[0].message
}
