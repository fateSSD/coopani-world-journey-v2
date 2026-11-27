/**
 * 拍照硬事实层与内核掌镜编译（方案 A + 方案 B 共用底座）。
 *
 * 定位边界：
 * - 插件代码只算 100% 确定的物理与状态硬事实：经纬度太阳高度、昼夜边界、
 *   实况天气与气温穿衣档、室内外属性、活动/菜品、人物与参考图状态、语言/画风；
 * - 画面构图、光线氛围、符合体温的衣着、眼神动作与场景细节交给内核大模型
 *   （主会话 `journey_photo.prompt` 或宿主 `WorldHost.cognition`）；
 * - 若内核未写完整词且无后台 cognition，再退回 `photoPrompt()` 规则模板兜底。
 */
import type { City } from './geo/cities.ts';
import { spotLook, vistaOf } from './geo/cities.ts';
import type { Forecast } from './geo/amap.ts';
import { spotProfile } from './geo/spot-profile.ts';
import { fmtHour } from './plan/dayplan.ts';
import {
  cleanDoing,
  daylitAt,
  isBareSpotDoing,
  minimalLightPart,
  onRoadRoutePhrase,
  onRoadScenePhrase,
  onRoadViewPhrase,
  sceneSun,
  shotIsNight,
  skyOf,
  type PhotoSubject,
  type SceneSun,
} from './photo.ts';

export interface PhotoFactsInput {
  readonly city: City;
  readonly hour: number;
  readonly month: number;
  readonly day: number;
  readonly spot?: string;
  readonly onRoad?: boolean;
  readonly mode?: string;
  readonly destCity?: string;
  readonly view?: 'ground' | 'sky';
  readonly subject?: PhotoSubject;
  readonly weather?: Forecast | null;
  readonly weatherText?: string;
  readonly feel?: string;
  readonly dish?: string;
  readonly doing?: string;
  readonly castOn?: boolean;
  readonly cast?: string;
  readonly personRefActive?: boolean;
  readonly libraryHint?: string;
  readonly style?: string;
  readonly lang?: 'en' | 'zh';
  readonly companion?: string;
}

export interface PhotoFacts {
  readonly city: string;
  readonly spot: string;
  readonly onRoad: boolean;
  readonly mode: string;
  readonly sky: boolean;
  readonly subject: PhotoSubject;
  readonly dateLabel: string;
  readonly placeLabel: string;
  readonly indoor: boolean;
  readonly urban: boolean;
  readonly sun: SceneSun;
  readonly phaseLabel: string;
  readonly daylightGuard: string;
  readonly nightShot: boolean;
  readonly weatherText: string;
  readonly tempC: number | null;
  readonly clothingHint: string;
  readonly feel: string;
  readonly dish: string;
  readonly doing: string;
  readonly castOn: boolean;
  readonly cast: string;
  readonly personRefActive: boolean;
  readonly libraryHint: string;
  readonly companion: string;
  readonly visualCue: string;
  readonly skySummary: string;
  readonly style: string;
  readonly lang: 'en' | 'zh';
  /** 给事件正文 / `journey_now` 看的紧凑一行硬事实（不带示范句，防复读）。 */
  readonly summaryLine: string;
  /** 给 `nowSummary` 末尾挂的极短实时拍摄实况（控制篇幅）。 */
  readonly nowTag: string;
}

/** 按当地实时气温给出明确穿衣温区，避免冬天穿短袖或盛夏穿羽绒服。 */
export function clothingForTemp(tempC: number | null): string {
  if (tempC === null || !Number.isFinite(tempC)) return '';
  const t = Math.round(tempC);
  if (t <= 2) return `严寒 ${t}℃，穿厚羽绒服/厚棉服、保暖内搭与围巾`;
  if (t <= 10) return `偏冷 ${t}℃，穿秋冬厚外套/大衣或毛衣，勿穿短袖夏装`;
  if (t <= 17) return `微凉 ${t}℃，穿长袖外套/风衣或针织衫`;
  if (t <= 24) return `舒适 ${t}℃，穿长袖衬衫/薄外套或轻便休闲装`;
  return `暖热 ${t}℃，穿短袖等清凉夏装`;
}

