// Keep a share-card lookup tied to the article that was actually shared.
function webURL(value) {
  try {
    const u = new URL(value)
    if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) return u
  } catch {}
}
const titleKey = (s) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/\s*[-_|]\s*知乎(?:专栏)?\s*$/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
function xhsNote(link) {
  if (!link || !/(?:^|\.)(?:xiaohongshu|rednote)\.com$/i.test(link.hostname)) return
  return link.pathname.match(/^\/(?:discovery\/item|explore)\/([a-f\d]{24})\/?$/i)?.[1]
}
export function publicShareLink(value) {
  const link = webURL(value)
  if (link && /(^|\.)music\.163\.com$/i.test(link.hostname)) {
    const id = link.searchParams.get('id') || link.hash.match(/[?&]id=(\d+)/)?.[1]
    if (/^\d+$/.test(id || '')) return 'https://music.163.com/song?id=' + id
  }
  return xhsNote(link) ? link.origin + link.pathname : value
}
export function publicShareText(text) {
  return typeof text === 'string' ? text.replace(/https?:\/\/[^\s<>"）]+/gi, publicShareLink) : text
}
export function recentShareSite(text) {
  return (
    /(?:上面|上边|上一条|刚才|刚刚|前面)/.test(text) &&
    text.match(/小红书|知乎|音乐|歌曲|音频|卡片|分享|笔记/)?.[0]
  )
}
export function sharedArticle(ref, question = '') {
  const cards = ref.parts.filter((p) => p.type === 'card' && (p.title || webURL(p.url)))
  if (!cards.length) {
    const urls = [
      ...new Set((question.match(/https?:\/\/[^\s<>"）。，！？]+/gi) || []).map(publicShareLink)),
    ]
    if (urls.length === 1 && webURL(urls[0]))
      return { url: urls[0], site: xhsNote(webURL(urls[0])) ? '小红书' : '', title: '' }
    return
  }
  const direct = [...new Set(cards.map((p) => webURL(p.url)?.href).filter(Boolean))]
  if (direct.length > 1 || new Set(cards.map((p) => titleKey(p.title)).filter(Boolean)).size > 1) return
  return {
    title: cards.find((p) => p.title)?.title || '',
    site: cards.find((p) => p.site)?.site || (xhsNote(webURL(direct[0])) ? '小红书' : ''),
    preview: cards.find((p) => p.previewResource)?.previewResource,
    summary: cards.find((p) => p.summary)?.summary,
    url: direct[0],
  }
}

export function articleQuestion(question) {
  if (/查证|查一下是否|核[实查]|靠谱|生成|作图|提醒|对比|全网|翻译|查群|历史记录/.test(question))
    return false
  return /看看|看一下|帮我看|看下|作者|谁写|谁发[布表]|哪[个家]?(?:网站|平台)|出处|来源|正文|总结|概括|讲了什么|写了什么|核心观点|主要内容|(?:说|讲|写)(?:的|了)?(?:啥|什么)|什么意思|解读|配图|图里/.test(
    question,
  )
}

export async function inspectArticle(card, call) {
  let url = card.url,
    hit,
    page,
    searched = false
  const note = xhsNote(webURL(url))
  const domain = card.site.includes('知乎')
    ? 'zhihu.com'
    : note || card.site.includes('小红书')
      ? 'xiaohongshu.com'
      : undefined
  async function search() {
    searched = true
    const response = await call('searchWeb', {
      query: '"' + (note || card.title).replace(/"/g, '') + '"',
      domain,
      includeContent: true,
    })
    const matches = new Map()
    for (const item of Array.isArray(response.data) ? response.data : []) {
      const link = webURL(item.url)
      const answer =
        link?.hostname === 'www.zhihu.com' && link.pathname.match(/^\/question\/(\d+)\/answer\/\d+$/)
      if (!url && answer && titleKey(item.title?.split(' - ')[0]) === titleKey(card.title)) {
        const questionURL = link.origin + '/question/' + answer[1]
        const found = matches.get(questionURL) || { title: card.title, url: questionURL, answers: [] }
        found.answers.push(item)
        matches.set(questionURL, found)
        continue
      }
      if (!link || (note ? xhsNote(link) !== note : titleKey(card.title) !== titleKey(item.title)))
        continue
      if (domain && link.hostname !== domain && !link.hostname.endsWith('.' + domain)) continue
      if (url && !note) {
        const original = webURL(url)
        if (
          original?.origin !== link.origin ||
          original.pathname !== link.pathname ||
          (original.search && original.search !== link.search)
        )
          continue
      }
      matches.set(link.href, item)
    }
    if (matches.size === 1) hit = [...matches.values()][0]
  }
  if (!url && card.title) {
    await search()
    url = hit?.url
  }
  if (url) page = await call('readWebPage', { url })
  if (!searched && (card.title || note) && page?.status !== 'read' && !page?.data?.visuals?.length)
    await search()
  const live = page?.status === 'read' && page.data?.text
  const relatedAnswers = []
  if (!live && hit?.answers?.length) {
    // A question has multiple authors. Never attribute a respondent to the shared question.
    for (const [index, item] of hit.answers.slice(0, 2).entries()) {
      const answerPage = index === 0 ? await call('readWebPage', { url: item.url }) : undefined
      const read = answerPage?.status === 'read' && answerPage.data?.text
      if (read || item.indexedText || item.snippet)
        relatedAnswers.push({
          title: item.title,
          url: item.url,
          text: read || item.indexedText || item.snippet,
          coverage: read ? '回答网页' : item.indexedText ? '搜索索引中的回答' : '回答搜索摘要',
        })
    }
  }
  const text = live || hit?.indexedText || ''
  const author =
    (live && page.data.author) ||
    text
      .match(
        /^(?:[ \t]*@?[ \t]*(?:本文作者|作者|文\s*\/作者))[ \t]*[：:/／][ \t]*([^\n\r]{1,60})$/m,
      )?.[1]
      ?.trim()
  return {
    title: card.title || page?.data?.title,
    site: card.site || webURL(url)?.hostname,
    url: publicShareLink(url),
    summary: card.summary,
    images: page?.data?.images || [],
    visuals: page?.data?.visuals,
    visualFailures: page?.data?.visualFailures,
    visualScope: page?.data?.visualScope,
    videoCount: page?.data?.videoCount,
    imageCount: page?.data?.imageCount ?? page?.data?.images?.length ?? 0,
    preview: card.preview,
    linkFrom: card.url ? '卡片链接' : '同标题搜索结果',
    author,
    text,
    relatedAnswers,
    coverage: live
      ? '原文网页'
      : hit?.indexedText
        ? '搜索索引中的正文'
        : hit?.snippet
          ? '搜索摘要'
          : '卡片信息',
    snippet: hit?.snippet || (page?.status === 'metadata' ? page.data.text : undefined),
    failure: page?.status !== 'read' ? page?.data?.detail || page?.detail : undefined,
  }
}
export function articleAttribution(e) {
  const site = e.site ? '来源是' + e.site + '。' : '暂未确认来源网站。'
  const author = e.author
    ? '署名为' + e.author + '（依据' + e.coverage + '）。'
    : '目前能看到' + e.coverage + '，其中没有可核实的作者署名。'
  return site + author + (e.url ? '\n\n' + e.linkFrom + '：<' + e.url + '>' : '')
}
