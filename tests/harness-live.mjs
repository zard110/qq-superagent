// Run inside the app container against its authenticated panel; never sends a QQ message.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const token = process.env.ADMIN_TOKEN || readFileSync('/state/admin-token', 'utf8').trim()
const [mode = 'create', session = 'acceptance-v1'] = process.argv.slice(2)
const prompts = {
  create:
    '在当前任务目录实际运行 shell，写入 count.txt 值 17 并读回。记住暗号蓝松果，不要把暗号写进文件。只答数字。',
  resume: '继续先前任务。用 shell 将 count.txt 中的数字加 1，保存并读回。回复之前约定的暗号及新数字。',
  packages:
    '实际用 python -m pip install pyfiglet、npm install -g cowsay 和 qq-tool install-deb tree 安装三个工具。分别调用导入 pyfiglet、运行 cowsay、运行 tree --version。只报告实际结果。',
  video:
    '对输入视频从第0秒起每隔10秒取一帧，标注时间，按每行2张拼成一张 PNG，保存到指定输出目录。检查帧数和图片尺寸，报告结果。',
  revise: '继续上一张拼图，将第二排放大一倍，重新导出 PNG 到本轮指定输出目录。',
}
const data = {
  name: 'harness',
  session,
  question: prompts[mode],
  requiresFile: ['video', 'revise'].includes(mode),
}
if (mode === 'video')
  data.file = { mime: 'video/mp4', data: readFileSync('/tmp/qq-test-clip.mp4').toString('base64') }
const r = await fetch('http://localhost:8787/api/test', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(data),
})
const out = await r.json()
console.log(JSON.stringify(out))
assert.equal(r.status, 200)
if (mode === 'resume') {
  assert.match(out.answer, /蓝松果/)
  assert.match(out.answer, /18/)
}
if (['video', 'revise'].includes(mode)) assert.ok(out.artifact)
