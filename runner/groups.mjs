import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const docker = (...args) => exec('docker', args, { timeout: 300000, maxBuffer: 1024 * 1024 })
const project = process.env.GROUP_PROJECT || 'qq-superagent'
const prefix = project + '-group-',
  label = 'qq.group.project=' + project
const active = new Map(),
  idle = new Map()
let lifecycle = Promise.resolve()
const locked = (fn) => {
  const p = lifecycle.then(fn)
  lifecycle = p.catch(() => {})
  return p
}
const valid = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)
const proxy = 'http://app:8790'
const env = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap((k) => [
  '-e',
  k + '=' + proxy,
])
async function connectGateway(net) {
  const app = (
    await docker(
      'ps',
      '--filter',
      'label=com.docker.compose.project=' + project,
      '--filter',
      'label=com.docker.compose.service=app',
      '--filter',
      'label=com.docker.compose.oneoff=False',
      '--format',
      '{{.ID}}',
    )
  ).stdout.trim()
  if (!/^[0-9a-f]+$/.test(app)) throw Error('找不到此部署的应用网关')
  let members = await docker('network', 'inspect', net, '--format', '{{json .Containers}}')
    .then((r) => r.stdout)
    .catch(() => null)
  if (members === null) {
    await docker('network', 'create', '--internal', '--label', label, net)
    members = '{}'
  }
  if (!Object.keys(JSON.parse(members) || {}).some((id) => id.startsWith(app)))
    await docker('network', 'connect', '--alias', 'app', net, app)
}

