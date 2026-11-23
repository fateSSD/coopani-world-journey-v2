/**
 * 生图后端：把「云端 / 本地」这一件事收成一个开关。
 *
 * ## 为什么要这一层（2026-11-14，Mr.Q 的原话）
 *
 * > 「最好一个选项点进去 UI 是云端，一个选项点进去 UI 切本地。」
 *
 * 原来要接一个云端服务商，得自己找接口地址、自己查模型 ID、自己猜尺寸 ——
 * 三样里任何一样填错，表现都是「拍不出来」，而不是「填错了」。
 * 豆包更麻烦：它的图片模型有**最低像素**，填小了直接被 400。
 *
 * 所以把「不得不填的那三项」预先写好，用户只需要选一个后端、贴一把密钥。
 *
 * ## 这一层**不做**什么
 *
 * 不接管用户已经手填的值。规则只有一条：**用户填了就以用户为准**，
 * 没填才用预设补。这样既能一键上手，也不挡住要微调的人。
 */

/**
 * 后端协议。
 *
 * - `openai`：云端 OpenAI 兼容的 `POST {base}/images/generations`
 * - `qwen`：云端千问 / 百炼的 `POST {base}/api/v1/services/aigc/multimodal-generation/generation`
 * - `comfyui`：本地 ComfyUI 的 `/prompt`
 *
 * **`qwen` 不是用户直接选的一项。** 配置里的 `imageProtocol` 仍然只有
 * 「云端 / 本地」两档（`openai` / `comfyui`），千问是「云端」下面的一个
 * **服务商**（`imagePreset: 'qwen'`）；这里多一个协议值，是因为请求的
 * 路径、请求体、返回三样都和 OpenAI 那条不一样，`shootPhoto` 得知道走哪支。
 *
 * 为什么不让用户在 `imageProtocol` 里选三项：那个下拉的语义是「图从哪来」
 * （云端 / 本地），换一家云端服务商不该动这一层，否则用户在两个下拉之间
 * 来回试的时候，「本地 + 千问」这种自相矛盾的组合会真的被保存下来。
 */
export type ImageProtocol = 'openai' | 'qwen' | 'comfyui';

/** 云端服务商预设。`custom` = 自己填地址和模型。 */
export type ImagePreset = 'doubao' | 'openai' | 'qwen' | 'custom';

export interface ImageBackend {
  readonly protocol: ImageProtocol;
  readonly api: string;
  readonly model: string;
  readonly size: string;
  /**
   * 一句话说明「这次实际连的是哪儿」。
   *
   * 给日志和面板用：配置错了的时候，用户看到的第一句话应该是
   * 「你连的是 X」，而不是自己回头翻六个字段猜。
   */
  readonly note: string;
  /** 尺寸被抬到合规值时的说明；没动就是空串。 */
  readonly sizeNote: string;
}

interface Preset {
  readonly label: string;
  readonly api: string;
  readonly model: string;
  /** 没填尺寸时用它。已经按合规挑过，不是随手写的数。 */
  readonly size: string;
  /**
   * 这个模型能接受的最小像素数。0 = 没有这个限制。
   *
   * **豆包那条是真坑**：方舟的 seedream 5.0 / 4.5 最低 3,686,400 像素
   * （2560×1440），而我们默认发的是 1664×928（154 万）—— 差一半还多，必定 400。
   * 这个数字来自第三方整理页（ofox、腾讯云镜像、BytePlus 概览），
   * 官方「填写说明」是动态渲染，抓不到表格。所以这里按合规值兜底：
   * 万一官方门槛更低，抬上去也只是一张更大的图，不会失败。
   */
  readonly minPixels: number;
}

