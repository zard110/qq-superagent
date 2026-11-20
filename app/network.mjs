import https from 'node:https'
import http from 'node:http'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { load } from 'cheerio'

export async function publicFile(input, limit = 2_000_000, redirects = 4, document = false) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw Error('仅支持标准端口的公开网页')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const ip = await publicAddress(host)
  const response = await new Promise((ok, fail) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        agent: false,
        autoSelectFamily: false,
        lookup: (name, opts, cb) => cb(null, ip.address, ip.family),
        signal: AbortSignal.timeout(limit >= 24 * 1024 * 1024 ? 60_000 : 25_000),
        headers: {
          'user-agent': document
            ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36'
            : 'GroupStudio/1.0',
          'accept-encoding': 'identity',
          ...(document
            ? { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' }
            : {}),
        },
      },
      ok,
    )
    req.on('error', fail)
  })
  if (
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.headers.location &&
    redirects
  ) {
    response.destroy()
    return publicFile(new URL(response.headers.location, url), limit, redirects - 1, document)
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
  if (process.env.BROWSER_URL) {
    const response = await fetch(process.env.BROWSER_URL + '/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(100000),
    })
    const data = await response.json()
    if (!response.ok) throw Error(data.detail || '移动浏览器访问失败')
    const page = parseDocument(data.html, data.url)
    if (data.gallery) page.gallery = data.gallery
    if (data.status >= 400) {
      page.status = 'restricted'
      page.text = ''
      page.images = []
      page.videos = []
      page.videoCount = 0
      delete page.gallery
      page.detail = '移动浏览器收到原站 HTTP ' + data.status
    }
    return page
  }
  const file = await publicFile(url, 3_000_000, 4, true)
  if (!/text\/html|application\/xhtml|text\/plain/.test(file.mime)) throw Error('链接没有返回可读网页')
  return parseDocument(file.bytes.toString(), file.url)
}
export function parseDocument(html, url) {
  const $ = load(html)
  const resultLinks = []
  const host = new URL(url).hostname
  if (/(^|\.)bing\.com$/.test(host) && new URL(url).pathname === '/search') {
    for(const row of $('.b_algo').toArray()) {
      try {
        const item=$(row)
        const headline=item.find('h2 a, a:has(h2), .b_title a').first()
        const node=headline.length?headline:item.find('a[href]').filter((_,el)=>!$(el).hasClass('tilk') && $(el).text().trim().length>5).first()
        if (!node.attr('href'))continue
        const href=new URL(node.attr('href'),url)
        let destination=href.href
        if (/(^|\.)bing\.com$/.test(href.hostname) && href.pathname==='/ck/a') {
          const encoded=href.searchParams.get('u')
          if (!encoded?.startsWith('a1'))continue
          destination=Buffer.from(encoded.slice(2),'base64url').toString('utf8')
        }
        const parsed=new URL(destination)
        if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||resultLinks.some(r=>r.url===parsed.href))continue
        resultLinks.push({title:node.text().trim().slice(0,200),url:parsed.href,snippet:node.closest('.b_algo').find('p').first().text().trim().slice(0,500)})
      } catch {}
    }
  }
  const schemas = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((el) => {
      try {
        return [JSON.parse($(el).text())].flat().flatMap((v) => v?.['@graph'] || v || [])
      } catch {
        return []
      }
    })
  const article = schemas.find((node) =>
    [node?.['@type']]
      .flat()
      .some((t) => ['Article', 'BlogPosting', 'NewsArticle', 'SocialMediaPosting'].includes(t)),
  )
  $('script,style,nav,footer,form,header,aside,noscript').remove()
  const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim()
  const note = /(?:^|\.)(?:xiaohongshu|rednote)\.com$/.test(new URL(url).hostname)
  const noteText = note && $('.author-desc-content, #detail-desc').first().text().trim()
  const author =
    (note && $('.author-detail .author-username, .author-wrapper .username').first().text().trim()) ||
    [article?.author]
      .flat()
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter(Boolean)
      .join('、') ||
    $('meta[name="author"]').attr('content')?.trim() ||
    $('article [rel="author"]').first().text().trim()
  const description = $('meta[property="og:description"]').attr('content')?.trim()
  const text = (
    noteText ||
    (typeof article?.articleBody === 'string' && article.articleBody) ||
    $('article').first().text() ||
    (!note && ($('main').first().text() || $('body').text())) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14000)
  const scope = note
    ? '#noteContainer, .note-detail, .note-slider, .swiper-container, article'
    : 'article, [itemprop="articleBody"], main, [role="main"], .article-content, .post-content'
  const inArticle = (el) =>
    !$(el).closest('aside, nav, footer, header, [class*="recommend"], [class*="avatar"]').length &&
    ($(el).closest(scope).length || (!$(scope).length && el.tagName === 'video'))
  const mediaUrls = (values) => [
    ...new Set(
      values.flatMap((value) => {
        if (!value) return []
        try {
          const link = new URL(value, url)
          return /^https?:$/.test(link.protocol) && !link.username && !link.password ? [link.href] : []
        } catch {
          return []
        }
      }),
    ),
  ]
  const meta = (selector) =>
    $(selector)
      .toArray()
      .map((el) => $(el).attr('content'))
  const inlineImages = $('img')
    .toArray()
    .filter(inArticle)
    .map((el) => $(el).attr('data-browser-src') || $(el).attr('data-src') || $(el).attr('src'))
  const declaredImages = mediaUrls(
    meta('meta[property="og:image"], meta[property="og:image:secure_url"]'),
  )
  const images =
    note && declaredImages.length ? declaredImages : mediaUrls([...inlineImages, ...declaredImages])
  const players = $('video').toArray().filter(inArticle)
  const videoGroups = players.map((el) =>
    mediaUrls([
      $(el).attr('data-browser-src'),
      $(el).attr('src'),
      ...$(el)
        .find('source')
        .toArray()
        .map((source) => $(source).attr('src')),
    ]),
  )
  const declaredVideo = mediaUrls(
    meta(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    ),
  )
  const videos = mediaUrls([
    ...videoGroups.map(
      (links) => links.find((link) => /\.(mp4|webm|mov)(?:[?#]|$)/i.test(link)) || links[0],
    ),
    ...(players.length && videoGroups.some((links) => links.length) ? [] : declaredVideo),
  ])
  const login =
    /\/(?:login|signin)(?:\/|$)/i.test(new URL(url).pathname) ||
    /^(?:log\s*in|sign\s*in|登录)/i.test(title)
  const restricted =
    login ||
    (!text && !description && !players.length && !images.length && !videos.length) ||
    /^(安全验证|登录|sign in|just a moment)|安全中心|异常请求|访问受限/i.test(title) ||
    /请.{0,4}登录后.{0,4}(查看|阅读)|访问异常|验证后继续/.test(text.slice(0, 500))
  return {
    title,
    url,
    ...(resultLinks.length && !restricted && {resultLinks:resultLinks.slice(0,10)}),
    images: restricted ? [] : images.slice(0, 30),
    videos: restricted ? [] : videos.slice(0, 10),
    videoCount: restricted ? 0 : Math.max(players.length, videos.length),
    author: restricted ? undefined : author,
    text: restricted ? '' : text || description,
    status: restricted ? 'restricted' : text ? 'read' : 'metadata',
    detail: login ? '原链接进入登录页，未取得正文' : restricted ? '原网页受限或无可读正文' : undefined,
  }
}
export async function remote(url, options = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(100_000), redirect: 'error', ...options })
  if (!r.ok) {
    const e = Error('服务返回 HTTP ' + r.status)
    e.status = r.status
    if (new URL(url).origin === 'https://api.bot.qq.com') {
      const body = await r.json().catch(() => ({}))
      e.code = body?.code
    }
    throw e
  }
  return r.json()
}
export { requireProvider as provider } from './providers.mjs'
export const auth = (p) => (p.key ? { Authorization: 'Bearer ' + p.key } : {})
export async function chat(p, messages, tools, signal) {
  const data = await remote(p.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    ...(signal && { signal }),
    headers: { ...auth(p), 'content-type': 'application/json' },
    body: JSON.stringify({ model: p.model, messages, ...(p.effort ? { reasoning_effort: p.effort } : {}), ...(tools?.length ? { tools } : {}) }),
  })
  if (!data.choices?.[0]?.message) throw Error('模型响应缺少消息')
  return data.choices[0].message
}

export async function publicAddress(host) {
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
    const query = '?type=A&name=' + encodeURIComponent(host)
    const resolvers = host === 'multimedia.nt.qq.com.cn'
      ? ['https://dns.alidns.com/resolve', 'https://dns.google/resolve']
      : ['https://dns.google/resolve']
    const signal = AbortSignal.timeout(6500)
    try {
      ips = await Promise.any(resolvers.map(async endpoint => {
        const dns = await remote(endpoint + query, {signal})
        const addresses = (dns.Answer || []).filter(row => row.type === 1)
        if (!addresses.length) throw Error('没有 IPv4 地址')
        return addresses.map(row => ({address: row.data, family: 4}))
      }))
    } catch (cause) {
      throw Object.assign(Error('未能解析素材服务器域名', {cause}), {code:'EDNSLOOKUP'})
    }
  }
  if (!ips.length || ips.some((ip) => ipaddr.process(ip.address).range() !== 'unicast'))
    throw Error('地址不属于公开网络')
  return ips[0]
}