/** 根据日期、城市、太阳高度角、气象与旅途上下文构建不可违背的拍照硬事实包。 */
export function buildPhotoFacts(input: PhotoFactsInput): PhotoFacts {
  const sky = input.view === 'sky' || input.subject === 'sky';
  const subject: PhotoSubject = sky ? 'sky' : (input.subject ?? 'ground');
  const onRoad = Boolean(input.onRoad);
  const spot = onRoad ? '' : String(input.spot ?? '').trim();
  const mode = String(input.mode ?? '').trim();
  const lang: 'en' | 'zh' = input.lang === 'zh' ? 'zh' : 'en';
  const style = String(input.style ?? '').trim();

  const h = ((input.hour % 24) + 24) % 24;
  const daylit = daylitAt(input.city.lat ?? 0, input.month, h, input.city.lon, input.city.tz, input.day);
  const sun = sceneSun({
    city: input.city.name,
    cityId: input.city.id,
    spot: spot || undefined,
    onRoad,
    mode,
    hour: h,
    month: input.month,
    day: input.day,
    weather: input.weather
      ? (phaseWeather(input.weather, daylit) || input.weather.dayWeather)
      : (input.weatherText ?? ''),
    view: sky ? 'sky' : 'ground',
    subject,
  });

  const nightShot = shotIsNight({
    repaint: false,
    lat: input.city.lat ?? 0,
    month: input.month,
    hour: h,
    day: input.day,
    lon: input.city.lon,
    tz: input.city.tz,
  });

  const spotOwn = sky || onRoad ? '' : spotLook(input.city.id, spot);
  const indoor = Boolean(spot)
    && !onRoad
    && !sky
    && subject === 'ground'
    && !spotOwn
    && spotProfile(spot).indoor;

  const spotSetting = spot ? spotProfile(spot).setting : '';
  const spotUrban = spot
    ? (spotSetting === 'urban' ? true : spotSetting === 'wild' ? false : null)
    : true;
  const urban = !sky && !onRoad && !indoor && spotUrban === true;

  const phaseLabel = minimalLightPart(h, sun);
  const daylightGuard = sun.whiteNight
    ? '高纬白夜，天未全黑'
    : sun.phase === 'noon' || sun.phase === 'day' || sun.phase === 'slant'
      ? (phaseLabel.includes('大白天')
        ? `${phaseLabel}（非黄昏、非夜景，不亮路灯）`
        : `${phaseLabel}（大白天，非黄昏、非夜景，不亮路灯）`)
      : sun.phase === 'low'
        ? `${phaseLabel}（尚未日落）`
        : sun.phase === 'golden'
          ? `${phaseLabel}（太阳贴近地平线）`
          : `${phaseLabel}（太阳已落，非白天）`;
  const lightNote = sun.whiteNight
    ? '高纬白夜'
    : sun.phase === 'noon' || sun.phase === 'day' || sun.phase === 'slant'
      ? (sun.overcast ? '白天阴天' : '大白天阳光充足')
      : sun.phase === 'low'
        ? (h < 12 ? (sun.overcast ? '清晨天色微亮' : '清晨低斜阳光') : (sun.overcast ? '傍晚前天光' : '午后斜阳'))
        : sun.phase === 'golden'
          ? (h < 12 ? (sun.overcast ? '破晓天光' : '日出晨光') : (sun.overcast ? '日落天光' : '日落夕阳'))
          : phaseLabel;

  const w = input.weather ?? null;
  const tempRaw = w ? (sun.daylit ? w.dayTemp : w.nightTemp) : null;
  const tempC = typeof tempRaw === 'number' && Number.isFinite(tempRaw) ? tempRaw : null;
  const weatherText = (w ? phaseWeather(w, sun.daylit) : String(input.weatherText ?? '')).trim();
  const clothingHint = indoor ? '' : clothingForTemp(tempC);
  const feel = onRoad ? '' : String(input.feel ?? '').trim();

  const rawDoing = cleanDoing(input.doing);
  const doing = rawDoing && !isBareSpotDoing(rawDoing, input.city.name, spot) ? rawDoing : '';

  const routeTag = onRoadRoutePhrase(input.city.name, input.destCity);
  const placeLabel = sky
    ? `${input.city.name}上空（抬头看天）`
    : onRoad
      ? (/观光专列|冰川快车|东方快车|房车|内河|河轮|峡谷游轮/.test(mode)
        ? onRoadScenePhrase(mode, input.city.name, nightShot, input.destCity)
        : `${onRoadViewPhrase(mode)}（${routeTag}）`)
      : spot
        ? (spot.startsWith(input.city.name) ? spot : `${input.city.name}·${spot}`)
        : input.city.name;

  const visualCue = sky || onRoad
    ? ''
    : (spotOwn || (spot ? spotProfile(spot).form : '') || vistaOf(input.city.id, input.month, spot))
      .replace(/，?天空常罩一层灰白云/g, '')
      .replace(/，?天常常是灰的/g, '')
      .trim();

  const skySummary = sky
    ? skyOf(h, weatherText, input.city.lat ?? 0, input.month, input.city.lon, input.city.tz, !onRoad && spotUrban === true, input.day).told
    : '';

  const castOn = Boolean(input.castOn);
  const personRefActive = Boolean(castOn && input.personRefActive);
  const cast = castOn && !personRefActive ? String(input.cast ?? '').trim() : '';
  const libraryHint = String(input.libraryHint ?? '').trim();
  const dish = subject === 'food' ? String(input.dish ?? '').trim() : '';
  const companion = String(input.companion ?? '').trim();

  const dateLabel = `${input.month}月${input.day}日 ${fmtHour(h)}`;
  const envTag = sky ? '天空' : onRoad ? '在途车窗外' : indoor ? '室内' : '室外';
  const placeWithEnv = onRoad ? placeLabel : `${placeLabel}（${envTag}）`;
  const tempTag = tempC !== null ? `${Math.round(tempC)}℃` : '';
  const weatherBrief = weatherText
    ? (tempTag ? `${weatherText} ${tempTag}` : weatherText)
    : tempTag;
  const wearBrief = clothingHint ? clothingHint.split('，')[0] : '';
  const moodOrWeather = weatherBrief
    ? (wearBrief ? `${weatherBrief}（${wearBrief}）` : weatherBrief)
    : (feel && !/不冷不热|没什么特别/.test(feel) ? feel : '');
  const personBrief = personRefActive
    ? '带参考图出镜'
    : castOn
      ? (cast ? `角色出镜（${cast}）` : '角色出镜')
      : '默认空镜';
  const sceneExtra = [
    dish ? `吃着${dish}` : '',
    doing ? doing : '',
    companion ? `同行的有${companion}` : '',
  ].filter(Boolean).join('，');

  const summaryLine = [
    placeWithEnv,
    `${dateLabel}，${lightNote}`,
    moodOrWeather,
    sceneExtra,
    personBrief,
  ].filter(Boolean).join('，');

  const nowTag = [
    `此刻留影参考：${placeWithEnv}`,
    `${fmtHour(h)} ${lightNote}`,
    weatherBrief ? (wearBrief ? `${weatherBrief}（${wearBrief}）` : weatherBrief) : '',
    personRefActive ? '已开参考图出镜' : castOn ? '角色出镜' : '默认空镜',
  ].filter(Boolean).join('，') + '。';

  return {
    city: input.city.name,
    spot,
    onRoad,
    mode,
    sky,
    subject,
    dateLabel,
    placeLabel,
    indoor,
    urban,
    sun,
    phaseLabel,
    daylightGuard,
    nightShot,
    weatherText,
    tempC,
    clothingHint,
    feel,
    dish,
    doing,
    castOn,
    cast,
    personRefActive,
    libraryHint,
    companion,
    visualCue,
    skySummary,
    style,
    lang,
    summaryLine,
    nowTag,
  };
}

