import http from 'node:http'
import {rm} from 'node:fs/promises'
import {chromium} from 'playwright-core'

const entry = 'https://www.lkcoffee.com/'
const profile = '/home/node/luckin-session'
let context, page, queue = Promise.resolve()
let status = {state:'unchecked', detail:'尚未检查瑞幸顾客登录页'}
async function inspect(reload) {
  if (!context) {
    context = await chromium.launchPersistentContext(profile,{executablePath:'/usr/bin/chromium',headless:true,
      args:['--no-sandbox'],viewport:{width:960,height:800},locale:'zh-CN'})
    context.on('close',()=>{context=undefined;page=undefined})
    page = context.pages()[0] || await context.newPage()
    reload = true
  }
  if (reload) await page.goto(entry,{waitUntil:'domcontentloaded', timeout:18000})
  const body = await page.locator('body').innerText({timeout:5000})
  // Accept only an explicitly labelled personal sign-in control. The landing page also contains app and marketing QR codes.
  const qr = page.locator('img[alt*="扫码登录"], img[alt*="登录二维码"], [aria-label="登录二维码"] canvas').first()
  if (await qr.isVisible()) {
    return {state:'scan', detail:'请扫描瑞幸个人登录二维码，再刷新状态', image:(await qr.screenshot()).toString('base64')}
  }
  return {state:'blocked',detail:body.includes('下载APP') && body.includes('关注微信')
    ? '瑞幸顾客官网展示下载 App 和关注微信，当前页面没有供此浏览器登录个人账号的二维码。群点单暂停。'
    : '当前顾客页面未找到可验证的个人扫码登录、门店和菜单。群点单暂停。'}
}
http.createServer((req,res)=>{
  const send=(code,data)=>res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data))
  if (req.method==='GET' && req.url==='/status') return send(200,status)
  if (req.method!=='POST' || !['/check','/refresh','/logout'].includes(req.url)) return send(404,{})
  queue = queue.then(async()=>{
    if (req.url==='/logout') {
      await context?.close()
      await rm(profile,{recursive:true,force:true})
      status={state:'unchecked',detail:'浏览器登录资料已清除'}
    } else status={...await inspect(req.url==='/check'),at:Date.now()}
    send(200,status)
  }).catch(()=>{status={state:'error',detail:'专用浏览器未能读取瑞幸官网，可稍后重新检查'};send(503,status)})
}).listen(8092,'0.0.0.0')

