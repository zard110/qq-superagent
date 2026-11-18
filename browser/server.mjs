import http from 'node:http'
import net from 'node:net'
import { chromium, devices } from 'playwright-core'
import { publicAddress, parseDocument } from './app/network.mjs'

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
// Open only the images the note itself publishes, in the same mobile browser context.
async function openGallery(page, html, finalUrl) {
  const context = page.context()
  const { images, videos, videoCount, status } = parseDocument(html, finalUrl)
  const gallery = { total: images.length, frames: [] }
  const note = /(?:^|\.)(?:rednote|xiaohongshu)\.com$/i.test(new URL(finalUrl).hostname)
  const limit = note ? images.length : Math.min(6, images.length)
  const until = Date.now() + 50000
  let encodedSize = 0
  if (status === 'restricted') return gallery
  async function openFrame(url, index) {
    const tab = await context.newPage()
    try {
      const response = await tab.goto(url, {
        referer: finalUrl,
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      })
      if (!response?.ok() || !/^image\//i.test(response.headers()['content-type'] || '')) return
      const img = tab.locator('body > img').first()
      await img.waitFor({ timeout: 2500 })
      const data = await img.evaluate(async (image) => {
        await Promise.race([
          image.decode(),
          new Promise((_, reject) => setTimeout(() => reject(Error('decode timeout')), 4000)),
        ])
        const { naturalWidth: w, naturalHeight: h } = image
        if (!w || !h) return
        const k = Math.min(1, 1800 / Math.max(w, h))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * k))
        canvas.height = Math.max(1, Math.round(h * k))
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', 0.86).split(',')[1]
      })
      if (data && data.length <= 2_000_000 && encodedSize + data.length <= 16_000_000) {
        encodedSize += data.length
        gallery.frames.push({ position: index + 1, data })
      }
    } catch {
      // A missing slide must not hide readable text or successful slides.
    } finally {
      await tab.close()
    }
  }
  for (let i = 0; i < limit && Date.now() < until && encodedSize < 16_000_000; i += 2)
    await Promise.all(images.slice(i, i + 2).map((url, j) => openFrame(url, i + j)))
  gallery.frames.sort((a, b) => a.position - b.position)
  // A native player may expose only a blob or streaming playlist. Its decoded frame is still evidence.
  if (videoCount && (!videos.length || videos.every((url) => /\.(m3u8|mpd)(?:[?#]|$)/i.test(url)))) {
    const players = page.locator('video')
    gallery.videoFrames = []
    for (let i = 0; i < Math.min(await players.count(), 2); i++) {
      const player = players.nth(i)
      try {
        const at = await player.evaluate(async (v) => {
          if (v.closest('aside,nav,header,footer,[class*="recommend"]') || !v.checkVisibility()) return
          if (v.readyState < 2)
            await Promise.race([
              new Promise((ok) => v.addEventListener('loadeddata', ok, { once: true })),
              new Promise((ok) => setTimeout(ok, 1800)),
            ])
          if (v.readyState >= 2 && v.videoWidth && v.currentTime > 0) {
            v.pause()
            return v.currentTime
          }
        })
        if (typeof at !== 'number') continue
        const bytes = await player.screenshot({ type: 'jpeg', quality: 82, timeout: 3000 })
        if (bytes.length < 900000)
          gallery.videoFrames.push({ position: i + 1, at, data: bytes.toString('base64') })
      } catch {}
    }
  }
  return gallery
}

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
          snapshot = await page.evaluate(() => {
            for (const media of document.querySelectorAll('img,video')) {
              if (media.currentSrc) media.setAttribute('data-browser-src', media.currentSrc)
            }
            return {
              html: document.documentElement.outerHTML,
              url: location.href,
              device: {
                mobile: /Mobile/.test(navigator.userAgent),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
            }
          })
          break
        } catch (e) {
          if (attempt === 2) throw e
          await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {})
        }
      }
      if (Buffer.byteLength(snapshot.html) > 5e6) throw Error('网页内容过大')
      res.setHeader('content-type', 'application/json')
      const final = new URL(snapshot.url)
      const notePath = /^\/(?:discovery\/item|explore)\/([a-f\d]{24})\/?$/i
      const requestedId = link.pathname.match(notePath)?.[1]
      const finalId = final.pathname.match(notePath)?.[1]
      if (requestedId && finalId && requestedId !== finalId) throw Error('分享链接已跳转至另一篇笔记')
      if (status < 400 && (!requestedId || requestedId === finalId))
        snapshot.gallery = await openGallery(page, snapshot.html, snapshot.url)
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
