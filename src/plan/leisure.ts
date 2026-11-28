/**
 * 到了地方之后，**除了走，还能干的事**。
 *
 * ## 为什么单开一个文件（2026-11-08 Mr.Q）
 *
 * 他列了三条：爬山得有缆车、人力轿、滑梯；晚上在好酒店能游泳、健身、做 SPA；
 * 南方好沙滩有香蕉艇、摩托艇、堆沙堡、潜水。
 *
 * 这三件事的共同点是**都不在「路上」，也不在「景点门票」里** ——
 * 它们是到了之后临时决定买的一项。原来只有一条 `pickSpotExtra` 管讲解和观光车，
 * 挂在 `dayplan.ts` 里，再加三类会让那个文件更难读。
 *
 * ## 两条硬规矩
 *
 * 1. **按「这地方是什么」给，不按价格给。** 平原城市的公园不该冒出索道，
 *    内陆城市不该有潜水 —— 那是把表格当骰子扔。
 * 2. **价格是查来的**（景区公示价 / 平台价区间），注释里写清出处，
 *    免得下次有人以为是随手填的数字。
 */

import type { City } from '../geo/cities.ts';
import type { LodgingTier } from './lodging.ts';

/** 一项「花钱省事/买乐子」的选择。`item` 进账，`text` 进日程。 */
/**
 * 景区里能怎么代步（2026-11-09）。
 *
 * ## 为什么要有这份表
 *
 * Mr.Q 实测：「景区里自行车我实测过，她说她找不到」；接着问
 * 「爬山、景区交通得能用啊，要不一天靠走路可以嘛」。
 *
 * 症结是这批项目**从来没有工具**：`pickSpotExtra` 只是在排程时往时间轴上
 * 写一句「坐索道上去的」，然后记一笔钱。用户说「你坐索道上去吧」，
 * 她手里没有任何能执行的动作 —— 只能说「我这儿没找着」。
 *
 * 这份表是**唯一的真相来源**：`pickSpotExtra` 自动挑的时候用它，
 * `journey_spot_ride` 工具让她自己挑的时候也用它。
 * 两处引用同一份，才不会出现「自动排程能坐、她想坐时不能坐」。
 *
 * ## 每一项的判据
 *
 * | 地方 | 能坐 | 价 |
 * |---|---|---|
 * | 山（含名山） | 索道 / 滑道；名山另有滑竿 | 140 / 50 / 260 |
 * | 山·峡·瀑·森林·湿地·草原 | 观光车 | 40 |
 * | 湖·公园·古镇·老街·街区·绿道 | 景区自行车 | 20 |
 * | 博物馆·遗址·石窟·寺·庙·陵·古城… | 讲解 | 30 |
 * | 任何地方 | 自己走 | 0 |
 *
 * **「自己走」永远在列表里**，而且排在最后 —— 它不是凑数：
 * 用户问「一天靠走路可以吗」，答案就该是「可以，但这座山走上去要两小时」。
 */
export interface RideOption {
  /** 工具参数值。 */
  readonly how: string;
  readonly label: string;
  readonly price: number;
  /** 具体那句话，`%s` 会换成地名。 */
  readonly text: string;
}

export interface SpotRideContext {
  readonly city?: Pick<City, 'id' | 'name' | 'tags' | 'country'>;
  readonly wet?: boolean;
}

