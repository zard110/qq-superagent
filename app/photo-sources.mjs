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
