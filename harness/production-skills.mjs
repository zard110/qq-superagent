import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The desktop skill pack has its own order submission and approval protocol.
// QQ uses the scoped media gateway. Present one production adapter to the SDK for this mode.
const production = `---
name: short-drama-produce
description: 在 QQ 群把已委托的短剧资产、分镜首帧、镜头和配音提交给本群媒体服务，取回素材后交给剪辑。
license: MIT
---

# QQ 短剧制作

以本次群友委托为制作范围。只要样图时交付样图即停，整片委托则包含其中的资产、逐镜生成、配音和成片剪辑。Agent 自行编排、审看中间结果、选择可用素材并推进到交付。旧草稿里的待确认状态是当时的进度，以本次委托为准。

从剧本、视觉设定和分镜读取对应条目。需要人物一致时，先读取群友的实际参考照，再将人物、场景、道具资产用于分镜首帧，并把各镜首帧作为生成该镜视频的参考。按本次请求选择画幅、镜头数量、时长与对白。将分批清单保存在工作目录供自己核对，直接提交委托范围内的项目。

在当前任务目录调用 \`qq-tool media TOOL ITEM JSON\`。TOOL 和可用参数见任务的 toolCatalog 与 mediaUsage。为每个条目分配稳定的 ITEM，按返回的 resource 和本地路径衔接后续调用。按需使用 generateImage、generateVideo、generateMusic、synthesizeSpeech、resolveAudioSource。已成功的素材直接复用，已提交的项目按原编号查询。提交结果不明时保留记录。具体投产使用 QQ 网关的订单回执。

将取回的素材交给 short-drama-edit。按委托完成混音、剪辑和本地核对，将最终文件写入本轮交付目录。需要群友提供缺失的必要输入、或实际接口报错无法继续时，报告具体缺项与已完成部分。
`

const adaptations = new Map([
  ['short-drama', [
    ['先看预览，确认后执行', 'QQ 群整片委托由 Agent 审核并连续执行'],
    ['下一步要调用外部模型生成素材时，必须先展示预览并等创作者明确确认。', '整片委托由 Agent 按本次范围自行审看中间资产，交给 QQ 生产技能直接执行。'],
  ]],
  ['short-drama-image-prompts', [['预览确认后执行', '按本次 QQ 制作委托执行']]],
  ['short-drama-develop', [['经创作者确认后由', '按本次 QQ 制作委托由']]],
])

export async function workerSkills(dir, installed, job) {
  const standard = { home: join(dir, '.harness'), marker: join(dir, '.session'),
    sessionId: 'worker-' + job.ticket, directory: installed }
  if (job.productionMode !== 'deliver' || !job.executionQuote || !job.requiresFile) return standard
  const entry = join(installed, 'short-drama-produce', 'SKILL.md')
  const stat = await lstat(entry).catch(e => { if (e.code !== 'ENOENT') throw e })
  if (!stat?.isFile()) return standard

  const home = join(dir, '.harness-production')
  const directory = join(home, 'skills')
  await mkdir(directory, { recursive: true })
  // Group installations are immutable by name. Refresh the entries so a worker image upgrade
  // also takes effect for resumed tickets. Other skills stay discoverable in the group root.
  for (const skill of await readdir(installed, { withFileTypes: true })) {
    if (!skill.isDirectory() || !/^short-drama(?:-[a-z0-9-]+)?$/.test(skill.name)) continue
    const source = join(installed, skill.name), dest = join(directory, skill.name)
    await cp(source, dest, { recursive: true })
    const file = join(dest, 'SKILL.md')
    if (skill.name === 'short-drama-produce') await writeFile(file, production)
    else if (adaptations.has(skill.name)) {
      let content = await readFile(file, 'utf8')
      for (const [oldText, newText] of adaptations.get(skill.name)) content = content.replaceAll(oldText, newText)
      await writeFile(file, content)
    }
  }
  return { home, marker: join(dir, '.session-production'), sessionId: 'production-' + job.ticket, directory }
}