export function spotRideOptions(spot: string, ctx?: SpotRideContext): readonly RideOption[] {
  const out: RideOption[] = [];
  /*
   * 「博物馆」和「博物院」是两个词 —— 2026-11-09 测试里栽在「四川博物院」上，
   * 一个都不是。同类还有美术馆、展览馆、纪念馆。
   */
  /*
   * 「有故事的地方」—— 这类地方**不听讲解等于白来**。
   *
   * 2026-11-12 Mr.Q：「莫高窟没讲解还行」。查下来不是概率问题，是这张表漏了词：
   * 原来写的是「石窟」，而**「莫高窟」这三个字里没有「石窟」**，压根匹配不上，
   * 所以它连「有讲解」这个选项都没进候选池。
   *
   * 同类漏网：兵马俑（「俑」）、长城、都江堰（「堰」）、十三陵之外的墓、
   * 各种祠。都是一眼该请讲解的地方。
   *
   * 补词时按「单个字足够特指」的原则收：窟、俑、堰、墓、祠 ——
   * 这几个字在景点名里几乎只出现在这类地方，不会误伤自然景观。
   * （「观」「阁」没收：观景台、湿地观鸟也会带「观」。）
   */
  const story = /博物馆|博物院|美术馆|展览馆|纪念馆|遗址|窟|寺|庙|陵|墓|祠|古城|故居|宫|塔|楼阁|俑|长城|堰/.test(spot);

  /*
   * ## 沙丘排在山前面（2026-11-12）
   *
   * Mr.Q：「敦煌鸣沙山，讲道理那不是山，是沙丘，没有缆车只有骆驼」。
   *
   * 它的名字里带「山」，所以一直在走 `MOUNTAIN` 那一支 —— 给她排了
   * **140 元的索道和 50 元的下山滑道**，而鸣沙山根本没有缆车。
   * 沙山上只有骆驼，和一块滑沙板。
   *
   * 这一类错**不会报错，只是让她说了假话**：日记里写「坐索道上去的，
   * 缆车在钢索上轻轻晃」，而那个地方从来没有过索道。
   *
   * 判据：**名字里的地形词不可信**。沙丘、沙漠、戈壁的「山/坡/梁」都不是石头山。
   */
  const dune = DUNE.test(spot);
  if (dune) {
    out.push({
      how: 'camel',
      label: '骆驼',
      price: 120,
      text: '牵了峰骆驼缓步上沙坡，驼铃一路轻响，回头看脚印歪歪扭扭拖了一长串',
    });
    out.push({
      how: 'slide',
      label: '滑沙',
      price: 30,
      text: '借了块滑沙板顺着沙脊滑下来，耳边全是风声，溅起一阵细沙',
    });
  } else if (MOUNTAIN.test(spot)) {
    out.push({
      how: 'cableway',
      label: '索道',
      price: 140,
      text: '坐索道缓缓上山，缆车在钢索上轻晃，脚下的山林铺成一片深绿',
    });
    if (SEDAN_CHAIR.test(spot)) {
      out.push({
        how: 'sedan',
        label: '滑竿',
        price: 150,
        text: '坐了一段滑竿，两位师傅前后步调极稳，上陡坡比走路还平顺',
      });
    }
    out.push({
      how: 'slide',
      label: '滑道',
      price: 50,
      text: '下山坐了滑道，顺着铁槽一路拐弯冲下去，前头笑声和惊呼不断',
    });
  } else if (/山|峰|峡|瀑|森林|湿地|草原|大峡谷/.test(spot)) {
    out.push({
      how: 'shuttle',
      label: '观光车',
      price: 40,
      text: '坐了景区观光车，省下两三公里的盘山上坡',
    });
  }

  if (!dune && (HIGH_ALT_MOUNTAIN.test(spot) || (MOUNTAIN.test(spot) && Boolean(ctx?.city) && /雪山|冰川|高原|阿尔卑斯|少女峰/.test(ctx!.city!.tags.join(','))))) {
    out.push({
      how: 'cabrio-cableway',
      label: '敞篷双层缆车',
      price: 120,
      text: '踏上敞篷双层缆车的二层露天观景甲板，清冽山风迎面拂过，脚下云海与山脊缓缓铺开',
    });
  }

  if (!dune && MOUNTAIN_TRAIN_SPOT.test(spot)) {
    out.push({
      how: 'mountain-train',
      label: '登山齿轨小火车',
      price: 80,
      text: '坐进登山齿轨小火车的木窗车厢，伴着轮轨咔嗒声慢悠悠穿过林海与弯道往山上爬升',
    });
  }

  if (
    !ctx?.wet &&
    (/热气球/.test(spot) ||
      (!BALLOON_EXCLUDE_SPOT.test(spot) &&
        (BALLOON_SPOT.test(spot) || (!dune && Boolean(ctx?.city) && BALLOON_CITY_TAGS.test(ctx!.city!.tags.join(','))))))
  ) {
    out.push({
      how: 'balloon',
      label: '高空热气球',
      price: 180,
      text: '乘着高空热气球随风缓缓升空，俯瞰脚下的%s与远处天际，整片地貌一下子铺展在眼前',
    });
  }

  if (/湖|公园|古镇|老街|街区|绿道|堤/.test(spot)) {
    out.push({
      how: 'bike',
      label: '景区自行车',
      price: 20,
      text: '在景区门口扫了辆自行车，沿着%s慢慢骑了一圈',
    });
  }

  if (story) {
    out.push({
      how: 'guide',
      label: '讲解',
      price: 30,
      text: '在%s门口请了位讲解，一路听下来，比牌子上的简介鲜活得多',
    });
  }

  out.push({ how: 'walk', label: '自己走', price: 0, text: '这一段没乘代步工具，一步一步走上去的，登顶时腿微微发沉' });
  return out;
}

