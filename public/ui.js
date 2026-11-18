const $ = (s) => document.querySelector(s),
  view = $('#view'),
  notice = $('#notice')
let state,
  tab = '运行',
  token = sessionStorage.token || ''
const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
async function api(path, data) {
  const r = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  })
  if (r.status === 401) throw Error('管理员令牌无效')
  const body = await r.json()
  if (!r.ok) throw Error(body.detail || '请求失败')
  return body
}
function field(id, name, value = '', type = 'text') {
  return (
    '<label>' +
    escape(name) +
    '<input id="' +
    id +
    '" type="' +
    type +
    '" value="' +
    escape(value) +
    '"></label>'
  )
}
function select(id, name, values, current) {
  return (
    '<label>' +
    name +
    '<select id="' +
    id +
    '">' +
    values
      .map(
        ([v, l]) =>
          '<option value="' +
          escape(v) +
          '" ' +
          (v === current ? 'selected' : '') +
          '>' +
          escape(l) +
          '</option>',
      )
      .join('') +
    '</select></label>'
  )
}
function area(id, name, value) {
  return '<label>' + name + '<textarea id="' + id + '">' + escape(value) + '</textarea></label>'
}
function card(name, html) {
  return '<section><h2>' + escape(name) + '</h2>' + html + '</section>'
}
function item(title, detail) {
  return (
    '<div class="item"><strong>' + escape(title) + '</strong><small>' + escape(detail) + '</small></div>'
  )
}
const val = (id) => $('#' + id).value
const btn = (id, title) => '<button id="' + id + '">' + title + '</button>'
function on(id, fn) {
  $('#' + id).onclick = async () => {
    notice.textContent = ''
    try {
      await fn()
    } catch (e) {
      notice.textContent = e.message
    }
  }
}
async function refresh() {
  state = await api('state')
  $('#connection').textContent = 'QQ · ' + state.qq
  render()
}
async function save() {
  await api('config', state.config)
  await refresh()
  notice.textContent = '配置已保存'
}
function render() {
  $('#login').hidden = true
  $('#workspace').hidden = false
  $('#title').textContent = tab
  const nav = $('#nav')
  nav.replaceChildren()
  for (const t of ['运行', '模型供应商', '接入与模型', '群与人格', '能力测试', '定时提醒']) {
    const b = document.createElement('button')
    b.textContent = t
    b.setAttribute('aria-current', String(tab === t))
    b.onclick = () => {
      notice.textContent = ''
      tab = t
      render()
    }
    nav.append(b)
  }
  const c = state.config
  if (tab === '运行') {
    view.innerHTML =
      card(
        '任务',
        btn('reload', '刷新') +
          state.runs
            .map((r) =>
              item(r.question, r.group + ' · ' + r.state + ' · ' + (r.answer || r.ticket || '')),
            )
            .join('') +
          (state.runs.length ? '' : '<p>等待群消息</p>'),
      ) +
      card(
        '每日群记忆',
        state.memories
          .map((m) =>
            item(
              m.group,
              [
                m.day || '等待北京时间 01:00',
                m.status,
                m.count != null ? m.count + ' 条消息' : '',
                m.error,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          )
          .join('') || '<p>等待群历史</p>',
      ) +
      card(
        '投递记录',
        state.deliveries
          .map((o) => item(o.text || '媒体文件', o.group + ' · ' + o.status + ' ' + (o.detail || '')))
          .join('') || '',
      )
    const items = view.querySelectorAll('section:first-child .item')
    items.forEach((row, i) => {
      const b = document.createElement('button')
      b.textContent = '查看调用'
      row.append(b)
      b.onclick = async () => {
        try {
          const detail = await api('run', { id: state.runs[i].id })
          const pre = document.createElement('pre')
          pre.textContent = JSON.stringify(
            {
              executor: detail.executor,
              conversation: detail.route,
              progress: detail.progress,
              steps: detail.steps,
            },
            null,
            2,
          )
          b.replaceWith(pre)
        } catch (e) {
          notice.textContent = e.message
        }
      }
    })
    on('reload', refresh)
  }
  if (tab === '模型供应商') {
    const vendor = c.vendors.deepseek
    view.innerHTML = card(
      'DeepSeek 官方',
      '<p><small>api.deepseek.com · ' +
        (vendor.key ? '已保存密钥' : '尚未配置密钥') +
        '</small></p>' +
        field('deepseekKey', 'API Key', vendor.key, 'password') +
        '<p>主模型、子 Agent 和已启用的官方能力共用此密钥。</p>' +
        '<p><a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">管理官方 API Key</a> · <a href="https://api-docs.deepseek.com/zh-cn/news/news261113/" target="_blank" rel="noreferrer">官方能力说明</a></p>' +
        btn('vendorSave', '保存供应商'),
    )
    on('vendorSave', async () => {
      vendor.key = val('deepseekKey').trim()
      await save()
    })
  }
  if (tab === '接入与模型') {
    const pick = (role) => {
      const item = state.providerCatalog[role]
      return select('role-' + role, item.label, item.options, c.routes[role])
    }
    view.innerHTML =
      card(
        'QQ 开放平台',
        '<div class="grid">' +
          field('appId', 'App ID', c.qq.appId) +
          field('secret', 'Client Secret', c.qq.secret, 'password') +
          '</div>',
      ) +
      card(
        '对话与视觉',
        '<div class="grid">' +
          ['chat', 'worker', 'vision'].map(pick).join('') +
          '</div>' +
          btn('openVendors', '配置模型供应商'),
      ) +
      card(
        '工具与媒体',
        '<div class="grid">' +
          ['search', 'fetch', 'speech', 'ocr', 'tts', 'image'].map(pick).join('') +
          '</div>',
      ) +
      btn('save', '保存配置')
    on('openVendors', () => {
      tab = '模型供应商'
      render()
    })
    on('save', async () => {
      c.qq = { appId: val('appId'), secret: val('secret') }
      for (const role of Object.keys(state.providerCatalog)) c.routes[role] = val('role-' + role)
      await save()
    })
  }
  if (tab === '群与人格') {
    view.innerHTML =
      card(
        '全局人格',
        area('persona', '回复性格和格式', c.persona) +
          btn('defaults', '载入默认') +
          btn('global', '保存人格'),
      ) +
      card(
        '群策略',
        field('group', '群 OpenID', state.groups[0] || Object.keys(c.groups)[0] || '') +
          btn('load', '读取策略') +
          '<div id="policy"></div>',
      )
    on('defaults', () => {
      $('#persona').value = state.persona
    })
    on('global', async () => {
      c.persona = val('persona')
      await save()
    })
    const switches = {
      getGroupInfo: '查询本群资料与成员',
      searchHistory: '检索群历史和每日记忆',
      recognizeText: '文字识别',
      synthesizeSpeech: '语音合成',
      searchWeb: '公开网页搜索',
      readWebPage: '读取网页正文、配图和视频',
      analyzeMedia: '图片与视频理解',
      generateImage: '生图与改图',
      resolveAudioSource: '获取公开音乐音源',
      editAudio: '音频剪辑',
      downloadResource: '下载公开素材',
      scheduleReminder: '群内设置提醒',
    }
    function policy() {
      const g = val('group'),
        p = c.groups[g] || {}
      $('#policy').innerHTML =
        select(
          'mode',
          '未 @ 时的介入方式',
          [
            ['quiet', '克制参与'],
            ['social', '像群友聊天'],
            ['rules', '仅命中规则'],
          ],
          p.mode,
        ) +
        field('nickname', '昵称', p.nickname ?? '小搭') +
        field('rules', '触发词（用逗号隔开）', (p.rules || []).join(',')) +
        field('cooldown', '自然发言冷却（秒）', p.cooldown ?? 90, 'number') +
        area('override', '本群人格（留空继承全局）', p.persona || '') +
        '<label><input id="active" type="checkbox" ' +
        (p.active ? 'checked' : '') +
        '> 允许主动投递</label><label><input id="code" type="checkbox" ' +
        (p.code !== false ? 'checked' : '') +
        '> 允许子 Agent 执行沙箱代码及按需安装 Python 工具包</label>' +
        Object.entries(switches)
          .map(
            ([k, label]) =>
              '<label><input type="checkbox" id="allow-' +
              k +
              '" ' +
              (p.disabled?.includes(k) ? '' : 'checked') +
              '> ' +
              label +
              '</label>',
          )
          .join('') +
        btn('gsave', '保存此群')
      on('gsave', async () => {
        if (!val('group').trim()) throw Error('请填写群 OpenID')
        c.groups[val('group').trim()] = {
          mode: val('mode'),
          nickname: val('nickname'),
          rules: val('rules')
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
          cooldown: Math.max(5, Number(val('cooldown')) || 90),
          persona: val('override'),
          active: $('#active').checked,
          disabled: Object.keys(switches).filter((k) => !$('#allow-' + k).checked),
          code: $('#code').checked,
        }
        await save()
      })
    }
    policy()
    on('load', policy)
  }
  if (tab === '能力测试') {
    view.innerHTML = card(
      '试跑能力',
      select('skill', '能力', [
        ['chat', '主模型'],
        ['worker', '子 Agent'],
        ['harness', 'Harness 群沙箱'],
        ['recognizeText', '文字识别（图片或 PDF）'],
        ['synthesizeSpeech', '语音合成'],
        ['editAudio', '音频剪辑（上传音频）'],
        ['resolveAudioSource', '音乐卡片公开音源（输入 URL）'],
        ['readWebPage', '读取网页'],
        ['searchWeb', '搜索公开网页'],
        ['analyzeMedia', '图片或视频理解'],
      ]) +
        field('query', '问题、搜索词或网页 URL') +
        '<div id="sessionOptions" hidden>' +
        field('testSession', '测试会话（同名可续办，留空新建）') +
        '</div>' +
        '<label>素材<input id="media" type="file" accept="image/*,video/*,audio/*,application/pdf"></label>' +
        '<div id="audioOptions" hidden>' +
        field('clipStart', '音频起点（秒）', '0', 'number') +
        field('clipEnd', '音频终点（秒，留空到结尾）', '', 'number') +
        '</div>' +
        btn('test', '开始测试') +
        '<pre id="output"></pre>',
    )
    $('#skill').onchange = () => {
      const audio = val('skill') === 'editAudio'
      $('#sessionOptions').hidden = val('skill') !== 'harness'
      $('#audioOptions').hidden = !audio
      $('#query').parentElement.hidden = audio
    }
    on('test', async () => {
      const button = $('#test')
      button.disabled = true
      $('#output').textContent = '正在调用…'
      try {
        const f = $('#media').files[0],
          q = val('query'),
          name = val('skill')
        let file
        if (f && ['analyzeMedia', 'recognizeText', 'editAudio', 'harness'].includes(name)) {
          if (f.size > 32 * 1024 * 1024) throw Error('素材超过 32 MiB')
          file = {
            mime: f.type,
            data: await new Promise((ok, fail) => {
              const r = new FileReader()
              r.onload = () => ok(r.result.split(',')[1])
              r.onerror = fail
              r.readAsDataURL(f)
            }),
          }
        }
        const result = await api('test', {
          name,
          question: q,
          ...(name === 'harness' ? { session: val('testSession').trim() } : {}),
          args: {
            question: q,
            text: q,
            url: q,
            query: q,
            ...(name === 'editAudio'
              ? {
                  start: Number(val('clipStart')),
                  ...(val('clipEnd').trim() ? { end: Number(val('clipEnd')) } : {}),
                }
              : {}),
          },
          file,
        })
        if (name === 'harness' && result.session) $('#testSession').value = result.session
        const wav = result.audio
        delete result.audio
        $('#output').textContent = JSON.stringify(result, null, 2)
        if (wav) {
          const player = document.createElement('audio')
          player.controls = true
          player.src = 'data:' + (result.audioMime || 'audio/wav') + ';base64,' + wav
          $('#output').append(player)
        }
      } catch (e) {
        $('#output').textContent = e.message
      } finally {
        button.disabled = false
      }
    })
  }
  if (tab === '定时提醒') {
    view.innerHTML =
      card(
        '创建提醒',
        field('dest', '目标群 OpenID') +
          field('when', '首次触发（北京时间）', '', 'datetime-local') +
          select('repeat', '重复', [
            ['0', '仅一次'],
            ['86400000', '每天'],
            ['604800000', '每周'],
          ]) +
          area('text', '提醒内容', '') +
          btn('add', '添加提醒'),
      ) +
      card(
        '已保存的计划',
        state.schedules
          .map(
            (s, i) =>
              item(
                s.text,
                s.group +
                  ' · ' +
                  new Date(s.next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
                  ' 北京时间',
              ) + btn('remove' + i, '移除'),
          )
          .join(''),
      )
    on('add', async () => {
      await api('schedule', {
        group: val('dest'),
        at: new Date(val('when') + '+08:00').toISOString(),
        every: Number(val('repeat')),
        text: val('text'),
      })
      await refresh()
    })
    state.schedules.forEach((s, i) =>
      on('remove' + i, async () => {
        await api('schedule', { remove: s.id })
        await refresh()
      }),
    )
  }
}
$('#signin').onsubmit = async (e) => {
  e.preventDefault()
  token = val('token')
  try {
    await refresh()
    sessionStorage.token = token
    notice.textContent = ''
  } catch (e) {
    notice.textContent = e.message
  }
}
if (token)
  refresh().catch((e) => {
    notice.textContent = e.message
  })
