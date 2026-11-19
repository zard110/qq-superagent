import { execFile, spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const docker = (...args) => exec('docker', args, { timeout: 300000, maxBuffer: 1024 * 1024 })
const project = process.env.GROUP_PROJECT || 'qq-superagent'
const prefix = project + '-group-',
  label = 'qq.group.project=' + project
const idle = new Map()
const attached = new Map()
const verified = new Set()
const lifecycle = new Map()
const budget = [
  '--memory=' + (process.env.GROUP_MEMORY_LIMIT || '4g'),
  '--cpus=' + (process.env.GROUP_CPU_LIMIT || Math.min(3, availableParallelism())),
  '--pids-limit=' + (process.env.GROUP_PIDS_LIMIT || '512'),
]
async function locked(group, fn) {
  const previous = lifecycle.get(group) || Promise.resolve()
  const work = previous.catch(() => {}).then(fn)
  lifecycle.set(group, work)
  try { return await work }
  finally { if (lifecycle.get(group) === work) lifecycle.delete(group) }
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
    const configured = (await docker('inspect', '--format', '{{index .Config.Labels "qq.group.budget"}}', name)).stdout.trim()
    if (current !== desired || layout !== '3' || configured !== budget.join(',') || !Object.hasOwn(JSON.parse(nets), net)) {
      if (state === 'running') {
        const processes = (await docker('top', name, '-eo', 'pid,args')).stdout
        if (/\/opt\/harness\/(?:worker\.mjs|task_process\.py work)/.test(processes))
          throw Object.assign(Error('等待运行中的工作区完成升级'), {status:429})
      }
      await docker('rm', '-f', name)
      state = 'missing'
    }
  }
  if (state === 'running') return name
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
      'qq.group.layout=3',
      '--label',
      'qq.group.budget=' + budget.join(','),
      '--network',
      net,
      '--pull=never',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=256m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      ...budget,
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
function validate(job) {
  if (!valid(job.group) || !valid(job.ticket) || !valid(job.run) || !/^[a-f0-9]{64}$/.test(job.token))
    throw Error('无效任务')
}

// The process and its receipt outlive this Docker CLI call and a runner restart.
async function control(group, action, input) {
  const child = spawn('docker', ['exec','-i',prefix + group,'python3','/opt/harness/task_process.py',action],
    {stdio:['pipe','pipe','pipe']})
  const chunks = []
  let length = 0, detail = ''
  child.stdout.on('data', chunk => {
    length += chunk.length
    if (length <= 36e6) chunks.push(chunk)
    else child.kill()
  })
  child.stderr.on('data', chunk => {detail = (detail + chunk).slice(-600)})
  const done = new Promise((resolve,reject) => {
    child.once('error',reject)
    child.once('close',code => code === 0 ? resolve() : reject(Error(detail || '群工作区不可用')))
  })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(input))
  await done
  return JSON.parse(Buffer.concat(chunks))
}

async function available(job) {
  validate(job)
  if (!idle.has(job.group)) return false
  if (job.gateway && attached.get(job.group) !== job.gateway) {
    await locked(job.group, async () => {
      if (attached.get(job.group) !== job.gateway) {
        await connectGateway(prefix + job.group + '-network')
        attached.set(job.group,job.gateway)
      }
    })
  }
  idle.set(job.group,Date.now())
  return true
}

async function query(job, action) {
  if (!await available(job)) return {state:'missing'}
  try {
    return await control(job.group,action,job)
  } catch (error) {
    if (/is not running|No such container/i.test(error.message)) {
      idle.delete(job.group)
      verified.delete(job.group)
      attached.delete(job.group)
      return {state:'missing'}
    }
    throw Object.assign(error,{status:error.message.includes('任务凭证无效') ? 403 : 503})
  }
}
export const pollGroup = job => query(job,'status')
export const cancelGroup = job => query(job,'cancel')
export const acknowledgeGroup = job => query(job,'ack')

export async function submitGroup(job) {
  validate(job)
  if (!verified.has(job.group)) await locked(job.group, async () => {
    if (!verified.has(job.group)) {
      await ensure(job.group)
      verified.add(job.group)
      idle.set(job.group,Date.now())
      attached.set(job.group,job.gateway)
    }
  })
  const result = await query(job,'start')
  if (result.state === 'busy' || result.state === 'missing')
    throw Object.assign(Error('等待同一任务的工作区'),{status:429})
  return result
}

export async function installDeb(job) {
  if ((await pollGroup(job)).state !== 'running') throw Error('任务已过期')
  const {group,packages} = job
  if (!Array.isArray(packages) || !packages.length || packages.length > 8 ||
      packages.some(p => typeof p !== 'string' || !/^([a-z0-9][a-z0-9+.-]{0,78})$/.test(p)))
    throw Error('需要 Debian 软件包名')
  const {stdout} = await docker('exec','-w','/tmp',prefix+group,'flock','/tmp/qq-install-deb.lock',
    'python','/opt/harness/install_deb.py',...packages)
  return {output:stdout.slice(-2000)}
}
export async function recoverGroups() {
  const {stdout} = await docker('ps','--filter','label='+label,'--filter','label=qq.group.layout=3','--format','{{.Names}}')
  for (const name of stdout.trim().split(/\s+/)) {
    const group = name.slice(prefix.length)
    if (valid(group)) idle.set(group,Date.now())
  }
}
setInterval(() => {
  for (const [group,last] of idle) {
    if (Date.now()-last < 900000) continue
    void locked(group, async () => {
      if (idle.get(group) !== last) return
      if (!await control(group,'idle',{})) return
      if (idle.get(group) !== last) return
      idle.delete(group)
      verified.delete(group)
      attached.delete(group)
      await docker('stop','-t','2',prefix+group)
    }).catch(()=>{})
  }
},30000).unref()

// Stopped groups need retention too. Mount only their own work volume for the sweep.
setInterval(
  () =>
    void (async () => {
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
        if (!valid(group) || idle.has(group)) continue
        await locked(group, async () => {
          if (idle.has(group)) return
          await docker(
            'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--memory=192m',
            '--mount', 'type=volume,src=' + name + '-work,dst=/work',
            '--entrypoint', 'node', 'qq-superagent-harness:local', '/opt/harness/worker.mjs', 'prune',
          )
        })
      }
    })().catch(() => {}),
  3600000,
).unref()