export interface Leisure {
  readonly item: string;
  readonly text: string;
  readonly price: number;
}

/** 稳定哈希（FNV-1a）。同一城市同一天同一景点，重算结果不变。 */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/*
 * 有石阶、有滑竿在拉活的那几座名山（2026-11-08 查的：泰山、华山、峨眉山、
 * 黄山、衡山、嵩山、三清山、武当山、梵净山的步道上都常年有滑竿）。
 * **不是「所有山都有人力轿」** —— 城郊的森林公园没人抬。
 */
const SEDAN_CHAIR =
  /泰山|华山|峨眉|黄山|衡山|嵩山|三清山|武当山|梵净山|庐山|井冈山|崂山|普陀山|九华山|五台山|青城山/;

/** 山上/峡谷里那种要爬的景点。 */
const MOUNTAIN = /山|峰|雪山|峡谷|石柱|崖|天梯|栈道|索道/;
/**
 * 沙丘、沙漠、戈壁 —— **名字里有「山」但全是沙**。
 *
 * 「鸣沙山」「沙坡头」这类地方走 MOUNTAIN 那支会被配上缆车和下山滑道，
 * 而它们只有骆驼。判断必须排在山前面。
 *
 * 「沙」单字不收：长沙、沙面、沙坪坝都是地名，跟地貌无关。
 */
const DUNE = /沙丘|沙漠|鸣沙|沙山|沙坡头|戈壁|雅丹/;
const HIGH_ALT_MOUNTAIN = /雪山|冰川|高山|玉龙|梅里|哈巴|四姑娘|贡嘎|天山|长白山|少女峰|铁力士|石丹峰|阿尔卑斯|富士山|乞力马扎罗|帕米尔|哈德昆/;
const MOUNTAIN_TRAIN_SPOT = /森林|古道|高山|樱花|铁路|小火车|阿里山|少女峰|长白山|神农架|武夷山|庐山|张家界|箱根|岚山|铁力士|因特拉肯/;
const BALLOON_SPOT = /喀斯特|峰林|火山|草原|丹霞|雅丹|地貌|阳朔|漓江|象鼻山|遇龙河|腾冲|热气球|卡帕多奇亚|格雷梅|蒲甘|纳帕/;
const BALLOON_CITY_TAGS = /喀斯特|峰林|草原|丹霞|雅丹|漓江/;
const BALLOON_EXCLUDE_SPOT = /博物馆|博物院|美术馆|展览馆|纪念馆|寺|庙|祠|巷|街|夜市|广场|大厦|书店|商城|商场|市场|故居|公园|溶洞|岩洞|芦笛岩|银子岩|石窟|洞|塔|港|海滩|沙滩|湾|城堡|古城|老城|大桥|桥|码头|机场|站|墓|陵|召|王府|大围|滑雪场|岩画/;

