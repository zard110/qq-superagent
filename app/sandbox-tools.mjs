import { createHash } from 'node:crypto'
import { publicFile } from './network.mjs'

// The application only transfers data. Third-party code runs inside the offline worker.
export async function packageWheels(packages = [], download = publicFile) {
  if (!Array.isArray(packages) || packages.length > 8) throw Error('一次最多安装 8 个 Python 包')
  const wheels = []
  for (const spec of [...new Set(packages)]) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,79})(?:==([a-zA-Z0-9][a-zA-Z0-9.!+_-]{0,49}))?$/.exec(
      spec,
    )
    if (!match) throw Error('包名只支持 PyPI 名称或名称==版本，不接受网址和安装选项')
    const metadata = await download(
      'https://pypi.org/pypi/' + match[1] + (match[2] ? '/' + match[2] : '') + '/json',
      3e6,
    )
    const data = JSON.parse(metadata.bytes)
    const wheel = data.urls?.find((w) => !w.yanked && /-(?:py2\.)?py3-none-any\.whl$/.test(w.filename))
    if (!wheel) throw Error(spec + ' 没有支持的纯 Python wheel，需由部署者加入沙箱镜像')
    if (new URL(wheel.url).hostname !== 'files.pythonhosted.org' || wheel.size > 8e6)
      throw Error('工具包来源或大小不支持')
    const file = await download(wheel.url, 8e6)
    if (createHash('sha256').update(file.bytes).digest('hex') !== wheel.digests.sha256)
      throw Error('工具包校验失败')
    wheels.push({
      name: wheel.filename,
      data: file.bytes.toString('base64'),
      package: data.info.name,
      version: data.info.version,
    })
    if (wheels.reduce((n, w) => n + w.data.length, 0) > 20e6) throw Error('工具包总大小超过限制')
  }
  return wheels
}

export function musicSource(url) {
  const link = new URL(url)
  if (/(^|\.)music\.163\.com$/.test(link.hostname)) {
    const id = link.searchParams.get('id') || link.hash.match(/[?&]id=(\d+)/)?.[1]
    if (!/^\d+$/.test(id || '')) throw Error('音乐卡片缺少歌曲 ID')
    return 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3'
  }
}

export function audioClipRequest(text) {
  if (!/截取|裁剪|剪辑/.test(text)) return
  const time = '(?:(\\d+)[：:])?(\\d+)[：:](\\d+(?:\\.\\d+)?)'
  const start = text.match(new RegExp('从\\s*' + time))
  if (!start || +start[3] >= 60 || (start[1] && +start[2] >= 60)) return
  const seconds = (m) => +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3]
  const end = text.match(new RegExp('(?:到|至)\\s*' + time))
  return { start: seconds(start), ...(end ? { end: seconds(end) } : {}) }
}

export const artifactTypes = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
}
