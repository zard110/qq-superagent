import { Runtime as PreviousRuntime } from './runtime.mjs'
import { Engine, latestAssignment } from './core.mjs'
import { key, groupPolicy, replyMentions } from './messages.mjs'
import { fastRoute } from './fast-routing.mjs'
import { planAssignment, quickAnswer, toolAgent } from './assignment.mjs'
import { Pending } from './capabilities.mjs'
import { historyEnabled } from './memory.mjs'
import { executeHarness, cancelHarness } from './harness.mjs'

const live = (r) => r && ['queued', 'running'].includes(r.state)
const inScope = (group) =>
  !!group && (!process.env.QQ_ALLOWED_GROUP || group === process.env.QQ_ALLOWED_GROUP)
const version = (c) => key('qq-policy-v2', JSON.stringify(c.groups), process.env.QQ_ALLOWED_GROUP || '')
const pause = () => {
  throw new Pending('等待上一步任务')
}
const triggerOf = (r) => r.trigger || r.id

export class GroupRuntime extends PreviousRuntime {
  constructor(store, caps, options = {}) {
    super(store, caps, options)
    this.previous = new PreviousRuntime(store, caps, options)
    this.plan = options.plan || planAssignment
    this.worker = options.worker || executeHarness
    this.engine = new Engine({
      repo: store,
      policy: () => this.policy(),
      scope: {
        scope: (t) =>
          inScope(t.meta.group)
            ? { listened: true, observed: true }
            : { listened: false, reason: 'outsideGroup' },
      },
      assessor: {
        request: (c) => store.put('assessment', c.evalId, c),
        release: (id) => store.del('assessment', id),
      },
      executor: {
        start: (t, a) =>
          store.put('assignmentWork', a.id, { ticket: t.id, state: 'pending', inputs: [] }),
        deliver: (t, a) =>
          store.put('assignmentWork', a.id, {
            ticket: t.id,
            state: 'running',
            inputs: [...t.undelivered],
          }),
        stop: (t, a, reason) => {
          store.put('assignmentWork', a.id, { ticket: t.id, state: 'ended', reason })
          if (t.ended?.by === 'human' || reason === 'retried') {
            for (const r of store
              .pendingRuns()
              .filter((r) => r.ticket === t.id && (!r.assignment || r.assignment === a.id))) {
              store.put('run', r.id, { ...r, state: 'stopped' })
              const lease = store.get('workerLease', r.id)
              if (lease) store.put('cancel', r.id, { run: r, lease })
            }
          }
        },
      },
      outbox: {
        send: (o) => this.channel(o),
        status: (id) => this.channelStatus(id),
        withdraw: (id) => {
          const rows = store.get('channel', id)?.rows || [id]
          for (const row of rows) if (store.get('out', row)?.status === 'pending') store.del('out', row)
        },
      },
    })
  }
  policy() {
    const config = this.store.config()
    return {
      version: version(config),
      paused: false,
      evalTimeoutMs: 180000,
      gate: (t) => {
        const group = t.meta.group,
          p = groupPolicy(config, group)
        if (!inScope(group)) return { admissible: false, reason: 'outsideGroup' }
        const m = this.store.get('run', t.id)?.m
        const directed =
          ['timer', 'archive'].includes(t.source) ||
          m?.mention ||
          t.addressed === 'direct' ||
          (p.nickname && t.text.includes(p.nickname)) ||
          (p.mode === 'rules' && p.rules.some((rule) => rule && t.text.includes(rule)))
        const scope = { group }
        if (directed)
          return {
            admissible: true,
            strength: 'explicit',
            basis: {
              via: 'addressed',
              addressed: 'direct',
              source: t.source,
              scope,
              sender: t.actor.id,
            },
          }
        if (p.mode === 'social')
          return {
            admissible: true,
            strength: 'inferred',
            basis: {
              via: 'admission',
              cell: 'unlistedUnaddressed',
              source: t.source,
              scope,
              observation: { mode: 'auto' },
            },
          }
        return { admissible: false, reason: 'groupPolicy' }
      },
      revalidate: (m) =>
        !m.basis.scope?.group ||
        (inScope(m.basis.scope.group) &&
          (m.strength !== 'inferred' || groupPolicy(config, m.basis.scope.group).mode === 'social')),
      admitsInferred: (rules) => rules.includes('groupParticipation'),
    }
  }
  policyUpdated(before, after) {
    const from = version(before),
      to = version(after)
    if (from === to) return
    const effects = new Map()
    for (const t of this.store.tickets.open()) {
      const group = t.channels[0]?.address.group
      if (JSON.stringify(before.groups[group]) !== JSON.stringify(after.groups[group]))
        effects.set(t.id, {
          rules: [
            {
              id: 'groupPolicy',
              name: '群设置',
              change: 'changed',
              instruction: '使用当前启用的群能力和参与策略。',
            },
          ],
        })
    }
    this.engine.policyChanged(from, to, effects)
  }
  upgradeMention(m) {
    const id = key(m.group, m.id),
      r = this.store.get('run', id)
    if (r?.flow && r.state === 'ignored' && !r.ticket && this.engine.reevaluate(id))
      this.store.put('run', id, {
        ...r,
        m: { ...r.m, mention: true },
        fast: undefined,
        route: undefined,
        state: 'queued',
      })
  }
  acceptSource(m) {
    if (!m.author) return
    const s = this.store,
      parent = m.refs.map((id) => s.lookup(m.group, id)).find(Boolean)
    m.thread = parent?.thread || key(m.group, m.refs[0] || m.id)
    s.message(m)
    if (m.mention && /领取|取回|查看结果/.test(m.text)) {
      const held = s
        .all('out')
        .filter(
          (o) =>
            o.group === m.group &&
            o.status === 'held' &&
            (!o.origin || s.lookup(m.group, o.origin)?.author === m.author),
        )
        .reverse()
        .slice(0, 5)
      for (const o of held)
        s.put('out', o.id, {
          ...o,
          sourceOrigin: o.sourceOrigin || o.origin,
          origin: m.id,
          seq: undefined,
          tries: 0,
          after: 0,
          status: 'pending',
        })
      if (held.length) return m
    }
    this.intake(m, 'qq', parent?.author === '@bot' || !!m.mention)
    return m
  }
  archiveDue(job) {
    const id = key('daily-archive', job.group, job.next),
      s = this.store
    if (!inScope(job.group) || s.get('run', id)) return
    s.atomic(() => {
      if (!s.get('memoryJob', job.group)) s.put('memoryJob', job.group, job)
      const m = {
        group: job.group,
        id,
        idx: id,
        thread: id,
        author: '@archive',
        at: new Date().toISOString(),
        text: '整理 ' + job.next + ' 群记忆',
        parts: [],
        refs: [],
        mentions: [],
      }
      this.intake(m, 'archive', true, id)
      s.put('run', id, { ...s.get('run', id), day: job.next })
    })
  }
  async archiveDay(run) {
    const s = this.store,
      g = run.m.group,
      job = s.get('memoryJob', g)
    if (job?.next === run.day && historyEnabled(s.config(), g)) {
      try {
        await this.archive(job)
      } catch (e) {
        const attempt = (job.attempt || 0) + 1
        const after = Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(attempt - 1, 6))
        s.put('memoryJob', g, {
          ...job,
          status: '等待重试',
          error: e.message.slice(0, 200),
          attempt,
          retryAt: after,
        })
        run.after = after
        throw new Pending('归档等待重试')
      }
    }
    s.atomic(() => {
      this.engine.inputsRead(run.ticket, run.inputIds || [])
      this.engine.report(run.ticket, {
        state: 'ready',
        summary: s.get('memoryJob', g)?.status || '已结束',
      })
      s.put('run', run.id, { ...run, state: 'done', after: 0 })
    })
  }
  scheduled(t, id) {
    if (!inScope(t.group) || this.store.triggers.get(id) || this.store.get('out', id)) return
    const m = {
      group: t.group,
      id,
      idx: id,
      thread: id,
      at: new Date(t.next).toISOString(),
      author: '@timer',
      text: t.text,
      mention: false,
      parts: [],
      mentions: [],
      refs: [],
    }
    this.intake(m, 'timer', true)
  }
  resume(prior, request, id) {
    const s = this.store
    s.atomic(() => {
      if (s.get('run', id)) return
      const m = { ...prior.m, at: new Date().toISOString(), text: request, mention: true }
      this.intake(m, 'qq', true, id)
      const run = s.get('run', id)
      if (!run.ticket) {
        this.engine.attach(prior.ticket, id, '管理员请求续办')
        run.ticket = prior.ticket
      }
      s.put('run', id, { ...run, recovering: true })
    })
  }
  intake(m, source, directed, id = source === 'timer' ? m.id : key(m.group, m.id)) {
    const s = this.store
    s.atomic(() => {
      if (s.triggers.get(id)) return
      const run = {
        flow: 2,
        id,
        m,
        state: 'queued',
        executor: { timer: 'reminder', archive: 'archive' }[source] || 'group',
        social: !directed,
      }
      s.put('run', id, run)
      this.engine.receive({
        id,
        source,
        threads: [{ source, id: m.thread }],
        actor: { source, id: m.author },
        human: source === 'qq',
        addressed: directed ? 'direct' : 'none',
        at: m.at,
        text: m.text,
        ...(source === 'archive'
          ? {}
          : {
              channel: {
                source,
                thread: m.thread,
                address: { group: m.group, message: source === 'timer' ? '' : m.id },
              },
            }),
        meta: { group: m.group },
      })
      const d = s.triggers.disposition(id)
      const owners = d.fanout.filter((t) => !d.context?.includes(t))
      for (const [i, ticket] of owners.entries()) {
        const copy = {
          ...run,
          ticket,
          subscribed: true,
          trigger: id,
          id: i ? key(id, ticket) : id,
          executor: 'group',
        }
        s.put('run', copy.id, copy)
      }
    })
  }
  channelStatus(id) {
    const s = this.store,
      items = s.get('channel', id)?.rows || [id]
    const statuses = items.map((row) => s.get('out', row)?.status)
    if (statuses.every((v) => v === 'sent')) return 'sent'
    if (statuses.some(Boolean)) return 'pending'
  }
  channel(o) {
    const s = this.store
    if (s.get('channel', o.id)) return
    const report = this.publishing
    if (!report) {
      this.enqueue(o.id, o.channel.address.group, o.channel.address.message, o.text)
      return
    }
    const { run, artifact, failed, result } = report
    this.recordResult(run, report.text, artifact, failed, result, o.channel.address.message)
    const reply = key(run.id, 'reply'),
      files = result.artifacts || (artifact ? [artifact] : [])
    const rows = [
      ...(report.text ? [reply] : []),
      ...files.map((_, i) => (i ? key(reply, 'media', i) : key(reply, 'media'))),
    ]
    s.put('channel', o.id, { ticket: o.ticketId, rows })
  }
  publishReport(run, text, artifact, failed, result) {
    const s = this.store,
      id = triggerOf(run)
    s.atomic(() => {
      const t = s.tickets.get(run.ticket)
      if (!live(s.get('run', run.id)) || t?.ended || latestAssignment(t)?.id !== run.assignment) return
      this.engine.inputsRead(t.id, run.inputIds || [])
      const timer = run.executor === 'reminder'
      const more = s.pendingRuns().some((other) => other.id !== run.id && other.ticket === t.id)
      const state = failed ? 'failed' : result.partial ? 'blocked' : more ? 'progress' : 'ready'
      this.engine.report(t.id, {
        state,
        summary: (text || '已交付附件').slice(0, 1400),
        ...(timer ? {} : { answers: id }),
      })
      if (run.fast?.responsibleStarted) run.fast.responsibleMs = Date.now() - run.fast.responsibleStarted
      const files = result.artifacts || (artifact ? [artifact] : [])
      this.publishing = { run, artifact, failed, result, text }
      try {
        const logical = JSON.stringify({ text, files })
        const receipt = this.engine.reply({
          ticketId: t.id,
          triggerId: id,
          purpose: timer ? 'result' : 'answer',
          text: logical,
        })
        if (receipt.reused)
          s.put('run', run.id, {
            ...run,
            state: failed ? 'failed' : result.partial ? 'partial' : 'done',
            answer: text,
            artifact,
            channel: receipt.id,
          })
      } finally {
        this.publishing = undefined
      }
    })
  }
  async tick() {
    for (const job of this.store.all('cancel')) {
      if (this.busy.has('stop' + job.run.id)) continue
      this.busy.add('stop' + job.run.id)
      void cancelHarness(this, job.run, job.lease)
        .then(() => this.store.del('cancel', job.run.id))
        .catch(() => {})
        .finally(() => this.busy.delete('stop' + job.run.id))
    }
    for (const r of this.store.pendingRuns()) {
      if (this.busy.size >= 4) break
      if (this.busy.has(r.id) || r.after > Date.now()) continue
      this.busy.add(r.id)
      void this.process(r)
        .catch((e) => console.error('任务调度失败', e.message))
        .finally(() => this.busy.delete(r.id))
    }
  }
  async admit(run) {
    const s = this.store,
      id = triggerOf(run)
    this.engine.evaluateDue()
    const d = s.triggers.disposition(id),
      decision = s.decisions.get(d.decisionId || '')
    if (decision?.kind === 'accept') {
      const accepted = s.tickets.get(decision.ticketId)
      if (accepted.origin.triggerIds.length > 1 && accepted.origin.triggerId !== id && !run.subscribed) {
        s.put('run', run.id, { ...run, ticket: accepted.id, state: 'batched' })
        return false
      }
      run.ticket ||= decision.ticketId
    } else if (
      decision &&
      !this.engine.candidate(id) &&
      !run.ticket &&
      !s.threads.active().some((t) => t.pending.includes(id))
    ) {
      s.put('run', run.id, { ...run, state: 'ignored' })
      return false
    }
    const candidate = this.engine.candidate(id)
    if (!candidate && !run.ticket) return pause()
    if (candidate) {
      if (candidate.thread.evaluating.primary !== id && candidate.triggers.length > 1) return pause()
      this.engine.candidateDelivered(candidate.evalId)
    }
    const stillCurrent = () => !candidate || this.engine.candidate(id)?.evalId === candidate.evalId
    const conclude = (kind, reason, extra = {}) =>
      this.engine.decide(id, {
        kind,
        reason,
        ...(candidate ? { evalId: candidate.evalId } : {}),
        ...extra,
      })
    const scheduled = ['reminder', 'archive'].includes(run.executor)
    if (!scheduled && !run.assessed) {
      if (!run.fast?.engagement) await fastRoute(this, run, s.config(), { assessOnly: true })
      if (!stillCurrent()) return pause()
      if (run.fast?.lane === 'silent' && !run.ticket) {
        conclude('ignore', run.fast.engagement)
        s.put('run', run.id, { ...run, state: 'ignored' })
        return false
      }
      if (run.ticket || run.fast?.lane !== 'quick') {
        run.route ||= await this.plan(this, run)
        if (!live(s.get('run', run.id))) return false
        if (!stillCurrent()) {
          delete run.route
          return pause()
        }
        const target = run.route.stop && s.tickets.get(run.route.stop)
        const authorized =
          target &&
          !target.ended &&
          target.channels.some((c) => c.address.group === run.m.group) &&
          (target.mandate.actor.id === run.m.author || ['owner', 'admin'].includes(run.m.role))
        if (run.route.action === 'stop' && authorized) {
          const stopped = conclude('stop', '成员明确要求停止', { ticketId: target.id })
          if (stopped.kind === 'stop') {
            s.put('run', run.id, { ...run, state: 'stopped' })
            return false
          }
        }
        if (run.fast?.fallback && run.route.participation) {
          run.fast.engagement = run.route.participation
          run.engagement = run.route.participation
          if (
            run.route.quick &&
            run.route.action === 'new' &&
            !run.route.requiresFile &&
            !run.m.parts.some((p) => p.type === 'media' || p.type === 'card')
          )
            run.fast.lane = 'quick'
        }
        const proactive =
          (!run.fast || run.fast.fallback) && !run.m.mention && run.route.participation === 'proactive'
        const cooldown = groupPolicy(s.config(), run.m.group).cooldown * 1000
        if (
          !run.ticket &&
          (run.route.quiet ||
            (!run.m.mention &&
              (run.route.action === 'silent' || run.route.participation === 'silent')) ||
            (proactive && Date.now() - (s.get('lastSpeech', run.m.group) || 0) < cooldown))
        ) {
          conclude('ignore', '模型判断无需接话')
          s.put('run', run.id, { ...run, state: 'ignored' })
          return false
        }
        if (!run.ticket && run.route.attach) {
          const t = s.tickets.get(run.route.attach)
          if (
            t &&
            t.ended?.by !== 'human' &&
            t.channels.some((c) => c.address.group === run.m.group) &&
            this.policy().revalidate(t.mandate)
          ) {
            this.engine.attach(t.id, id, run.route.brief)
            run.ticket = t.id
          }
        }
      }
      if (run.subscribed || !run.fast || run.fast.fallback)
        run.social = !run.m.mention && !run.subscribed && run.route?.participation !== 'requested'
      run.assessed = true
    }
    if (!run.ticket) {
      const decision = conclude('accept', run.route?.brief || '按群策略分配任务', {
        title: run.m.text.slice(0, 80) || '群任务',
        scope: run.m.thread,
        rules: ['groupParticipation'],
      })
      if (!decision.ticketId) return pause()
      run.ticket = decision.ticketId
    }
    if (scheduled) run.assessed = true
    else run.executor = run.fast?.lane === 'quick' && !run.subscribed ? 'quick' : 'harness'
    s.put('run', run.id, run)
    return true
  }
  async process(run) {
    if (!run.flow) return this.previous.process(run)
    const s = this.store
    if (!live(s.get('run', run.id))) return
    try {
      run.state = 'running'
      s.put('run', run.id, run)
      if ((!run.ticket || !run.assessed) && !(await this.admit(run))) return
      const prior = s.pendingRuns().find((r) => r.ticket === run.ticket)
      if (prior && prior.id !== run.id) return pause()
      const t = s.tickets.get(run.ticket),
        a = latestAssignment(t)
      if (t.ended) {
        s.put('run', run.id, { ...run, state: 'stopped' })
        return
      }
      run.assignment = a.id
      const command = s.get('assignmentWork', a.id)
      if (a.state === 'pending' && command?.state !== 'pending') throw Error('任务缺少执行分配记录')
      if (a.state === 'pending') this.engine.assignmentStarted(t.id, a.id)
      const inputs = s.tickets
        .get(t.id)
        .inputs.filter(
          (i) =>
            i.kind !== 'trigger' ||
            i.context ||
            i.triggerId === triggerOf(run) ||
            (t.origin.triggerId === triggerOf(run) && t.origin.triggerIds.includes(i.triggerId)),
        )
      run.assignmentInputs = inputs.slice(-20).map((i) =>
        i.kind === 'trigger'
          ? {
              kind: i.kind,
              text: s.triggers.get(i.triggerId)?.text?.slice(0, 1200),
              note: i.note,
              context: i.context,
            }
          : i,
      )
      this.engine.inputsDelivered(
        t.id,
        a.id,
        inputs.map((i) => i.id),
      )
      run.inputIds = inputs.map((i) => i.id)
      s.put('run', run.id, run)
      let result
      if (
        run.subscribed &&
        (run.route?.quiet || run.route?.action === 'silent' || run.fast?.engagement === 'quiet')
      ) {
        s.atomic(() => {
          this.engine.inputsRead(t.id, run.inputIds)
          const more = s.pendingRuns().some((r) => r.id !== run.id && r.ticket === t.id)
          this.engine.report(t.id, {
            state: more ? 'progress' : 'ready',
            summary: '已读本条补充，无需在群里回复',
          })
          s.put('run', run.id, { ...run, state: 'ignored' })
        })
        return
      }
      if (run.executor === 'archive') return await this.archiveDay(run)
      if (run.executor === 'reminder') result = { text: run.m.text }
      else if (run.route?.action === 'clarify' || run.route?.action === 'stop')
        result = { text: run.route.question }
      else if (run.executor === 'quick') {
        const text = await quickAnswer(this, run)
        if (text) result = { text }
        else {
          run.fast.lane = 'responsible'
          run.fast.fallback = '快答转交'
          run.executor = 'harness'
          run.route = await this.plan(this, run)
        }
      }
      if (!result) {
        run.fast &&= { ...run.fast, responsibleStarted: run.fast.responsibleStarted || Date.now() }
        const m =
          run.route?.source && !run.m.refs.length ? { ...run.m, refs: [run.route.source] } : run.m
        const ref = this.caps.reference(m),
          policy = groupPolicy(s.config(), m.group)
        const shell = policy.code !== false && !policy.disabled?.includes('runCode')
        run.executor = shell ? 'harness' : 'tools'
        if (!live(s.get('run', run.id))) return
        s.put('run', run.id, run)
        result = await (shell ? this.worker : toolAgent)(this, run, ref)
      }
      if (!result.text?.trim() && !result.artifact && !result.artifacts?.length)
        throw Error('执行者未返回文字或文件')
      this.finish(run, replyMentions(result.text || '', run.m, s), result.artifact, false, result)
    } catch (e) {
      if (!live(s.get('run', run.id))) return
      if (e instanceof Pending) {
        s.put('run', run.id, { ...run, after: Math.max(run.after || 0, Date.now() + 1500) })
        return
      }
      if (run.assignment) this.finish(run, '这次处理遇到问题：' + e.message, null, true)
      else {
        const id = triggerOf(run),
          c = this.engine.candidate(id)
        if (c)
          this.engine.decide(id, {
            kind: 'unavailable',
            evalId: c.evalId,
            reason: e.message.slice(0, 180),
          })
        s.put('run', run.id, { ...run, state: 'failed', answer: e.message })
      }
    }
  }
}
