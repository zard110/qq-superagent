import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
const source = await realpath(resolve(process.argv[2] || ''))
const name = basename(source)
if (!source.startsWith('/work/') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
  throw Error('需要本群工作区中的技能目录')
const root = '/work/home/.agents/skills',
  target = join(root, name)
await mkdir(root, { recursive: true })
async function loadSkill(scan) {
  const provider = new FileSystemSkillProvider(
    { get: () => undefined, logger: console },
    { invalidate: () => {}, signal: new AbortController().signal },
    { includeDefaultRoots: false, customSkillDirs: [scan], watch: false },
  )
  try {
    const result = await provider.list({})
    const item = (Array.isArray(result) ? result : result.candidates).find((item) => item.name === name)
    return item && (await provider.get(item, {}))?.content
  } finally {
    await provider.dispose()
  }
}
const tmp = await mkdtemp(join(root, '.stage-'))
let normalized = false
try {
  const stage = join(tmp, name)
  for (const path of await readdir(source, { recursive: true })) {
    const stat = await lstat(join(source, path))
    if (!stat.isFile() && !stat.isDirectory()) throw Error('技能包含链接或特殊文件')
  }
  await cp(source, stage, { recursive: true })
  for (const file of ['LICENSE', 'NOTICE']) {
    const license = join(dirname(source), file)
    if ((await lstat(license).catch(() => null))?.isFile())
      await cp(license, join(stage, file), { force: false })
  }
  let content = await loadSkill(tmp)
  if (!content) {
    // Some distributions leave colons unquoted in single-line display descriptions.
    const path = join(stage, 'SKILL.md'),
      original = await readFile(path, 'utf8')
    const fixed = original.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (header) =>
      header.replace(
        /^(short_description(?:_\w+)?): ([^"'|>\s][^\r\n]*: [^\r\n]*)$/gm,
        (_, k, v) => k + ': ' + JSON.stringify(v),
      ),
    )
    if (fixed !== original) {
      await writeFile(path, fixed)
      normalized = true
      content = await loadSkill(tmp)
    }
  }
  if (!content) throw Error('SDK 无法加载技能，请核对 SKILL.md 的 YAML 和名称')
  const existing = await loadSkill(root)
  if (existing && existing !== content) throw Error('群内已有同名的其他技能版本')
  if (!existing) await rename(stage, target)
  if ((await loadSkill(root)) !== content) throw Error('SDK 加载已安装技能失败')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
console.log(JSON.stringify({ skill: name, directory: target, loaded: true, normalized }))
