import { publicFile } from './network.mjs'

export async function fetchSkillArchive(input, download = publicFile) {
  const repo = String(input || '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  if (!/^[a-z\d][a-z\d-]{0,38}\/[\w.-]{1,100}$/i.test(repo) || /\/(?:\.|\.\.)$/.test(repo))
    throw Error('请提供公开 GitHub 仓库的 owner/repo')
  const file = await download('https://codeload.github.com/' + repo + '/zip/HEAD', 32 * 1024 * 1024, 0)
  if (file.bytes.length < 4 || file.bytes.readUInt32LE(0) !== 0x04034b50)
    throw Error('GitHub 未返回 ZIP')
  return { repo, data: file.bytes.toString('base64') }
}
