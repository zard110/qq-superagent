import { DatabaseSync } from 'node:sqlite'
import { latestAssignment } from './core.mjs'

export const persona =
  '你是群里的小搭，自然、友善，先回答最重要的问题。日常一到三句，步骤多时分点。引用事实给出出处，不确定处说清楚。'
export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records(bucket TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS messages(g TEXT,id TEXT, idx TEXT, author TEXT, at TEXT, text TEXT, thread TEXT, body TEXT, PRIMARY KEY(g,id));
      CREATE INDEX IF NOT EXISTS idx_ref ON messages(g,idx);
      CREATE INDEX IF NOT EXISTS history ON messages(g,at);`)
    this.depth = 0
    const collection = (bucket, field = 'id') => ({
      get: (id) => this.get(bucket, id),
      save: (value) => this.put(bucket, value[field], value),
      list: () => this.all(bucket),
    })
    this.triggers = {
      ...collection('trigger'),
      disposition: (id) => this.get('disposition', id),
      saveDisposition: (id, v) => this.put('disposition', id, v),
    }
    this.threads = {
      ...collection('thread', 'key'),
      active: () => this.all('thread').filter((t) => t.pending.length || t.evaluating),
    }
    this.tickets = {
      ...collection('ticket'),
      open: () => this.all('ticket').filter((t) => !t.ended),
      active: () =>
        this.all('ticket').filter(
          (t) => t.undelivered.length || ['pending', 'running'].includes(latestAssignment(t)?.state),
        ),
    }
    this.decisions = {
      ...collection('decision'),
      byThread: (key) => this.all('decision').filter((v) => v.threadKey === key),
    }
  }
  atomic(fn) {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }
  get(bucket, id) {
    const r = this.db.prepare('SELECT body FROM records WHERE bucket=? AND id=?').get(bucket, id)
    return r && JSON.parse(r.body)
  }
  put(bucket, id, v) {
    this.db
      .prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body')
      .run(bucket, id, JSON.stringify(v))
    return v
  }
  all(bucket) {
    return this.db
      .prepare('SELECT body FROM records WHERE bucket=? ORDER BY rowid DESC')
      .all(bucket)
      .map((r) => JSON.parse(r.body))
  }
  pendingRuns() {
    return this.db
      .prepare(
        "SELECT body FROM records WHERE bucket='run' AND json_extract(body,'$.state') IN ('queued','running') ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(row.body))
  }
  nextDelivery() {
    const row = this.db
      .prepare(
        "SELECT body FROM records WHERE bucket='out' AND json_extract(body,'$.status')='pending' AND coalesce(json_extract(body,'$.after'),0)<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now())
    return row && JSON.parse(row.body)
  }
  nextSequence(group, origin) {
    return this.db
      .prepare(
        "SELECT coalesce(max(json_extract(body,'$.seq')),0)+1 AS seq FROM records WHERE bucket='out' AND json_extract(body,'$.group')=? AND json_extract(body,'$.origin')=?",
      )
      .get(group, origin).seq
  }
  del(bucket, id) {
    this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id)
  }
  message(m) {
    const searchable = [m.text, ...m.parts.flatMap((p) => [p.text, p.title, p.summary]).filter(Boolean)].join(
      '\n',
    )
    return this.db
      .prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?)')
      .run(m.group, m.id, m.idx, m.author, m.at, searchable, m.thread, JSON.stringify(m)).changes
  }
  lookup(g, id) {
    const r = this.db
      .prepare('SELECT body FROM messages WHERE g=? AND (idx=? OR id=?) ORDER BY rowid DESC LIMIT 1')
      .get(g, id, id)
    return r && JSON.parse(r.body)
  }
  history(g, { keyword = '', author = '', from = '', until = '9999', thread = '', limit = 12 } = {}) {
    return this.db
      .prepare(
        "SELECT body FROM messages WHERE g=? AND at>=? AND at<=? AND (?='' OR author=?) AND (?='' OR thread=?) AND instr(lower(text),lower(?))>0 ORDER BY at DESC,rowid DESC LIMIT ?",
      )
      .all(
        g,
        from,
        until,
        author,
        author,
        thread,
        thread,
        keyword,
        Math.min(40, Math.max(1, Number(limit) || 12)),
      )
      .map((r) => JSON.parse(r.body))
  }
  config() {
    return { persona, providers: {}, groups: {}, qq: {}, ...this.get('config', 'main') }
  }
}