const PRESETS: Readonly<Record<Exclude<ImagePreset, 'custom'>, Preset>> = {
  doubao: {
    label: '豆包 Seedream（火山方舟）',
    api: 'https://ark.cn-beijing.volces.com/api/v3',
    /*
     * `doubao-seedream-5-0-260128` 是 5.0 标准（与 5.0 lite 同一个模型的两个名字）。
     * 想要更高分辨率或图层拆分再换 `-5-0-pro-260628`。
     */
    model: 'doubao-seedream-5-0-260128',
    size: '2048x2048',
    minPixels: 3_686_400,
  },
  openai: {
    label: 'OpenAI',
    api: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    size: '1024x1024',
    minPixels: 0,
  },
  /*
   * 千问（2026-11-23，GitHub Discussion #586 的 lyb-ai 问的）。
   *
   * **地址这一栏的语义和别家不一样，要在面板上说清**：千问的接口是
   * `{base}/api/v1/services/aigc/multimodal-generation/generation`，
   * 而 `base` 只到域名。所以这里填的是**纯域名**，不是 `/v1`。
   *
   * - 百炼（按量计费）：`https://dashscope.aliyuncs.com`
   * - Token Plan：`https://token-plan.maas.qianwenaiapi.com`
   *
   * 两家的 `model` 名字一样，换套餐只需要改地址这一栏。
   *
   * 尺寸：`宽*高`（星号），总像素 512×512 – 2048×2048。默认给 1024×1024 ——
   * 手机竖拍的 3:4 / 16:9 让用户自己在「出图尺寸」里改成 `1152x864` 这种，
   * 只要落在那个区间内就行，不必替他把比例定死。
   */
  qwen: {
    label: '千问 Qwen-Image（百炼 / Token Plan）',
    api: 'https://dashscope.aliyuncs.com',
    model: 'qwen-image-3.0-pro',
    size: '1024x1024',
    minPixels: 0,
  },
};

/**
 * 地址归一：去空白、转小写、去尾部斜杠。
 *
 * 只用于「这两个地址是不是同一个」这类比较，不用于发请求 —— 大小写和尾斜杠
 * 在路径里是有意义的，`shootPhoto` 自己会处理。
 */
