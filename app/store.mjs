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
      CREATE TABLE IF NOT EXISTS group_members(g TEXT, id TEXT, name TEXT, role TEXT, bot INTEGER, at TEXT, username TEXT, PRIMARY KEY(g,id));
      CREATE INDEX IF NOT EXISTS member_name ON group_members(g,name);
      CREATE INDEX IF NOT EXISTS history ON messages(g,at);
      CREATE TABLE IF NOT EXISTS daily_memory(g TEXT NOT NULL, day TEXT NOT NULL, entries TEXT NOT NULL, PRIMARY KEY(g,day));
      CREATE TABLE IF NOT EXISTS group_cards(g TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(g,id));
      CREATE INDEX IF NOT EXISTS card_status ON group_cards(g,status);`)
    this.depth = 0
    if (!this.get('migration', 'group-members-1'))
      this.atomic(() => {
        for (const row of this.db
          .prepare("SELECT body FROM messages WHERE author!='@bot' ORDER BY at,rowid")
          .iterate()) {
          this.observeMembers(JSON.parse(row.body))
        }
        this.put('migration', 'group-members-1', true)
      })
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
      .prepare(
        'INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body',
      )
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
  nextDelivery(busy = []) {
    const row = this.db
      .prepare(
        "SELECT o.body FROM records o WHERE o.bucket='out' AND json_extract(o.body,'$.status')='pending' AND json_array(json_extract(o.body,'$.group'),coalesce(nullif(json_extract(o.body,'$.origin'),''),nullif(json_extract(o.body,'$.replyId'),''),o.id)) NOT IN (SELECT value FROM json_each(?)) AND coalesce(json_extract(o.body,'$.after'),0)<=? AND (json_extract(o.body,'$.previous') IS NULL OR EXISTS(SELECT 1 FROM records p WHERE p.bucket='out' AND p.id=json_extract(o.body,'$.previous') AND json_extract(p.body,'$.status')='sent')) ORDER BY o.rowid LIMIT 1",
      )
      .get(JSON.stringify(busy), Date.now())
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
    const searchable = [
      m.text,
      ...m.parts.flatMap((p) => [p.text, p.title, p.summary]).filter(Boolean),
    ].join('\n')
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
  rememberMember(g, member, at) {
    if (!member.id || member.id === 'all' || member.scope === 'all') return
    this.db
      .prepare(
        `INSERT INTO group_members VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(g,id) DO UPDATE SET
      name=CASE WHEN excluded.name!='' AND (excluded.at>=at OR name='') THEN excluded.name ELSE name END,
      role=CASE WHEN excluded.role!='' AND (excluded.at>=at OR role='') THEN excluded.role ELSE role END,
      username=CASE WHEN excluded.username!='' AND (excluded.at>=at OR username='') THEN excluded.username ELSE username END,
      bot=max(bot,excluded.bot), at=max(at,excluded.at)`,
      )
      .run(
        g,
        member.id,
        member.name || '',
        member.role || '',
        Number(!!member.bot),
        at,
        member.username || '',
      )
  }
  observeMembers(m) {
    this.rememberMember(
      m.group,
      { id: m.author, name: m.nickname, username: m.username, role: m.role },
      m.at,
    )
    for (const member of m.mentions || []) this.rememberMember(m.group, member, m.at)
  }
  member(g, id) {
    return this.db
      .prepare(
        "SELECT id,coalesce(nullif(name,''),username) AS name,username,role,bot FROM group_members WHERE g=? AND id=?",
      )
      .get(g, id)
  }
  namedMembers(g, name) {
    return this.db
      .prepare(
        "SELECT id,coalesce(nullif(name,''),username) AS name,username,role,bot FROM group_members WHERE g=? AND (name=? OR username=?) ORDER BY id LIMIT 40",
      )
      .all(g, name, name)
  }
  observedMembers(g, after = '') {
    const rows = this.db
      .prepare(
        "SELECT id,coalesce(nullif(name,''),username) AS name,role,bot FROM group_members WHERE g=? AND id>? ORDER BY id LIMIT 31",
      )
      .all(g, after)
    return {
      members: rows.slice(0, 30),
      nextCursor: rows.length > 30 ? rows[29].id : null,
      observedCount: this.db.prepare('SELECT count(*) AS n FROM group_members WHERE g=?').get(g).n,
    }
  }
  memberHistoryStats(g) {
    return this.db
      .prepare(
        "SELECT count(*) AS messages, count(DISTINCT nullif(author,'')) AS speakers, min(at) AS first, max(at) AS last FROM messages WHERE g=? AND author!='@bot'",
      )
      .get(g)
  }
  history(
    g,
    {
      keyword = '',
      author = '',
      from = '',
      until = '9999',
      thread = '',
      limit = 12,
      excludeId = '',
    } = {},
  ) {
    return this.db
      .prepare(
        `SELECT body FROM messages WHERE g=? AND at>=? AND at<=? AND id!=?
         AND (at!=? OR rowid<coalesce((SELECT rowid FROM messages WHERE g=? AND id=?),9223372036854775807))
         AND (author!='@bot' OR id=coalesce(json_extract(body,'$.parts[0].source'),id))
         AND (?='' OR author=? OR (author!='@bot' AND json_extract(body,'$.nickname')=?)) AND (?='' OR thread=?)
         AND instr(lower(text),lower(?))>0 ORDER BY at DESC,rowid DESC LIMIT ?`,
      )
      .all(
        g,
        from,
        until,
        excludeId,
        until,
        g,
        excludeId,
        author,
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
