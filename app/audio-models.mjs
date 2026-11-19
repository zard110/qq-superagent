// BeefTV /v1/models declares these controls separately for each audio model.
const text = (description, maxLength) => ({type:'string', description, maxLength, minLength:1})
const choice = values => ({type:'string', enum:values})
const number = (minimum, maximum) => ({type:'number', minimum, maximum})
const voices = {
  'male-qn-qingse':'青涩青年男声', 'male-qn-jingying':'成熟专业男声',
  'Chinese (Mandarin)_Gentleman':'温润男声', 'female-tianmei':'甜美女声',
  'female-chengshu':'成熟女声', 'Chinese (Mandarin)_Soft_Girl':'柔和女声',
  'female-shaonv':'少女声',
}
const minimaxVoice = text('按语言、性别和音色要求选择真实 ID：'+Object.entries(voices).map(([id,label])=>label+'='+id).join('，')+'。也可用用户明确提供的有效自定义 ID。人名不代表可用音色。',160)
const minimax = {
  text:text('只放需要读出的原文',10000), voice:minimaxVoice,
  speed:number(0.5,2), pitch:number(-12,12), volume:number(0.1,10),
  emotion:choice(['happy','sad','angry','fearful','disgusted','surprised','calm','fluent','whisper']),
}
const song = {
  prompt:text('描述音乐风格、语言、人声、节奏、速度 BPM 和编配。',2000),
  lyrics:text('歌词正文，可含主歌、副歌等段落。保留群友给定的原词。',3500),
}
const instrumental = {type:'boolean',description:'纯音乐、伴奏设为 true；有演唱或 rap 设为 false。'}
const models = {
  music:{
    'minimax-music-v3.0':{...song,is_instrumental:instrumental,lyrics_optimizer:{type:'boolean'}},
    'minimax-music-v2.6':{...song,is_instrumental:instrumental,
      sample_rate:{type:'integer',enum:[16000,24000,32000,44100]},bitrate:{type:'integer',enum:[32000,64000,128000,256000]}},
    'mureka-music-v8':song,
  },
  tts:{
    'minimax-speech-2.8-turbo':minimax, 'minimax-speech-2.8-hd':minimax,
    'seed-audio-1.0':{text:text('朗读原文',2000),instructions:text('音色、口吻或朗读指导',2000),
      speed:number(0.5,2),pitch:number(-12,12),volume:number(0.5,2),voice:text('此模型的有效音色 ID',160)},
  },
}
export const audioGuidance = '原创歌曲、说唱、配乐、伴奏用 generateMusic；朗读、对白、配音用 synthesizeSpeech；已有歌曲用 resolveAudioSource 或资源句柄，剪辑用 editAudio。制作歌曲先准备音乐描述，有词就把歌词放在 lyrics。选音色及语速、音高、情感时结合用户原话。人物描述可选接近的预设音色并说明实际使用的音色，只有真实自定义音色回执才能称为指定音色。'
export function audioProperties(kind) {
  const catalog = models[kind]
  const model = {...choice(Object.keys(catalog)), description:Object.entries(catalog).map(([id,props])=>id+' 支持 '+Object.keys(props).join('、')).join('。')}
  const properties = Object.assign({}, ...Object.values(catalog).reverse())
  return {model, ...properties}
}
export function audioRequest(kind, args, requestText = '') {
  const catalog = models[kind]
  const {model = Object.keys(catalog)[0], ...params} = args
  if (!Object.hasOwn(catalog,model)) throw Error('不支持的'+(kind === 'music' ? '音乐' : '语音')+'模型')
  const fields = catalog[model]
  const input = kind === 'music' ? 'prompt' : 'text'
  if (!(typeof params[input] === 'string' && params[input].trim())) throw Error('缺少 '+input)
  for (const [key,value] of Object.entries(params)) {
    if (!Object.hasOwn(fields,key)) throw Error(model+' 不支持参数 '+key)
    const spec = fields[key]
    if ((spec.type === 'integer' ? !Number.isInteger(value) : typeof value !== spec.type) ||
        (spec.enum && !spec.enum.includes(value)) ||
        (typeof value === 'string' && (!value.trim() || [...value].length > spec.maxLength)) ||
        (typeof value === 'number' && (!Number.isFinite(value) || value < spec.minimum || value > spec.maximum)))
      throw Error('无效的 '+key+'，请按模型声明的参数范围填写')
  }
  if (kind === 'music') {
    if (params.is_instrumental && (params.lyrics || params.lyrics_optimizer)) throw Error('纯音乐不能同时指定歌词或歌词优化')
    if (model === 'mureka-music-v8' && !params.lyrics) throw Error('Mureka 需要歌词')
  } else {
    if (model.startsWith('minimax-')) {
      const aliases = {stella:'female-shaonv',tide:'male-qn-qingse'}
      params.voice = Object.hasOwn(aliases,params.voice) ? aliases[params.voice] : params.voice || 'male-qn-qingse'
      params.speed ??= 1
    }
    if (params.voice && !(model.startsWith('minimax-') && Object.hasOwn(voices,params.voice)) &&
        !(/^[A-Za-z0-9][A-Za-z0-9_ ().:-]{0,159}$/.test(params.voice) && requestText.includes(params.voice)))
      throw Error('未知音色，请按用户描述重新选择已列出的音色或使用用户提供的有效音色 ID')
  }
  const body = {model,input:params[input],response_format:'mp3'}
  delete params[input]
  return {...body,...params,...(kind === 'music' && {stream_format:'sse'})}
}
export function appliedAudio(body) {
  const {input,lyrics,stream_format,response_format,instructions,...controls} = body
  return {...controls,...(body.voice && Object.hasOwn(voices,body.voice) && {voiceLabel:voices[body.voice]})}
}