function phaseWeather(w: Forecast, isDaylit: boolean): string {
  return (isDaylit ? w.dayWeather : w.nightWeather) || w.dayWeather || w.nightWeather || '';
}

/** 构造投给 `WorldHost.cognition.request()` 的后台摄影导演简报（方案 B）。 */
export function buildCognitionPromptBrief(facts: PhotoFacts, fallbackHint = ''): string {
  const lines = [
    '你正在协助生成一个旅行照片的生图提示词。严格遵守以下客观事实与约束，不要编造未出现的景物、错误季节或错误光线：',
    `- 地点与景别：${facts.placeLabel}（${facts.sky ? '抬头拍天' : facts.onRoad ? '赶路途中的窗外/车内视角' : facts.indoor ? '室内场景，看不到天空与外街' : '室外场景'}，题材=${facts.subject}）`,
    `- 时刻与自然光：${facts.dateLabel}，太阳高度 ${Math.round(facts.sun.alt)}°，实况为「${facts.daylightGuard}」`,
  ];
  if (facts.skySummary) lines.push(`- 头顶实况天空：${facts.skySummary}`);
  if (facts.weatherText || facts.tempC !== null) {
    lines.push(`- 实时天气与温度：${[facts.weatherText, facts.tempC !== null ? `${Math.round(facts.tempC)}℃` : ''].filter(Boolean).join('，')}`);
  }
  if (facts.clothingHint && facts.castOn) {
    lines.push(`- 气温着装要求：${facts.clothingHint}`);
  }
  if (!facts.weatherText && facts.feel && !/不冷不热|没什么特别/.test(facts.feel)) {
    lines.push(`- 当地体感参考（无降水时勿臆造下雪）：${facts.feel}`);
  }
  if (facts.visualCue) lines.push(`- 地貌/建筑外观参考：${facts.visualCue}`);
  if (facts.dish) lines.push(`- 本餐菜品：${facts.dish}`);
  if (facts.doing) lines.push(`- 正在做的事：${facts.doing}`);
  if (facts.companion) lines.push(`- 在场同伴：${facts.companion}（未列出的其他人不许出现）`);
  if (facts.personRefActive) {
    lines.push('- 人物与参考图：已附人物参考图，不要在文字中重写发色、脸型或五官，只需重点写清符合上述气温的衣服穿搭、自然动作神态与画面站位。画面只保留这一位主角。');
  } else if (facts.castOn) {
    lines.push(`- 人物出镜：画面包含主角（${facts.cast || '依人设'}），穿着符合气温，画面只突出这一位主角，不要杂乱路人。`);
  } else {
    lines.push('- 人物出镜：默认空镜视角，不画正面主角特写；若为开放景点/街区仅可极远点缀微小虚化行人。');
  }
  if (facts.libraryHint) lines.push(`- 图鉴补充细节：${facts.libraryHint}`);
  if (facts.style && facts.style.toLowerCase() !== 'none') {
    lines.push(`- 用户指定画风偏好：${facts.style}`);
  } else if (facts.style.toLowerCase() === 'none') {
    lines.push('- 画风要求：不添加摄影风格或胶片滤镜词汇，直接描述画面内容。');
  }
  if (fallbackHint.trim()) {
    lines.push(`- 兜底基线参考（可吸收其中准确地名，去掉死板模板感）：${fallbackHint.trim().slice(0, 140)}`);
  }
  lines.push(
    facts.lang === 'zh'
      ? '输出要求：直接用中文写出 1 段自然流畅的生图提示词（80~180字，禁止出现可读文字/水印），不要输出解释、标题、序号或引号。'
      : 'Output requirement: Write ONE concise, vivid image generation prompt in English (45-95 words, no readable text, no watermark). Output ONLY the prompt itself without quotes, headings, or explanations.',
  );
  return lines.join('\n');
}