/**
 * 景点里额外花的那一笔（2026-11-06 起，2026-11-08 扩到五类）。
 *
 * | 什么样的地方 | 花什么 | 价 |
 * |---|---|---|
 * | 有故事的（博物馆/遗址/石窟/寺/陵/古城） | 讲解 | 30 |
 * | 要爬的（山/峰/峡谷），且名山 | 索道 / 缆车 | 80 单程，140 往还 |
 * | 名山石阶（泰山/华山/峨眉…） | 滑竿（人力轿） | 260 |
 * | 下山那一段 | 滑道 | 50 |
 * | 走不完的（山/峡/瀑/森林/湿地） | 观光车 | 40 |
 * | 路上好看的（湖/公园/古镇/老街） | 景区自行车 | 20 |
 *
 * ## 判据
 *
 * - **一天只买一项**：两个景点各买一次索道，读起来像旅游团报价单。
 * - **只有手头宽才买**（`comfortable`），紧的时候自己走。
 * - 顺序固定：先讲解（有故事的地方听一段比重复「好多佛像」有用），
 *   再山上的代步，再观光车，最后自行车。
 * - 索道/滑竿/滑道三者**按种子挑一个**，不是都买 —— 同一座山，这次坐索道上去，
 *   下次可能是坐了滑竿，重算要稳，所以用哈希不用随机数。
 */
export function pickSpotExtra(spot: string, seed: number, comfortable: boolean, ctx?: SpotRideContext): Leisure | null {
  if (!comfortable) return null;
  if (Math.abs(Math.round(seed)) % 100 >= 85) return null;

  const opts = spotRideOptions(spot, ctx).filter((o) => o.how !== 'walk');
  if (!opts.length) return null;

  /*
   * 顺序仍有讲究：**有故事的地方先给讲解**。
   * 「石窟」既算有故事也算要爬，但站在那儿听人讲一段更值。
   */
  const guide = opts.find((o) => o.how === 'guide');
  const pool = guide ? [guide] : opts;
  const picked = pool[(hashOf(spot) + Math.abs(Math.round(seed))) % pool.length];
  if (!picked) return null;
  return {
    item: picked.label,
    price: picked.price,
    text: picked.text.includes('%s') ? picked.text.replace('%s', spot) : picked.text,
  };
}

/**
 * 南方的海：香蕉艇、摩托艇、堆沙堡、潜水（2026-11-08 Mr.Q）。
 *
 * 判据三层，缺一条都不给：
 *
 * 1. **这座城市得靠海**（`tags` 里有「海」或「海岛」）—— 内陆城市的湖不算，
 *    千岛湖上没人玩香蕉艇；
 * 2. **脚下得是沙滩/海滨/海岛**，不是码头也不是海堤；
 * 3. **天要暖**（`warm`）—— 十一月的青岛海边，摩托艇老板自己都不出海。
 *
 * 价格按三亚/厦门/北海的水上项目牌价（2026-11 查）：
 * 香蕉艇 80–120/人、摩托艇 150–200/10 分钟、体验潜水 300–500（含装备与教练）。
 * 堆沙堡不要钱，但它是一件真会发生的事 —— 所以它也有位置。
 */
