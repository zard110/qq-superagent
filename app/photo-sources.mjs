export function pagePhotos(page, originalsOnly = false) {
  const cached = new Map((page.browserImages || []).map(({position, resource}) => [position, resource]))
  const choices = new Map((page.images || []).map((id,i) => [i+1,id]))
  if (!originalsOnly) for (const [position, resource] of cached) choices.set(position,resource)
  return [...choices].map(([position, resource]) => ({position,resource}))
}

export function photoPageAllowed(page, site, question = '') {
  if (site !== 'instagram.com') return true
  let host
  try { host = new URL(page).hostname.toLowerCase() } catch { return false }
  return /(^|\.)instagram\.com$/.test(host) ||
    (/\b(?:x|twitter)\b|推特/i.test(question) && /(^|\.)(?:x|twitter)\.com$/.test(host))
}

export function instagramPost(value) {
  try {
    const u = new URL(value)
    const m = /^\/(?:[\w.]+\/)?(p|reel)\/([\w-]+)(?:\/embed(?:\/captioned)?)?\/?$/.exec(u.pathname)
    if (u.protocol === 'https:' && /^(?:www\.)?instagram\.com$/.test(u.hostname) && m)
      return 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/'
  } catch {}
}
export function isPostPhoto(source, target) {
  try {
    const post = instagramPost(source),
      url = new URL(target)
    return (
      !!post &&
      url.protocol === 'https:' &&
      ['www.instagram.com', 'i.instagram.com', 'instagram.com'].includes(url.hostname) &&
      url.pathname === new URL(post).pathname + 'media/'
    )
  } catch {
    return false
  }
}