/** 清洗后台 cognition / 主循环生成的提示词文本。 */
export function sanitizeDirectorText(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 去掉围栏代码块或首尾成对引号
  s = s.replace(/^```[\w-]*\s*|\s*```$/g, '').trim();
  s = s.replace(/^(?:prompt|提示词|生图提示词)\s*[:：]\s*/i, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, ' ').trim();
  // 拒绝明显无效/拒答/报错文本，使其回退到模板兜底
  if (s.length < 6) return '';
  if (/^(?:sorry|i cannot|i'm unable|无法|抱歉|对不起|错误|error)/i.test(s)) return '';
  if (s.length > 360) {
    const cut = s.slice(0, 360);
    const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('.'), cut.lastIndexOf('，'), cut.lastIndexOf(','));
    s = (stop >= 120 ? cut.slice(0, stop + 1) : cut).trim();
  }
  return s;
}

/**
 * 把主会话/后台 cognition 写好的画面提示词编译成最终生图请求词。
 * 保留最小技术护栏（画风前缀、参考图不打架约束、去字去水印），绝不叠加 3415 行规则模板。
 */
export function compileDirectorPrompt(authoredRaw: string, facts: PhotoFacts): string {
  const body = sanitizeDirectorText(authoredRaw);
  if (!body) return '';

  const isZhBody = /[\u4e00-\u9fa5]/.test(body);
  const style = facts.style.trim();
  const bareStyle = style.toLowerCase() === 'none';

  let out = body;
  if (style && !bareStyle) {
    const styleHead = style.split(/[，,、\s]/)[0] ?? style;
    if (styleHead && !out.toLowerCase().includes(styleHead.toLowerCase())) {
      out = isZhBody ? `${style}：${out}` : `${style}, ${out}`;
    }
  }

  const guards: string[] = [];
  if (facts.personRefActive) {
    const hasRefWord = /参考图|reference/i.test(out);
    if (!hasRefWord) {
      guards.push(
        isZhBody
          ? '人物脸型、五官与发型以参考图为准'
          : 'keep character face and hairstyle consistent with reference image',
      );
    }
  } else if (facts.castOn && facts.cast) {
    const castHead = facts.cast.split(/[，,、\s]/)[0] ?? '';
    if (castHead && !out.includes(castHead)) {
      guards.push(isZhBody ? `出镜人物：${facts.cast}` : facts.cast);
    }
  }

  const hasTextGuard = isZhBody
    ? /(?:没有|无|不要|不出现|禁止).{0,6}(?:文字|水印)/.test(out)
    : /\bno\s+(?:readable\s+)?text\b|\bno\s+watermarks?\b/i.test(out);
  if (!hasTextGuard) {
    guards.push(isZhBody ? '没有可读文字，没有水印' : 'no readable text, no watermark');
  }

  const isBrightDay = !facts.sun.whiteNight
    && (facts.sun.phase === 'noon' || facts.sun.phase === 'day' || facts.sun.phase === 'slant');
  if (isBrightDay) {
    const hasDayGuard = isZhBody
      ? /大白天|路灯未亮|不开暖灯|白昼/.test(out)
      : /\b(?:midday daylight|daytime sky|streetlights off)\b/i.test(out);
    if (!hasDayGuard) {
      guards.push(
        isZhBody
          ? (facts.sun.overcast ? '大白天明亮自然天光，白昼天色、路灯未亮' : '大白天明亮中性日光，白昼清亮天空、路灯未亮')
          : (facts.sun.overcast ? 'bright overcast daytime natural light, daytime sky, streetlights off' : 'bright neutral midday daylight, clear daytime sky, streetlights off'),
      );
    }
  }

  if (!guards.length) return out;
  const sep = isZhBody
    ? (/[。！？]$/.test(out) ? '' : '。')
    : (/[.,!]$/.test(out) ? ' ' : ', ');
  const end = isZhBody ? '。' : '.';
  return `${out}${sep}${guards.join(isZhBody ? '，' : ', ')}${end}`;
}