export function beachPlay(
  spot: string,
  city: City,
  seed: number,
  comfortable: boolean,
  warm: boolean,
): Leisure | null {
  const sea = city.tags.includes('海') || city.tags.includes('海岛');
  if (!sea) return null;
  /*
   * 「湾」也算：亚龙湾、海棠湾、大东海这类名字里不带「沙滩」两个字，
   * 但脚下就是沙。宽到这一层是因为海边的地名本来就不统一。
   */
  /*
   * 名字里带这些字的基本就是海里那处：亚龙湾、鼓浪屿、银滩、假日海滩、蜈支洲岛。
   * 判据是「海 tag + 地名里有个水字」，两道都过才给 —— 内陆城市的「外滩」不会中，
   * 因为那座城没有海 tag。
   */
  if (!/沙滩|海滩|海滨|浴场|海湾|湾|岛|屿|滩|海角|海/.test(spot)) return null;
  /* 冷的时候只剩「踩水」这一件不要钱的事。 */
  if (!warm) {
    return Math.abs(seed) % 100 < 50
      ? { item: '海边走走', price: 0, text: `沿着${spot}的沙上走了一段，海风偏凉，浪花只轻轻漫过脚背` }
      : null;
  }
  if (Math.abs(seed) % 100 >= 70) return null;

  /* 同样要带种子：不带的话同一片沙滩永远是同一个项目。 */
  const roll = (hashOf(`${spot}${city.id}`) + Math.abs(Math.round(seed))) % 4;
  if (roll === 0) {
    return { item: '香蕉艇', price: 100, text: `在${spot}坐了香蕉艇，迎面一个大浪把整条艇掀起来，溅了一身水花，大家都笑作一团` };
  }
  if (roll === 1) {
    if (!comfortable) return { item: '堆沙堡', price: 0, text: `在${spot}蹲着堆了半天沙堡，浪一涌上来就冲塌了半边` };
    return { item: '摩托艇', price: 180, text: `在${spot}骑了十分钟摩托艇，油门一拧，海风迎面扑来` };
  }
  if (roll === 2) {
    if (!comfortable) return { item: '堆沙堡', price: 0, text: `在${spot}蹲着堆了个沙堡，还捡了几片贝壳嵌上去当窗户` };
    return { item: '体验潜水', price: 400, text: `在${spot}背着气瓶下了水，水下很静，只剩气泡和呼吸声，礁石间游过几尾蓝鱼` };
  }
  return { item: '堆沙堡', price: 0, text: `在${spot}脱了鞋踩着温热的细沙，蹲下来堆了座小沙城，又看着潮水把它慢慢抹平` };
}

/**
 * 晚上在酒店（2026-11-08 Mr.Q：「晚上在好酒店里可以游泳、健身、做 spa 按摩」）。
 *
 * 分档给，因为**快捷连锁没有泳池**：
 *
 * - `luxury`（五星/豪华）：泳池、健身房、SPA 三选一（SPA 要手头宽）；
 * - `view`（景观房/民宿/客栈）：泡个澡、在阳台坐一会儿 —— 不要钱，也不假装有泳池；
 * - `budget` / `dingy`：什么都不给。硬塞一个「在招待所健身」比不给更假。
 *
 * 价格：酒店 SPA 60 分钟 300–600（2026-11 查的四五星酒店水疗报价），按 380 记。
 */
export interface NightOption {
  /** 工具参数值（`journey_hotel_night` 的 `what`）。 */
  readonly what: string;
  /** 中文名，回执里用。 */
  readonly label: string;
  readonly price: number;
  /** 这一段发生什么。 */
  readonly text: string;
}

/**
 * 晚上在住处能干什么 —— **按这家店真有的设施给**（2026-11-09）。
 *
 * ## 为什么不再按档位猜
 *
 * 原来按 `tier` 分：五星档一律给泳池、健身房、SPA。可挂了真名之后，
 * 「那家店到底有没有泳池」是查得到的 —— 实测 5 星店设施覆盖率 87%，
 * 剩下 13% 里就有只配了健身房的。说她「在泳池里游了二十分钟」，
 * 用户上携程一看没泳池，这就是第三次返工。
 *
 * 所以现在**只看 `amen`**：有泳池才给泳池，有温泉才给温泉。
 * 没有设施数据时退回最朴素的那几样（泡澡、在窗边坐一会儿）——
 * 那些换到任何一家店都成立。
 *
 * ## 为什么单独导出
 *
 * 这套候选两处要用：① `planDay` 排程时按种子挑一个；
 * ② `journey_hotel_night` 工具用它校验「她说要在酒店游泳」到底行不行。
 * 同一份数据两处引用，才不会出现「排程说能游、工具说不能游」。
 */
