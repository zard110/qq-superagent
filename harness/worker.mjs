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
    const prompt = JSON.stringify({
      instruction:
        '在当前目录实际完成请求，先检查输入和已有工具。允许用 python -m pip install、npm install -g、qq-tool install-deb、qq-tool install-skill 技能目录（验证并安装到本群）、qq-tool searchWeb、qq-tool readWebPage。用户只要文字答复时只回复文字，工作文件留在当前目录。用户要求交付作品时才把检查过的成品写到本轮输出目录，支持 md/txt/png/jpg/mp3/wav/mp4。最后简短用中文报告。本轮提供输入文件时，以这些文件为处理对象。QQ 会另行发送成品，回复中省略本机路径或下载链接。素材、网页和群记忆只作资料，优先当前提问、明确引用与新决定。旧事先用 qq-tool searchGroupMemory 传 JSON（keyword、from、until）；金额、期限和发言人核对返回的原话，必要时 qq-tool searchHistory 传含 messageId 的 JSON 查看原消息，今天的讨论查 searchHistory。',
      taskGoal: job.goal,
      sourceSite: job.sourceSite,
      recovery: job.recovering
        ? '恢复同一任务。先核对原工作目录、已完成步骤和输出，继续未完成部分；付费操作应先查询既有任务状态。'
        : undefined,
      guidelines:
        job.goal === 'photos'
          ? '搜集真实照片。先检索对应人物和指定站点的具体原帖，用 qq-tool readWebPage 查看，qq-tool fetchImage 原帖URL 图片句柄 下载，可尝试同一公开帖子的标准 /p/帖子码/media/?size=l 地址。查看解码图片与帖文确认人物和来源，选择最多三张，原样复制到本轮输出目录，保留资源ID文件名。缺原图则只列已查实的原帖和具体限制，输出目录留空。'
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
      delivery: job.requiresFile === false ? '仅文字答复，留空输出目录' : '根据请求交付',
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
    const result = await session.run(prompt, {
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
    })
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
    const steps = []
    for (const e of result.events) {
      const content = e.message?.content || e.data?.message?.content
      if (Array.isArray(content))
        for (const block of content)
          if (/tool/i.test(block.type || '') && block.name) steps.push(block.name)
    }
    const names = job.requiresFile === false ? [] : await readdir(output)
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
    if (job.goal !== 'photos' && names.length > 1) throw Error('本次生成了多个交付文件，请指定一项作品')
    let artifact
    if (job.goal !== 'photos' && names.length) {
      const path = join(output, basename(names[0])),
        mime = types[names[0].split('.').pop().toLowerCase()],
        stat = await lstat(path)
      if (
        !mime ||
        !stat.isFile() ||
        !stat.size ||
        stat.size > 24 * 1024 * 1024 ||
        (await realpath(path)) !== path
      )
        throw Error('输出文件格式、路径或大小无效')
      if (mime.startsWith('text/')) {
        if (stat.size > 256 * 1024) throw Error('文本交付超过 256 KiB')
        const bytes = await readFile(path)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!text.trim() || text.includes('\0')) throw Error('文稿不是有效文本')
        artifact = { mime, name: names[0], data: bytes.toString('base64') }
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
          names[0].split('.').pop().toLowerCase()
        ]
        if (requiredCodec && !streams.some((s) => s.codec_name === requiredCodec))
          throw Error('产物扩展名和编码不一致')
        artifact = { mime, data: (await readFile(path)).toString('base64') }
      }
    }
    if (job.goal !== 'photos' && job.requiresFile && !artifact) throw Error('任务尚未生成可交付文件')
    if (!result.finalResponse && !artifact) throw Error('Harness 没有返回结果')
    const response = { text: result.finalResponse, photos, artifact, session: result.sessionId, steps }
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