async function ensure(group) {
  const name = prefix + group
  const net = name + '-network'
  await connectGateway(net)
  let state = await docker('inspect', '--format', '{{.State.Status}}', name)
    .then((v) => v.stdout.trim())
    .catch(() => 'missing')
  if (state !== 'missing') {
    const current = (await docker('inspect', '--format', '{{.Image}}', name)).stdout.trim()
    const desired = (
      await docker('image', 'inspect', '--format', '{{.Id}}', 'qq-superagent-harness:local')
    ).stdout.trim()
    const nets = (await docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', name)).stdout
    const layout = (
      await docker('inspect', '--format', '{{index .Config.Labels "qq.group.layout"}}', name)
    ).stdout.trim()
    if (current !== desired || layout !== '2' || !Object.hasOwn(JSON.parse(nets), net)) {
      await docker('rm', '-f', name)
      state = 'missing'
    }
  }
  if (state === 'running') return name
  const running = (await docker('ps', '--format', '{{.Names}}', '--filter', 'label=' + label)).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (running.length >= 2) {
    const candidate = running
      .map((n) => n.slice(prefix.length))
      .filter((g) => valid(g) && !active.has(g))
      .sort((a, b) => (idle.get(a) || 0) - (idle.get(b) || 0))[0]
    if (!candidate) throw Object.assign(Error('等待群沙箱空位'), { status: 429 })
    await docker('stop', '-t', '2', prefix + candidate)
    idle.delete(candidate)
  }
  if (state === 'missing') {
    await docker(
      'create',
      '--name',
      name,
      '--label',
      label,
      '--label',
      'qq.group=' + group,
      '--label',
      'qq.group.layout=2',
      '--network',
      net,
      '--pull=never',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=256m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory=1536m',
      '--cpus=1.5',
      '--pids-limit=180',
      '--mount',
      'type=volume,src=' + name + '-work,dst=/work',
      ...env,
      '-e',
      'NO_PROXY=app,localhost,127.0.0.1',
      'qq-superagent-harness:local',
    )
  }
  await docker('start', name)
  return name
}
export const stalled = (lastProgress, now = Date.now()) => now - lastProgress >= 8 * 60 * 1000
const jobs = new Map()
function identity(job) {
  if (!valid(job.group) || !valid(job.ticket) || !valid(job.run) || !/^[a-f0-9]{64}$/.test(job.token))
    throw Error('无效任务')
  return [job.group, job.ticket, job.run].join('/')
}
export function groupStatus(job) {
  const id = identity(job),
    entry = jobs.get(id)
  if (!entry) return { state: 'missing' }
  if (entry.token !== job.token) throw Error('任务凭证无效')
  return entry.result
    ? { state: 'finished', result: entry.result }
    : { state: 'running', progress: entry.progress }
}
export async function pollGroup(job) {
  const status = groupStatus(job),
    entry = jobs.get(identity(job))
  if (status.state === 'running' && job.gateway && entry.gateway !== job.gateway) {
    await locked(() => connectGateway(prefix + job.group + '-network'))
    entry.gateway = job.gateway
  }
  return status
}
export function submitGroup(job) {
  const status = groupStatus(job)
  if (status.state !== 'missing') return status
  if (active.has(job.group) || active.size >= 2)
    throw Object.assign(Error('等待群工作区'), { status: 429 })
  const id = identity(job),
    entry = { token: job.token, gateway: job.gateway, progress: { at: Date.now(), step: '启动工作区' } }
  jobs.set(id, entry)
  void groupTurn(job, entry)
    .then(
      (result) => (entry.result = result),
      (error) => (entry.result = { interrupted: error.message }),
    )
    .finally(() => {
      const timer = setTimeout(
        () => {
          if (jobs.get(id) === entry) jobs.delete(id)
        },
        10 * 60 * 1000,
      )
      timer.unref()
    })
  return { state: 'running', progress: entry.progress }
}
export function cancelGroup(job) {
  const status=groupStatus(job)
  if(status.state==='running'){
    const entry=jobs.get(identity(job))
    entry.cancelled=true
    entry.child?.kill()
  }
  return {state:status.state}
}
export function acknowledgeGroup(job) {
  const status = groupStatus(job)
  if (status.state === 'finished') jobs.delete(identity(job))
  return { state: status.state }
}
async function groupTurn(job, entry) {
  const { group, ticket, run, token } = job
  if (!valid(group) || !valid(ticket) || !valid(run) || !/^[a-f0-9]{64}$/.test(token))
    throw Error('无效任务')
  if (active.has(group) || active.size >= 2)
    throw Object.assign(Error('等待群沙箱空位'), { status: 429 })
  active.set(group, token)
  try {
    const name = await locked(() => ensure(group))
    await docker('exec', name, 'node', '/opt/harness/worker.mjs', 'prune')
    idle.delete(group)
    if(entry.cancelled) throw Error('任务已停止')
    const child = spawn('docker', ['exec', '-i', name, 'node', '/opt/harness/worker.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    entry.child=child
    const chunks = []
    let size = 0
    child.stdout.on('data', (b) => {
      size += b.length
      if (size <= 36e6) chunks.push(b)
      else child.kill()
    })
    let line = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      line += chunk
      const lines = line.split('\n')
      line = lines.pop().slice(-2000)
      for (const value of lines) {
        try {
          const event = JSON.parse(value)
          if (typeof event.step === 'string')
            entry.progress = { at: Date.now(), step: event.step.slice(0, 120) }
        } catch {}
      }
    })
    child.stdin.on('error', () => {})
    const done = new Promise((ok, fail) => {
      child.on('error', fail)
      child.on('close', (code) => (code === 0 ? ok() : fail(Error('Harness 任务进程退出'))))
    })
    child.stdin.end(JSON.stringify(job))
    const timer = setInterval(() => {
      if (stalled(entry.progress.at)) child.kill()
    }, 30000)
    try {
      await done
      return JSON.parse(Buffer.concat(chunks))
    } catch (error) {
      await docker('stop', '-t', '1', name)
      throw error
    } finally {
      clearInterval(timer)
    }
  } finally {
    active.delete(group)
    idle.set(group, Date.now())
  }
}
export async function installDeb({ group, token, packages }) {
  if (!valid(group) || !token || active.get(group) !== token) throw Error('任务已过期')
  if (
    !Array.isArray(packages) ||
    !packages.length ||
    packages.length > 8 ||
    packages.some((p) => typeof p !== 'string' || !/^([a-z0-9][a-z0-9+.-]{0,78})$/.test(p))
  )
    throw Error('需要 Debian 软件包名')
  // Extract signed-repository packages into the group prefix, without privileged maintainer scripts.
  const { stdout } = await docker(
    'exec',
    '-w',
    '/tmp',
    prefix + group,
    'python',
    '/opt/harness/install_deb.py',
    ...packages,
  )
  return { output: stdout.slice(-2000) }
}
export async function recoverGroups() {
  const names = (await docker('ps', '--filter', 'label=' + label, '--format', '{{.Names}}')).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (const name of names) {
    const group = name.slice(prefix.length)
    if (valid(group)) await docker('stop', '-t', '2', name)
  }
}
setInterval(
  () =>
    void locked(async () => {
      for (const [group, last] of idle)
        if (!active.has(group) && Date.now() - last > 900000) {
          await docker('stop', '-t', '2', prefix + group)
          idle.delete(group)
        }
    }).catch(() => {}),
  30000,
).unref()

// Stopped groups need retention too. Mount only their own work volume for the sweep.
setInterval(
  () =>
    void locked(async () => {
      const stopped = (
        await docker(
          'ps',
          '-a',
          '--filter',
          'label=' + label,
          '--filter',
          'status=exited',
          '--format',
          '{{.Names}}',
        )
      ).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      for (const name of stopped) {
        const group = name.slice(prefix.length)
        if (!valid(group) || active.has(group)) continue
        await docker(
          'run',
          '--rm',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--memory=192m',
          '--mount',
          'type=volume,src=' + name + '-work,dst=/work',
          '--entrypoint',
          'node',
          'qq-superagent-harness:local',
          '/opt/harness/worker.mjs',
          'prune',
        )
      }
    }).catch(() => {}),
  3600000,
).unref()
