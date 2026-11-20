import {existsSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'

export const packs = {'015':'熊猫头','031':'沙雕企鹅','035':'猫和老鼠','049':'猫咪日常'}
const modes = ['off','requested','social']
export function pluginSettings(store, group) {
  return store.get('groupPlugins',group) || {mode:'off', packs:Object.keys(packs), location:'', shop:''}
}
export function savePlugins(store, group, input) {
  if (!modes.includes(input.mode) || !Array.isArray(input.packs) || input.packs.some(p=>!Object.hasOwn(packs,p)))
    throw Error('请选择有效的系列和斗图模式')
  if (input.mode !== 'off' && !input.packs.length) throw Error('请选择至少一个系列')
  return store.put('groupPlugins',group,{mode:input.mode,packs:[...new Set(input.packs)],
    location:String(input.location || '').slice(0,150), shop:String(input.shop || '').slice(0,100)})
}
const reactions = [
  '开心 快乐 高兴 大笑 哈哈 欢乐 得意 狂喜 好耶 笑死',
  '难过 委屈 哭哭 伤心 眼泪 崩溃 破防',
  '拒绝 嫌弃 丑拒 不要 无语 白眼 鄙视',
  '溜了 逃跑 再见 告辞 下班 开溜',
  '惊讶 吃惊 震惊 震撼 愣住 目瞪口呆',
  '生气 愤怒 拍桌 敲桌 发火 气死',
  '围观 吃瓜 看戏 瓜子 搬凳子',
  '赞同 点赞 支持 厉害 牛棒 佩服 鼓掌',
  '尴尬 汗颜 社死 心虚 脸红 尴笑',
].map(line=>line.split(' '))
function tokens(value) {
  const words = String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return [...new Set(words.flatMap(word=>word.length <= 2 ? [word] :
    [word,...Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))]))]
}
export class MemeLibrary {
  constructor(dir) { this.dir = dir }
  load() {
    const path = join(this.dir,'index.json')
    if (!existsSync(path)) return []
    const stamp = statSync(path).mtimeMs
    if (stamp !== this.stamp) {
      this.items = JSON.parse(readFileSync(path,'utf8')).items.flatMap(item=>{
        if (!Object.hasOwn(packs,item.pack) || !/^[a-f0-9]{40}$/.test(item.id)) return []
        const caption = [item.title,item.text].filter(Boolean).join(' ')
        const moods = reactions.filter(words=>words.some(word=>caption.includes(word))).flat()
        return [{...item, keywords:[packs[item.pack],caption,...moods].join(' ').toLowerCase()}]
      })
      this.stamp = stamp
    }
    return this.items
  }
  search(settings, query, recent, seed) {
    const terms = tokens(query), used = new Set(recent)
    const scored = this.load().filter(i=>settings.packs.includes(i.pack)).map(item=>({
      item, score:terms.reduce((sum,t)=>sum+(item.keywords.includes(t)?t.length:0),0),
      tie:createHash('sha256').update(seed+item.id).digest().readUInt32BE()
    })).sort((a,b)=>b.score-a.score || a.tie-b.tie)
    const seen = new Set()
    const unique = scored.filter(({item})=>!seen.has(item.id) && seen.add(item.id))
    return [...unique.filter(x=>!used.has(x.item.id)&&x.score),...unique.filter(x=>x.score&&used.has(x.item.id)),
      ...unique.filter(x=>!x.score&&!used.has(x.item.id))].slice(0,12).map(({item})=>({
        id:item.id,series:packs[item.pack],caption:item.title,text:item.text?.slice(0,100),mime:item.mime
      }))
  }
  bytes(item) {return readFileSync(join(this.dir,'files',item.id))}
}
export function registerMemes(caps) {
  const library = caps.memes = new MemeLibrary(join(caps.dir,'..','memes'))
  const register = (name,description,param,execute)=>caps.register({provider:'memes',
    spec:{type:'function',function:{name,description,parameters:{type:'object',properties:{[param]:{type:'string'}},required:[param]}}},
    execute:(args,ctx)=>{
      const group = ctx.m.group, settings = pluginSettings(caps.store,group)
      if (settings.mode === 'off' || (settings.mode === 'requested' && ctx.social)) throw Error('本群未开启此次斗图')
      return execute(args,ctx,settings,caps.store.get('recentMemes',group)?.ids || [])
    }})
  register('searchMemes','按群聊语境搜索本地表情包。query 写系列、动作或情绪，返回可选择的图片。','query',
    ({query},ctx,settings,recent)=>({status:'ok',data:{candidates:library.search(settings,query,recent,ctx.m.id)}}))
  register('pickMeme','从搜索结果选一张贴切的表情包作为本轮 QQ 图片交付。','id',({id},ctx,settings,recent)=>{
    const item = library.load().find(i=>i.id===id && settings.packs.includes(i.pack))
    if (!item) throw Error('所选表情不在本群图库中')
    const artifact = caps.save(ctx.m.group,item.mime,library.bytes(item))
    caps.store.put('recentMemes',ctx.m.group,{ids:[id,...recent.filter(x=>x!==id)].slice(0,20)})
    return {status:'ok',data:{artifact,caption:item.title}}
  })
}