function normEndpoint(v: string | undefined): string {
  return (v ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

/** 千问已知官方域名（百炼国内/国际 + Token Plan 国内/国际）。 */
const QWEN_OFFICIAL_APIS: readonly string[] = [
  'https://dashscope.aliyuncs.com',
  'https://token-plan.maas.qianwenaiapi.com',
  'https://dashscope-intl.aliyuncs.com',
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com',
];

/** 预设自带的地址 / 模型名，用来认「这个值是常量，不是他手填的」。 */
const PRESET_APIS: readonly string[] = Array.from(new Set([
  ...Object.values(PRESETS).map((p) => normEndpoint(p.api)),
  ...QWEN_OFFICIAL_APIS.map((u) => normEndpoint(u)),
]));
const PRESET_MODELS: readonly string[] = Object.values(PRESETS).map((p) => normEndpoint(p.model));

/**
 * 这个值是不是**别家预设**的常量。
 *
 * ## 为什么要有这一条（2026-11-23，Mr.Q 拍板）
 *
 * 「手填永远优先」这条规则本身是对的，但它把一件不该算「手填」的东西算成了手填：
 * **上一次选别的服务商时，预设替他写进配置里的那个地址**。
 *
 * 后果很具体：从豆包切到千问，`imageApi` 还是 `ark.cn-beijing.volces.com/api/v3`，
 * 而协议已经换成千问 —— 拼出来是 `ark…/api/v1/services/aigc/…`，404。
 * 用户看到的是「拍不出来」，配置里每一栏却都「有值」。
 *
 * 判据收窄成一条：**只有和某个预设的常量一模一样，才算「别家的」。**
 * 自己的中转地址（`https://my-proxy.example.com/v1`）永远认不出，永远保留 ——
 * 那条是真手填，覆盖它才是真的接管用户配置。
 */
function isForeignPresetValue(
  value: string,
  mine: string | readonly string[] | undefined,
  table: readonly string[],
): boolean {
  const v = normEndpoint(value);
  if (!v) return false;
  const ownList = Array.isArray(mine) ? mine : (mine ? [mine] : []);
  if (ownList.some((x) => normEndpoint(x) === v)) return false; // 就是这一档自己的值，照用
  return table.includes(v);
}

/** 从地址里取主机名，只给日志/自检用。取不出就原样返回。 */
function hostOf(api: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(api.trim());
  return m ? m[1]!.toLowerCase() : api.trim();
}

/** 给配置面板和日志用：预设的中文名。 */
export function presetLabel(preset: string | undefined): string {
  if (preset === 'doubao' || preset === 'openai' || preset === 'qwen') return PRESETS[preset].label;
  return '自定义';
}

/**
 * 给设置面板用：这个预设会填什么；`custom` 或认不出返回 null。
 *
 * 预设的价值不在「少填几个字」，在**知道最终会连到哪儿**。所以面板要把
 * 地址、模型、尺寸三个都拿到，当 placeholder 显示出来 —— 用户不填也能看见
 * 「点了保存以后实际会用 https://ark… 和 doubao-seedream…」。
 */
export function presetDefaults(preset: string): {
  api: string;
  model: string;
  size: string;
  minPixels: number;
} | null {
  const raw = (preset ?? '').trim();
  if (raw !== 'doubao' && raw !== 'openai' && raw !== 'qwen') return null;
  const p = PRESETS[raw];
  return { api: p.api, model: p.model, size: p.size, minPixels: p.minPixels };
}

/** 从 `宽x高` 里取像素数；认不出返回 0。 */
function pixelsOf(size: string): number {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim());
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

/**
 * 把尺寸按比例抬到这个模型的最低像素以上，宽高都吸附到 8 的倍数。
 *
 * 只放大不缩小：用户要的是「至少能出图」，不是「帮我换一个尺寸」。
 * 比例保持原样 —— 换了比例就成另一张构图了。
 */
export function liftToMinPixels(size: string, minPixels: number): { size: string; lifted: boolean } {
  if (!minPixels) return { size, lifted: false };
  const px = pixelsOf(size);
  if (!px || px >= minPixels) return { size, lifted: false };
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim());
  if (!m) return { size, lifted: false };
  const scale = Math.sqrt(minPixels / px);
  const w = Math.ceil((Number(m[1]) * scale) / 8) * 8;
  const h = Math.ceil((Number(m[2]) * scale) / 8) * 8;
  return { size: `${w}x${h}`, lifted: true };
}

/**
 * 配置 → 实际要用的后端。
 *
 * 判定顺序有意如此：**先看 `imageProtocol`**。
 * 它是「后端」本身（云端 / 本地），`imagePreset` 只是云端内部的分支 ——
 * 如果先看预设，一个选了「豆包」但后端写着 comfyui 的配置会自相矛盾地走云端。
 */
export function resolveImageBackend(cfg: {
  readonly imageProtocol?: string;
  readonly imagePreset?: string;
  readonly imageApi?: string;
  readonly imageModel?: string;
  readonly imageSize?: string;
  readonly imageWorkflow?: string;
}, sizeOverride?: string): ImageBackend {
  const raw = (cfg.imageProtocol ?? '').trim();
  const isComfy = /^comfy/i.test(raw);

  if (isComfy) {
    const api = (cfg.imageApi ?? '').trim() || 'http://127.0.0.1:8188';
    const wf = (cfg.imageWorkflow ?? '').trim();
    return {
      protocol: 'comfyui',
      api,
      // ComfyUI 的模型写在 workflow 里，这里留空不是缺项。
      model: '',
      size: (cfg.imageSize ?? '').trim(),
      note: wf
        ? `本地 ComfyUI（${api}，workflow：${wf.split(/[\\/]/).pop() ?? wf}）`
        : `本地 ComfyUI（${api}）—— 还没选 workflow，选一个 .json 才能出图`,
      sizeNote: '',
    };
  }

  const presetName = (cfg.imagePreset ?? '').trim() as ImagePreset;
  const preset = presetName === 'doubao' || presetName === 'openai' || presetName === 'qwen'
    ? PRESETS[presetName]
    : null;
  const typedApi = (cfg.imageApi ?? '').trim();
  const typedModel = (cfg.imageModel ?? '').trim();
  /*
   * 千问的那一支（2026-11-23）。
   *
   * 判据主路看「预设」，**不看域名**（避免把 `/compatible-mode/v1` 误判成千问）；
   * 但若用户在「自定义」里明确粘了完整端点 `/services/aigc/multimodal-generation/generation`，
   * 那是 DashScope 多模态生成专有路径，不可能是 OpenAI `/images/generations`，直接认作千问协议。
   */
  const isQwen = presetName === 'qwen'
    || (presetName === 'custom' && /\/services\/aigc\/multimodal-generation\/generation\/?$/i.test(typedApi));

  /*
   * 手填优先 —— 但**别家预设写进去的旧值不算手填**（2026-11-23）。
   * 判据见 `isForeignPresetValue`：只认「和某个预设的常量一模一样」这一种，
   * 自己的中转地址一律保留。
   */
  const ownApis = presetName === 'qwen' ? QWEN_OFFICIAL_APIS : preset?.api;
  const staleApi = !!preset && isForeignPresetValue(typedApi, ownApis, PRESET_APIS);
  const staleModel = !!preset && isForeignPresetValue(typedModel, preset.model, PRESET_MODELS);

  const api = (staleApi ? '' : typedApi) || preset?.api || '';
  const model = (staleModel ? '' : typedModel) || preset?.model || '';
  /*
   * `sizeOverride` 给「月报封面」那条路用：海报有自己的固定比例（1024x1536），
   * 不该被「出图尺寸」那一栏改掉，但仍要过最低像素这一关。
   */
  const wantSize = (sizeOverride ?? '').trim() || (cfg.imageSize ?? '').trim() || preset?.size || '';

  const fixed = wantSize && preset ? liftToMinPixels(wantSize, preset.minPixels) : { size: wantSize, lifted: false };

  const who = preset ? preset.label : '自定义云端服务';
  /*
   * 旧值被忽略这件事要说出来。它不报错、不弹窗，只是「连的地方和你以为的不一样」——
   * 不说的话，用户在自检里看到 `https://dashscope…` 会以为配置被改了。
   */
  const staleNote = staleApi || staleModel
    ? ` · 配置里还留着别家的${staleApi ? `地址（${hostOf(typedApi)}）` : '模型名'}，已按「${who}」自己的走`
    : '';
  const note = api
    ? `云端 · ${who}（${api}${model ? `，模型 ${model}` : '，模型没填'}）${staleNote}`
    : `云端 · ${who} —— 服务地址没填，拍不了`;

  return {
    protocol: isQwen ? 'qwen' : 'openai',
    api,
    model,
    size: fixed.size,
    note,
    sizeNote: fixed.lifted
      ? `尺寸 ${wantSize} 只有 ${pixelsOf(wantSize).toLocaleString('en-US')} 像素，`
        + `低于 ${preset?.label ?? '这个模型'} 的最低 ${(preset?.minPixels ?? 0).toLocaleString('en-US')}，`
        + `已按原比例抬到 ${fixed.size}。想自己定就在「出图尺寸」里填一个够大的。`
      : '',
  };
}

/** 根据后端预设推荐极简提示词与语言模式。 */
export function presetHints(preset?: string): { readonly minimal: boolean; readonly lang: 'zh' | 'en' } {
  const key = (preset ?? '').trim().toLowerCase();
  if (key === 'doubao') return { minimal: true, lang: 'zh' };
  /* Qwen-Image 是中文原生底模：写中文信息密度更高，英文反而丢细节。 */
  if (key === 'qwen') return { minimal: false, lang: 'zh' };
  return { minimal: false, lang: 'en' };
}
