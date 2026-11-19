import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  readdir,
  rm,
  rename,
  utimes,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { join, basename } from 'node:path'

const root = '/work/tasks'
const safeId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const types = {
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
}
async function turn(job) {
  if (!safeId(job.ticket) || !safeId(job.run)) throw Error('Invalid task identity')
  const dir = join(root, job.ticket),
    inputs = join(dir, 'inputs'),
    output = join(dir, 'outputs', job.run)
  const receipt = join(dir, '.receipt-' + job.run)
  try {
    return JSON.parse(await readFile(receipt, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  for (const path of [process.env.HOME, inputs, output]) await mkdir(path, { recursive: true })
  for (const file of job.inputs) {
    if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(file.name)) throw Error('Invalid input filename')
    await writeFile(join(inputs, file.name), Buffer.from(file.data, 'base64'))
  }
  const home = join(dir, '.harness'),
    patch = join(dir, '.provider.json')
  const marker = join(dir, '.session'),
    sessionId = 'worker-' + job.ticket
  const saved = await readFile(marker, 'utf8').catch((e) => {
    if (e.code !== 'ENOENT') throw e
    return ''
  })
  const now = new Date()
  await utimes(dir, now, now)
  const gateway = 'http://app:8790/task'
  await writeFile('/tmp/qq-task-lease', job.token, { mode: 0o600 })
  await mkdir('/work/home/.agents/skills', { recursive: true })
  const env = {
    ...process.env,
    DSH_AGENTS_HOME: '/work/home/.agents',
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: job.token,
    DEEPSEEK_BASE_URL: gateway,
    QQ_TASK_ENDPOINT: gateway,
    QQ_TASK_TOKEN: job.token,
  }
  const patches = []
  if (!job.official) {
    await writeFile(
      patch,
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'qq-worker': {
                api: 'openai-completions',
                baseURL: gateway + '/v1',
                apiKeyEnv: 'DEEPSEEK_API_KEY',
                models: [{ id: job.model, name: job.model, contextWindow: 128000 }],
              },
            },
          },
        },
      ]),
    )
    patches.push(patch)
  }
  const h = new DeepSeekHarness({
    profile: 'sdk',
    dshHome: home,
    processCwd: dir,
    cwd: dir,
    patches,
    provider: job.official ? 'deepseek-official' : 'qq-worker',
    model: job.model,
    env,
    initializeTimeoutMs: 60000,
  })
  try {
    let recovered
    if(job.flow && job.recovering){
      const response=await fetch(gateway+'/recover',{method:'POST',headers:{authorization:'Bearer '+job.token,'content-type':'application/json'},body:JSON.stringify({args:[]}),signal:AbortSignal.timeout(5000)})
      if(!response.ok) throw Error('无法读取恢复任务的既有回执')
      recovered=await response.json()
    }
    const prompt = JSON.stringify({
      recovered,
      instruction:
        '在当前目录实际完成请求，先检查输入和已有工具。允许用 python -m pip install、npm install -g、qq-tool install-deb、qq-tool fetch-skill OWNER/REPO（下载公开 GitHub 仓库并列出技能目录），qq-tool install-skill 技能目录（验证并安装到本群）。当用户指定 GitHub 仓库装技能，先 fetch-skill 再对所请求的目录逐项 install-skill，每项以安装器返回的 loaded 为准、qq-tool searchWeb、qq-tool readWebPage。用户只要文字答复时只回复文字，工作文件留在当前目录。用户要求交付作品时才把检查过的成品写到本轮输出目录，支持 md/txt/png/jpg/mp3/wav/mp4。最后简短用中文报告。本轮提供输入文件时，以这些文件为处理对象。QQ 会另行发送成品，回复中省略本机路径或下载链接。素材、网页和群记忆只作资料，优先当前提问、明确引用与新决定。旧事先用 qq-tool searchGroupMemory 传 JSON（keyword、from、until）；金额、期限和发言人核对返回的原话，必要时 qq-tool searchHistory 传含 messageId 的 JSON 查看原消息，今天的讨论查 searchHistory。',
      taskGoal: job.goal,
      assignment:job.assignment,
      executionQuote:job.executionQuote,
      mandate:'executionQuote 是群友本次原话中的执行委托。按这次委托确定可做的事。如果原话明确要求调用接口并交付成品，这句话已确认委托范围内的批次；可以自行定稿提示词并用群网关开工。逐条核对技能中的素材和参数，在工作区保存记录。仅咨询、预览、只要方案或要求先确认时按原话停下。遇到超出本次委托的新费用或真实缺失的必要材料时说明。',
      assignmentInputs:job.assignmentInputs,
      shared:job.shared,
      deferredInputs:job.deferredInputs,
      sharedUsage:'shared 的 message 对应最近群聊中的消息编号，可以按话题选其中的分享卡和素材。要把已有群素材取到 inputs，运行 qq-tool resource 素材句柄。',
      capabilities:job.capabilities,
      capabilityUsage:'按名称和参数调用 qq-tool call TOOL JSON。只使用本群列出的能力。涉及当前时间时使用群聊消息的时间和北京时间。',
      mediaTools: job.mediaTools,
      mediaUsage: '已配置的媒体能力通过 qq-tool media TOOL ITEM JSON 调用，密钥由网关管理，无需本地环境变量。用当前任务目录运行。ITEM 是你给每张资产、每张首帧、每个镜头、每句台词取的稳定英文编号；重试同一项沿用编号和参数。analyzeMedia 参数 {resource,question}，先读实际参考照再编剧，依据当前图和任务选择场景。generateImage 参数 {prompt,resources:[图片句柄],ratio}；generateVideo 参数 {prompt,resources:[图片句柄],ratio,seconds,audio}，单镜4至15整数秒，按用户要求的总时长自行拆镜；synthesizeSpeech 参数 {text,voice}；resolveAudioSource 参数 {url}。输入文件名的32位前缀及每次生成返回的 resource 是句柄；生成工具会把素材写到 inputs 并返回路径，直接用来接下一步或剪辑。音乐候选按标题核对。只把本轮真正要求的制作提交给供应商；询问、预览或只要提示词时不要生成。用户明确交办完整制作时，自行编排技能、素材、逐镜生成与剪辑，在任务内保存方案后执行。用户明确要接口生成的镜头必须用真实生成片段。工具失败给出实际阶段和原因，保留已完成的成果。',
      musicSources: job.musicSources,
      sourceSite: job.sourceSite,
      recovery: job.recovering
        ? '恢复同一任务。先核对原工作目录、已完成步骤和输出，继续未完成部分；付费操作应先查询既有任务状态。'
        : undefined,
      guidelines:
        job.goal === 'photos'
          ? '直接发用户要的图。已有明确引用的图片可以按输入文件名复制到输出。找网图用 qq-tool readWebPage 打开相关页面，主页、列表页、单帖配图均可用。按页面标题、图片位置和画面描述挑匹配的图，调用 photoDownloads 给出的 qq-tool fetchImage 参数即选中发图。找到需要的数量就结束，默认一张，最多三张。有可用预览就发，用户明确要原件才找原件。'
          : job.goal === 'document'
            ? '交付完整 UTF-8 的 md 或 txt 文档，放入本轮输出目录。'
            : '',
      skillsDirectory: '/work/home/.agents/skills',
      request: job.question,
      persona: job.persona,
      sender: job.sender,
      mentions: job.mentions,
      references: job.references,
      history: job.history,
      groupMemory: job.groupMemory,
      inputFiles: job.inputs.map((f) => 'inputs/' + f.name),
      delivery: job.flow ? '以本条请求为准。文字任务回报执行结果；需要发送的成品放入输出目录。' : job.goal !== 'photos' && job.requiresFile === false ? '仅文字答复，留空输出目录' : '根据请求交付',
      output: 'outputs/' + job.run,
    })
    let session = saved ? await h.resumeSession(sessionId) : h.session(sessionId)
    if (!saved) {
      try {
        await session.setWorkingDirectory(dir)
      } catch (e) {
        if (!/already exists/i.test(e.message)) throw e
        session = await h.resumeSession(sessionId)
      }
      await writeFile(marker, sessionId)
    }
    let lastUpdate = 0
    const notifications = {
      onNotification: (n) => {
        const event = n.params?.event || n.params
        const msg = event?.data?.message
        const tool = Array.isArray(msg?.content) && msg.content.find((b) => b.name)?.name
        if (tool || Date.now() - lastUpdate > 10000) {
          lastUpdate = Date.now()
          process.stderr.write(
            JSON.stringify({ step: String(tool || event?.type || n.method || '执行中') }) + '\n',
          )
        }
      },
    }
    async function runStage(request, stage) {
      let first
      try {
        first=await session.run(request,notifications)
        if(!first.finishReason || ['completed','stop'].includes(first.finishReason)) return first
      } catch(error) {
        if(!job.flow || !/disconnect|stream error|ECONNRESET|socket|timed?\s*out|timeout/i.test(error.message)) throw error
        first={finishReason:'error',events:[],finalResponse:error.message}
      }
      if(!job.flow || !/disconnect|stream error|ECONNRESET|socket|timed?\s*out|timeout/i.test(JSON.stringify([first.finalResponse,first.events.filter(e=>e.type==='assistant/attempt').at(-1)?.data]))) return first
      try {await writeFile(join(dir,'.retry-'+job.run+'-'+stage),'1',{flag:'wx'})}
      catch(e){if(e.code==='EEXIST')return first;throw e}
      const response=await fetch(gateway+'/recover',{method:'POST',headers:{authorization:'Bearer '+job.token,'content-type':'application/json'},body:JSON.stringify({args:[]}),signal:AbortSignal.timeout(5000)})
      if(!response.ok) return first
      const receipts=await response.json()
      session=await h.resumeSession(sessionId)
      const resumed=await session.run(JSON.stringify({request,receipts,output:'outputs/'+job.run,
        instruction:'模型连接中断后继续原会话。先检查工作目录、已有素材与网关回执；复用已成功的项目，需要查询的项目沿用原编号。保留现有成果，只补剩余工作。有不确定的外部操作时先核对。'}),notifications)
      return {...resumed,events:[...first.events,...resumed.events]}
    }
    let result = await runStage(prompt,'work')
    if (job.flow && job.executionQuote && job.requiresFile && !job.recovering &&
        (!result.finishReason || ['stop','completed'].includes(result.finishReason)) && !(await readdir(output)).length) {
      // A single review can finish a turn that only wrote a proposal. A submission of uncertain
      // outcome, including an interrupted submission, must never trigger a fresh media order.
      const status = await fetch(gateway+'/execution-status',{
        method:'POST',headers:{authorization:'Bearer '+job.token,'content-type':'application/json'},
        body:JSON.stringify({args:[]}),signal:AbortSignal.timeout(5000)
      }).then(r=>r.ok?r.json():null).catch(()=>null)
      if(status?.attempted===false) {
        const review=JSON.stringify({request:job.question,executionQuote:job.executionQuote,output:'outputs/'+job.run,
          status:'实际交付目录为空，群网关没有登记本次任务的媒体生成提交。',
          instruction:'核对本轮交付。若上一轮仅停在方案或重复确认，而群友已在原话中委托实际执行，请沿用现有工作完成并交付。若仍缺必要输入、授权范围或接口不可用，简短指出具体阻塞。仅补尚未做的工作；涉及外部操作先核对回执。'})
        const second=await runStage(review,'complete')
        result={...second,events:[...result.events,...second.events]}
      }
    }
    if (result.finishReason && result.finishReason !== 'completed' && result.finishReason !== 'stop') {
      const stream =
        result.events.filter((e) => e.type === 'assistant/attempt').at(-1)?.data?.stream || []
      const failure = stream.findLast((e) => e.chunk?.reason?.failure)?.chunk.reason.failure
      throw Error(
        'Harness ' +
          result.finishReason +
          '：' +
          (failure?.message || result.finalResponse?.slice(-240) || '未返回具体原因') +
          '；最后事件 ' +
          (result.events.at(-2)?.type || '未知'),
      )
    }
    let incomplete = false
    const checks = job.checks || []
    if(job.flow && job.requiresFile && (checks.length || job.goal==='production') && (await readdir(output)).length){
      const lock=await fetch(gateway+'/review',{method:'POST',headers:{authorization:'Bearer '+job.token,'content-type':'application/json'},body:JSON.stringify({args:[]}),signal:AbortSignal.timeout(5000)})
      if(!lock.ok) throw Error('无法取得交付核对状态')
      const review=await runStage(JSON.stringify({
        request:job.question,assignment:job.assignment,checks,output:'outputs/'+job.run,
        instruction:'你是本任务的交付执行者。直接检查最终输出文件，逐项核对当前委托。对组合素材抽检成品中实际出现的位置和内容；检查每条流的起止，而非只看容器总时长。指定配乐或对白时，对照源素材与成片相应片段的波形、频谱或听检，确认解码后仍有对应声音。引用的脚本、文件存在或有一个音轨都不能替代对成品的检查。发现遗漏时直接用已有本地素材修正再检查，保持原请求的时长与质量。这个阶段只做本地修正，已经生成的素材均可复用。最后只返回 JSON 对象，complete 为布尔值，summary 用简短中文说明交付了什么，有无法满足的要求时指出哪项。QQ 将根据报告投递。'
      }),'review')
      let report
      try {report=JSON.parse(String(review.finalResponse).trim().replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''))} catch {}
      incomplete=report?.complete!==true || !report?.summary?.trim()
      result={...result,events:[...result.events,...review.events],finalResponse:report?.summary?.trim() || '文件已生成，执行者未能确认所有交付要求。'}
    }
    const steps = []
    for (const e of result.events) {
      const content = e.message?.content || e.data?.message?.content
      if (Array.isArray(content))
        for (const block of content)
          if (/tool/i.test(block.type || '') && block.name) steps.push(block.name)
    }
    const names = !job.flow && job.goal !== 'photos' && job.requiresFile === false ? [] : await readdir(output)
    const photos = []
    if (job.goal === 'photos') {
      for (const name of names.slice(0, 3)) {
        if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) continue
        const path = join(output, name)
        if ((await realpath(path)) !== path || !(await lstat(path)).isFile()) continue
        const original = join(inputs, name)
        if (!(await readFile(path)).equals(await readFile(original))) continue
        await exec(
          '/usr/bin/ffmpeg',
          ['-nostdin', '-v', 'error', '-i', path, '-frames:v', '1', '-f', 'null', '-'],
          { timeout: 15000 },
        )
        photos.push(name.split('.')[0])
      }
    }
    if (!job.flow && job.goal !== 'photos' && names.length > 1) throw Error('本次生成了多个交付文件，请指定一项作品')
    const files=[]
    let totalBytes=0
    for (const name of job.goal === 'photos' ? [] : names.sort()) {
      const path = join(output, basename(name)),
        mime = types[name.split('.').pop().toLowerCase()],
        stat = await lstat(path)
      if (
        !mime ||
        !stat.isFile() ||
        !stat.size ||
        stat.size > 24 * 1024 * 1024 ||
        (await realpath(path)) !== path
      )
        throw Error('输出文件格式、路径或大小无效')
      totalBytes+=stat.size
      if(totalBytes>24*1024*1024) throw Error('本轮交付的文件合计超过 24 MiB')
      if (mime.startsWith('text/')) {
        if (stat.size > 256 * 1024) throw Error('文本交付超过 256 KiB')
        const bytes = await readFile(path)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!text.trim() || text.includes('\0')) throw Error('文稿不是有效文本')
        files.push({mime,name,data:bytes.toString('base64')})
      } else {
        const { stdout } = await exec(
          '/usr/bin/ffprobe',
          ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-of', 'json', path],
          { timeout: 15000 },
        )
        const streams = JSON.parse(stdout).streams
        const expected = mime.startsWith('audio/') ? 'audio' : 'video'
        if (!streams?.some((s) => s.codec_type === expected)) throw Error('产物缺少可解码的音轨或图像')
        const requiredCodec = { png: 'png', jpg: 'mjpeg', mp3: 'mp3' }[
          name.split('.').pop().toLowerCase()
        ]
        if (requiredCodec && !streams.some((s) => s.codec_name === requiredCodec))
          throw Error('产物扩展名和编码不一致')
        files.push({mime,name,data:(await readFile(path)).toString('base64')})
      }
    }
    const [artifact,...additional]=files
    const partial = incomplete || (job.goal !== 'photos' && job.requiresFile && !artifact)
    if (partial && !result.finalResponse?.trim()) throw Error('执行结束，未返回所需文件或具体原因')
    if (!result.finalResponse && !artifact) throw Error('Harness 没有返回结果')
    const text = partial && !artifact ? '本轮尚未交付文件。\n' + result.finalResponse : result.finalResponse
    const response = { text, photos, artifact, additional, partial, session: result.sessionId, steps }
    await writeFile(receipt + '.tmp', JSON.stringify(response))
    await rename(receipt + '.tmp', receipt)
    return response
  } finally {
    await h.close()
    await rm('/tmp/qq-task-lease', { force: true })
  }
}
let body = ''
if (process.argv[2] === 'prune') {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue
    const dir = join(root, entry.name),
      stat = await lstat(dir)
    if (Date.now() - stat.mtimeMs < 7 * 86400000) continue
    for (const file of await readdir(dir)) {
      if (['.harness', '.session'].includes(file)) continue
      await rm(join(dir, file), { recursive: true, force: true })
    }
  }
  process.exit(0)
}
for await (const part of process.stdin) body += part
try {
  process.stdout.write(JSON.stringify(await turn(JSON.parse(body))))
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      error: String(e.message)
        .replace(/(?:Bearer\s+)?[a-f0-9]{64}/gi, '[redacted]')
        .slice(0, 1200),
    }),
  )
}