export type NightCityHint = Pick<City, 'id' | 'name' | 'tags' | 'night'> & { readonly country?: string };

const NIGHT_CRUISE_CITIES = new Set([
  'guangzhou', 'shanghai', 'wuhan', 'chongqing', 'lanzhou', 'guilin', 'xianggang',
  'nanjing', 'hangzhou', 'tianjin', 'paris', 'istanbul', 'london', 'budapest',
  'prague', 'amsterdam', 'petersburg', 'seoul', 'tokyo', 'osaka', 'bangkok', 'singapore', 'sydney',
]);
const ROWBOAT_CITIES = new Set(['shaoxing', 'suzhou', 'yangzhou', 'hangzhou']);
const TRAM_CITIES = new Set([
  'xianggang', 'dalian', 'changchun', 'shenyang', 'sanfrancisco',
  'prague', 'vienna', 'zurich', 'amsterdam', 'budapest', 'toronto',
  'istanbul',
]);

export function hotelNightOptions(
  tier: LodgingTier,
  amen: readonly string[] = [],
  around: readonly { readonly n: string; readonly km: number }[] = [],
  /** 这座城夜里那处地方（`city.night`，如「九眼桥那一带的夜」）。空则说通用的话。 */
  nightText = '',
  /** 住处类别（如「房车营地露营过夜」），用于兼容缺 amen 的已落盘房车存档。 */
  kind = '',
  city?: NightCityHint,
): readonly NightOption[] {
  const out: NightOption[] = [];
  const has = (k: string): boolean => amen.includes(k);
  if (has('camper') || kind === '房车营地露营过夜') {
    return [
      { what: 'stargaze', label: '营地看星空', price: 0, text: '拉开天窗和遮阳棚，在营地折叠椅上吹了会儿晚风，抬头看了一阵夜空里的星星' },
      { what: 'cook', label: '车里煮面', price: 0, text: '用房车里的便携灶台烧水煮了碗热腾腾的素面，就着营地微亮的暖灯吃完了' },
      { what: 'campwalk', label: '营地散步', price: 0, text: '沿着营地泊位间的小路慢悠悠走了一圈，听见远处的风声和几家旅人收帐篷的动静才回车里' },
    ];
  }
  /** 说不出地名时那句通用的话。两处引用同一份，改一处就够。 */
  const AROUND_PLAIN = '出门沿着周边街巷慢悠悠走了一段，夜里行人稀少，回程顺手买了瓶水';

  if (has('pool')) {
    out.push({ what: 'pool', label: '泳池', price: 0, text: '去泳池游了二十分钟，水温刚好，池底柔光照着水面波纹' });
  }
  if (has('onsen')) {
    out.push({ what: 'onsen', label: '温泉', price: 0, text: '去泡了会儿温泉，热气氤氲，泡得浑身舒展才上来' });
  }
  if (has('gym')) {
    out.push({ what: 'gym', label: '健身房', price: 0, text: '去健身房慢跑了三公里，跑步机正对着落地窗，窗外夜色里的车灯连成光带' });
  }
  if (has('spa')) {
    out.push({ what: 'spa', label: 'SPA', price: 380, text: '做了个一小时的舒缓推背，出来时肩颈轻松了不少' });
  }
  if (has('bar')) {
    out.push({ what: 'bar', label: '楼下喝一杯', price: 80, text: '下楼在大堂吧要了杯饮品，安静坐了半小时才回房' });
  }
  /*
   * 出门转转：只在**最近的去处一公里出头**时给。
   * 五公里外的「周边」不叫周边，那不如今晚不出门。
   *
   * **但「没有数据」和「确实远」是两回事**（2026-11-12）。
   * 原来越界只会走 `near && near.km <= 2` 这一条，`around` 一空就什么都不给 ——
   * 于是住在钟楼旁边的人，晚上能干的只剩「泡澡」和「在房间里待着」，
   * 回执念出来就是「系统只给我两个选项」。数据缺一条，不该等于把门锁了。
   * 没数据时说通用的话（不点地名，不编），有数据但都远才真的不出门。
   */
  const near = around[0];
  if (near && near.km <= 2) {
    /*
     * **说得出地方名就说。**（2026-11-09）
     *
     * `city.night` 是早就核过的一处（144 座城有），比如成都的「九眼桥那一带的夜」、
     * 西安的「大唐不夜城，灯是从头亮到尾的」。比「出门沿着街走了一段」具体得多，
     * 而且不用编 —— Mr.Q 问的就是「晚上的语句是不是可以丰富多了」。
     */
    /*
     * **说法不能只有一种。**（2026-11-09 自己读出来的）
     *
     * 第一版无论哪座城都是「出门去了X，转了一圈才回来」——
     * 成都、西安、东京、德累斯顿连着读，就是同一个模板换了地名，
     * 正是用户抱怨过的「单调」。
     *
     * 四种说法按城市文本取哈希挑，同一城稳定（重算不换），不同城不同。
     */
    const AROUND_SAY = [
      (t: string) => `出门去了${t}，不紧不慢转了一圈才回来`,
      (t: string) => `晚上出去散了会儿步，顺路去了${t}`,
      (t: string) => `去了趟${t}，来回逛了约莫四十来分钟`,
      (t: string) => `去了${t}，夜里挺热闹，待了一会儿才回店`,
    ];
    out.push({
      what: 'around',
      label: '出门转转',
      price: 0,
      text: nightText
        /*
         * 用「首字符码 × 31 + 长度」取模，不用 `hashOf` ——
         * 第一版用 hashOf，成都/东京/德累斯顿三段中文算出来同余，
         * 四种说法里三个落在第一种，等于没改。
         */
        /*
         * 用 `hashOf` 的**高位**再取模（`hashOf` 就是 FNV-1a，在本文件上面）。
         *
         * 这条试了三版：① `hashOf(x) % 4` —— 取的是低两位，
         * 而中文整段的熵在高位，结果成都/东京/德累斯顿同余，三个都落在第一种；
         * ② 首字符码 ×31 + 长度 —— 中文字符码本来就挤在一个区间，
         * 取模照样扎堆，四个全变成第二种。低两位对中文基本没用。
         */
        ? AROUND_SAY[(hashOf(nightText) >>> 16) % AROUND_SAY.length]!(nightText)
        : AROUND_PLAIN,
    });
  } else if (!near) {
    /* 完全没有周边数据：不点地名，只说走了走 —— 编一个去处比不说更糟。 */
    out.push({ what: 'around', label: '出门走走', price: 0, text: AROUND_PLAIN });
  }

  if (city) {
    const hasNight = Boolean(city.night) || Boolean(nightText);
    if (hasNight && (NIGHT_CRUISE_CITIES.has(city.id) || city.tags.some((t) => /外滩|海港|江景|夜游/.test(t)))) {
      out.push({
        what: 'night-cruise',
        label: '城市夜游船',
        price: 80,
        text: '买票上了城市夜游船，吹着江海晚风看两岸霓虹和铁桥灯影，船上旅人低声闲聊，气氛格外松快',
      });
    }
    if ((!city.country || city.country === 'CN') && (city.tags.some((t) => /古镇|水乡|运河/.test(t)) || ROWBOAT_CITIES.has(city.id))) {
      out.push({
        what: 'rowboat',
        label: '水乡摇橹乌篷船',
        price: 60,
        text: '夜里坐上摇橹乌篷船，木桨吱呀划开水面灯影，听着岸边茶馆的细碎说笑声慢慢飘过去',
      });
    }
    if (TRAM_CITIES.has(city.id) || city.tags.some((t) => /叮叮车|有轨电车/.test(t))) {
      out.push({
        what: 'tram',
        label: '复古有轨叮叮车',
        price: 10,
        text: '跳上一辆复古有轨叮叮车，坐进温润的木座椅里听着「叮叮」摇铃，慢悠悠晃过半座老城的灯火',
      });
    }
  }

  /* 通用项：任何一家店都成立，也是没设施数据时的兜底。 */
  if (tier === 'luxury' || tier === 'view') {
    out.push({ what: 'bath', label: '泡澡', price: 0, text: '放了一缸热水慢慢泡澡，窗留了条小缝，透进一点清凉夜风' });
    out.push({ what: 'room', label: '在房间待着', price: 0, text: '窗帘拉开一半，靠在窗边听了一会儿楼下的夜声' });
  } else {
    out.push({ what: 'bath', label: '冲个澡', price: 0, text: '舒舒服服冲了个热水澡，躺下没多久就泛起困意' });
  }
  return out;
}

