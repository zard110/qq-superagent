import http from 'node:http'
import net from 'node:net'
import { chromium, devices } from 'playwright-core'
import { publicAddress } from './app/network.mjs'

// Chromium uses a local proxy which pins every connection to a verified public IP.
const proxy = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url)
    if (url.protocol !== 'http:' || url.username || url.password || (url.port && url.port !== '80'))
      throw Error()
    const ip = await publicAddress(url.hostname)
    const upstream = http.request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        lookup: (_host, _options, cb) => cb(null, ip.address, ip.family),
        autoSelectFamily: false,
        agent: false,
        signal: AbortSignal.timeout(20000),
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers)
        response.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  } catch {
    res.writeHead(403).end()
  }
})
proxy.on('connect', async (req, client, head) => {
  client.on('error', () => {})
  try {
    const url = new URL('https://' + req.url)
    if (url.port && url.port !== '443') throw Error()
    const ip = await publicAddress(url.hostname.replace(/^\[|\]$/g, ''))
    if (client.destroyed) return
    const upstream = net.connect({ host: ip.address, port: 443 })
    const timer = setTimeout(() => {
      upstream.destroy()
      client.destroy()
    }, 30000)
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('close', () => {
      clearTimeout(timer)
      upstream.destroy()
    })
  } catch {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  }
})
await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok))
let active = 0
http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/read') {
      res.writeHead(404).end()
      return
    }
    if (active >= 2) {
      res.writeHead(429).end()
      return
    }
    active++
    let browser
    try {
      let input = ''
      for await (const part of req) {
        input += part
        if (input.length > 12000) throw Error('链接请求过大')
      }
      const { url } = JSON.parse(input),
        link = new URL(url)
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password)
        throw Error('需要公开网页链接')
      await publicAddress(link.hostname.replace(/^\[|\]$/g, ''))
      browser = await chromium.launch({
        executablePath: '/usr/bin/chromium',
        headless: true,
        proxy: { server: 'http://127.0.0.1:' + proxy.address().port },
        args: ['--disable-dev-shm-usage', '--proxy-bypass-list=<-loopback>', '--disable-quic'],
      })
      const context = await browser.newContext({
        ...devices['Pixel 7'],
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        serviceWorkers: 'block',
      })
      await context.route('**/*', (route) => {
        if (['image', 'media', 'font'].includes(route.request().resourceType())) return route.abort()
        return route.continue()
      })
      const page = await context.newPage()
      let status
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
          status = response.status()
      })
      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {})
      let snapshot
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          snapshot = await page.evaluate(() => ({
            html: document.documentElement.outerHTML,
            url: location.href,
            device: {
              mobile: /Mobile/.test(navigator.userAgent),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }))
          break
        } catch (e) {
          if (attempt === 2) throw e
          await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {})
        }
      }
      if (Buffer.byteLength(snapshot.html) > 5e6) throw Error('网页内容过大')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...snapshot, status }))
    } catch (e) {
      res.writeHead(422, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          detail:
            e.name === 'TimeoutError'
              ? '移动浏览器加载超时'
              : '移动浏览器访问失败（' +
                (e.message.match(/net::ERR_[A-Z_]+/)?.[0] ||
                  e.message
                    .split('\n')[0]
                    .replace(/https?:\/\/\S+/g, '[页面链接]')
                    .slice(0, 180)) +
                '）',
        }),
      )
    } finally {
      await browser?.close().catch(() => {})
      active--
    }
  })
  .listen(8091, '0.0.0.0')
