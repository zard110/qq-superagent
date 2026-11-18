export const officialBase = 'https://api.deepseek.com'
const flash = 'deepseek-flash',
  pro = 'deepseek-v4-pro'
const modelRoutes = [flash, pro]
const roles = {
  chat: ['主模型', modelRoutes],
  worker: ['子 Agent', ['follow', ...modelRoutes]],
  vision: ['图像理解', [flash, 'follow', 'off']],
  search: ['网页搜索', ['official', 'off']],
  fetch: ['网页读取', ['auto', 'official', 'local', 'off']],
  speech: ['音轨转写', ['official', 'off']],
  ocr: ['文字识别', ['official', 'off']],
  tts: ['语音合成', ['official', 'off']],
  image: ['图像生成', ['off']],
}
const labels = {
  follow: '跟随主模型',
  official: 'DeepSeek 官方',
  local: '本机读取公开网页',
  off: '关闭',
  auto: 'DeepSeek 官方（未设密钥时本机读取）',
  [flash]: 'DeepSeek 官方 · Flash',
  [pro]: 'DeepSeek 官方 · V4 Pro',
  legacy: '沿用已保存的供应商',
}
const official = (p) => /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(p?.base || '')
export function settings(c) {
  const prior = c.providers || {}
  const key = c.vendors?.deepseek?.key ?? (official(prior.chat) ? prior.chat.key : '') ?? ''
  const routes = {},
    catalog = {}
  for (const [role, [label, choices]] of Object.entries(roles)) {
    const old = prior[role]
    let selected = choices[0]
    if (old?.base) {
      if (
        modelRoutes.includes(old.model) &&
        official(old) &&
        (!old.key || old.key === key) &&
        choices.includes(old.model)
      )
        selected = old.model
      else if (
        official(old) &&
        old.model === 'deepseek-chat' &&
        (!old.key || old.key === key) &&
        choices.includes(flash)
      )
        selected = flash
      else if (old.key || !['https://api.tavily.com/search', 'https://queue.fal.run'].includes(old.base))
        selected = 'legacy'
    }

    if (role === 'vision' && !old && prior.chat?.base && !official(prior.chat)) selected = 'follow'
    routes[role] = c.routes?.[role] ?? selected
    const options = old?.base ? [...choices, 'legacy'] : choices
    catalog[role] = { label, options: options.map((id) => [id, labels[id]]) }
  }
  return { routes, catalog, vendors: { deepseek: { key } } }
}
export function selectedProvider(c, role) {
  if (!Object.hasOwn(roles, role)) return
  const { routes, vendors } = settings(c),
    choice = routes[role]
  if (choice === 'follow' && ['worker', 'vision'].includes(role)) return selectedProvider(c, 'chat')
  if (choice === 'legacy') return c.providers[role]
  if (choice === 'local' || (choice === 'auto' && !vendors.deepseek.key))
    return { kind: 'local', base: 'HTTP' }
  if (choice === 'off') return
  if (!roles[role][1].includes(choice)) throw Error('无效的模型或供应商设置')
  return {
    kind: 'deepseek',
    base: officialBase,
    key: vendors.deepseek.key,
    model: modelRoutes.includes(choice) ? choice : undefined,
  }
}
export function requireProvider(c, role) {
  const p = selectedProvider(c, role)
  if (
    !p?.base ||
    (p.kind !== 'deepseek' && !p.model && ['chat', 'worker', 'vision', 'speech'].includes(role))
  )
    throw Error('请在「接入与模型」配置' + (roles[role]?.[0] || role))
  if (role === 'vision' && p.kind === 'deepseek' && p.model !== flash)
    throw Error('当前主模型不支持图像输入，请在「图像理解」选择 Flash')
  if (p.kind === 'deepseek' && !p.key) throw Error('请先在「模型供应商」保存 DeepSeek 官方 API Key')
  return p
}
