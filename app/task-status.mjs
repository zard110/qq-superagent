import { key } from './messages.mjs'

export function taskStatus(store, group, id) {
  const run = id && store.get('run', id)
  if (!run || run.m.group !== group) return '我没找到对应的任务，可以引用那条委托。'
  if (run.state === 'stopped') return '这项任务已停止。'
  if (run.state === 'failed' || run.state === 'partial') return run.answer || '这项任务未能全部完成。'
  if (run.state === 'done') {
    const reply = key(run.id, 'reply')
    const rows = store.db.prepare("SELECT json_extract(body,'$.status') AS status FROM records WHERE bucket='out' AND (id=? OR json_extract(body,'$.replyId')=?)").all(reply,reply)
    if (rows.some(r => r.status === 'held')) return '任务已完成，有结果等待领取。'
    if (rows.length && rows.every(r => r.status === 'sent')) return '任务已完成，结果已发出。'
    return '任务已完成，结果正在投递。'
  }
  const row = store.db.prepare("SELECT body FROM records WHERE bucket='stageReport' AND json_extract(body,'$.run')=? ORDER BY rowid DESC LIMIT 1").get(id)
  if (row) {
    const {completed, next} = JSON.parse(row.body)
    return [completed, next].filter(Boolean).join('\n')
  }
  if (run.progress?.startedAt) return 'Agent 已开始执行，尚未提交第一份阶段报告。'
  if (run.waitReason) return run.waitReason + '。'
  return run.state === 'queued' ? '任务已收到，正在安排。' : '任务正在处理中。'
}