/**
 * 排程时自动挑一个（原来那套的入口，签名没变，多了一个 `amen`）。
 *
 * 判档在 `hotelNightOptions` 里 —— 这里只负责「按种子挑一个」和
 * 「手头紧就别选要钱的」。
 */
export function hotelEvening(
  tier: LodgingTier,
  seed: number,
  comfortable: boolean,
  amen: readonly string[] = [],
  around: readonly { readonly n: string; readonly km: number }[] = [],
  nightText = '',
  kind = '',
  city?: NightCityHint,
): Leisure | null {
  const all = hotelNightOptions(tier, amen, around, nightText, kind, city);
  const free = all.filter((x) => x.price === 0 || comfortable);
  if (!free.length) return null;
  const pickd = free[Math.abs(seed) % free.length];
  return pickd ? { item: pickd.label, price: pickd.price, text: pickd.text } : null;
}

/**
 * 没有景点可排的时候，去干什么（2026-11-08 Mr.Q：「没有景点时候可以去河边逛逛、
 * 商店里买买土特产、看看这个城市独特的景色」）。
 *
 * `genericSpots()` 原来那几条只有「走一走」「坐一会儿」，读了等于没去。
 * 这里补三类**具体的目的地**：
 *
 * - **水边**：有江/河/湖水的城市，本地人真的会去散步的那一段；
 * - **土特产**：不是景区纪念品店 —— 是本地人买的那个店，卖的是这座城自己的东西
 *   （用 `city.foods` 的头两样当线索，那本来就是这一带真有的）；
 * - **这座城独有的那一眼**：用 `VISTA` 里写过的那处地方反推，不另编。
 */
export function idleSpots(city: City, vista: string): readonly string[] {
  const out: string[] = [];
  const t = city.tags;
  if (t.includes('江') || t.includes('河') || t.includes('湖') || t.includes('水') || t.includes('运河')) {
    out.push('沿河的那条步道');
  }
  const first = city.foods[0];
  if (first) out.push(`卖${first}的土特产店`);
  if (t.includes('古城') || t.includes('古都') || t.includes('老城')) out.push('老城里的旧货摊');
  /*
   * 城市独有的那一处：从视觉锚点里取前一小段当描述，原样保留地名 ——
   * `VISTA` 是核过的（见 0.5.37 那次逐条查证），比现编一句可靠。
   */
  const anchor = String(vista || '').split('，')[0];
  if (anchor.length >= 4) out.push(anchor);
  out.push('本地人的菜市场');
  return out;
}
