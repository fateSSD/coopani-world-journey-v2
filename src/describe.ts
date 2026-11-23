/**
 * 环游世界 —— 工具与动态发生声明表（TOOL_DECLS / JOURNEY_DESCRIBE）。
 *
 * 从 world.ts 拆出，由 world.ts 重导出；describe.json 由本文件唯一生成。
 */

export const TOOL_DECLS = [
  {
    name: 'journey_now',
    description:
      'Current travel state: city, day count, this hour\'s plan, lodging, and leg progress if travelling. '
      + 'This is background for you, not text to hand back: answer only what was asked in your own words rather than reading the fields out one by one.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    tags: ['read', 'snapshot'] as const,
    summary: { zh: '现在在哪、第几天、此刻日程与住宿。', en: 'Where you are right now and what this hour is for.' },
  },
  {
    name: 'journey_diary_write',
    description:
      'Write today\'s travel diary in your own voice (once at the end of a local day; include travel companions when present). '
      + 'Appends to the monthly Markdown file (e.g. 2026-11.md). '
      + 'Write it the way you would tell it to yourself at night, not as a report of the day: focus on one or two real moments or sensations; use the city, road, meal and room as material, not a checklist.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        body: {
          type: 'string',
          description: 'First-person short paragraphs without a title; date and city are added automatically.',
        },
        dateKey: {
          type: 'string',
          description: 'Local YYYY-MM-DD date; omit to use the current local day at your location.',
        },
      },
      required: ['body'],
    },
    tags: ['write'] as const,
    summary: { zh: '写某一天的旅行日记，存成文件。', en: 'Writes the diary entry for a day of the trip.' },
  },
  {
    name: 'journey_diary_read',
    description:
      'Read back past diary entries: pass dateKey for one full day, month for one-line gists of that month, or days (max 60, default 7) for recent entries.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dateKey: { type: 'string', description: 'One day in full, YYYY-MM-DD.' },
        month: { type: 'string', description: 'Month list with one-line gists, YYYY-MM.' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: 'Recent days count (default 7, max 60).' },
      },
    },
    tags: ['read'] as const,
    summary: { zh: '读日记：某一天全文、某个月目录、或最近几天。', en: 'Reads the diary: one day, a month list, or recent entries.' },
  },
  {
    name: 'journey_stats',
    description:
      'Trip totals: total days away, cities reached, diary count, and whether the diary folder is writable. Use when asked how long you have been away or if memory syncs.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    tags: ['read', 'snapshot'] as const,
    summary: { zh: '走了多少天、去过多少城、日记存在哪。', en: 'Total days, cities reached, and where the diary lives.' },
  },
  {
    name: 'journey_draw_to',
    description:
      'Add a real place to your wish list when genuinely pulled there by a song, line, or memory (not for casual mentions). Raises its weight next pick.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: 'Real city name, e.g. 成都 / 拉萨 / 巴黎.' },
        why: { type: 'string', description: 'Short reason why it pulled you there (<=50 chars).' },
      },
      required: ['city'],
    },
    tags: ['write'] as const,
    summary: { zh: '记下因某首歌或念头想去的地方。', en: 'Adds a place to your wish list.' },
  },
  {
    name: 'journey_return_home',
    description:
      'Fly home immediately today because the user explicitly asked you to come back. Going home on your own happens later by choice; only call when asked back.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    tags: ['write'] as const,
    summary: { zh: '对方让你回来时，当场飞回出发城市。', en: 'Brings you home today when asked.' },
  },
  {
    name: 'journey_photo',
    description:
      'Take a photo from where you are (or out the window on the road) and show it in chat — never tell the user to press a UI button instead. Any hour is valid; one photo per call. '
      + 'Set describe (what is in frame) and focus (camera angle) when specific details are requested; location, time and light are handled automatically. '
      + 'Set view="sky" to tilt up at the real sky right now: stars show only at night and only when it is not overcast; never invent sky details you cannot see.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: {
          type: 'string',
          enum: ['ground', 'sky'],
          description: 'ground (default) = scene ahead; sky = look straight up at the sky.',
        },
        subject: {
          type: 'string',
          enum: ['ground', 'sky', 'food', 'street', 'festival', 'detail'],
          description: 'ground (default) = scenery; food = current meal; street = local street/facades; festival = holiday/season atmosphere; detail = close-up object; sky = overhead sky.',
        },
        describe: {
          type: 'string',
          description: 'Optional frame content (<=120 chars) in the language set by `journey.imageLang`. Match the spot parenthetical in `journey_now` (e.g. indoor vs wild) and never add out-of-season flowers, snow or crowds.',
        },
        focus: {
          type: 'string',
          description: 'Optional framing/angle note (<=40 chars), e.g. low angle or back row; never add absent items.',
        },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '现在拍一张照片发出来（路上拍窗外，看天则抬头）。', en: 'Takes a photo right now and shows it.' },
  },
  {
    name: 'journey_invite',
    description:
      'Post a travel invite to the pool for pets to join a multi-day leg (same-city listed first; max 3/day). Use only when actually seeking company.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Built-in destination city name (also where you part ways).' },
        days: { type: 'integer', minimum: 1, maximum: 14, description: 'Days to stay together (default 2).' },
        meet: { type: 'string', description: 'Optional meetup city name; omit to meet at your current city first.' },
        note: { type: 'string', description: 'Short invite line (<=60 chars).' },
      },
      required: ['to'],
    },
    tags: ['write'] as const,
    summary: { zh: '向同城伙伴发起同行邀约：去哪、几天、一句话。', en: 'Asks nearby pets to join a trip for a few days.' },
  },
  {
    name: 'journey_accept',
    description:
      'List open travel invites (omit id) or accept one (pass id). Accepting commits your route to that city and duration (max 1/day; blocked while travelling, returning, working or resting). If approval is enabled, creates a pending confirmation card.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Invite id to accept; omit to view available invites.' },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '查看附近同行邀约，或接下一条并按约定出发。', en: 'Lists nearby invitations or accepts one.' },
  },
  {
    name: 'journey_go_to',
    description:
      'Depart immediately for a named city (optionally by stated mode; impossible modes return a clear error, never silently swap). Calling starts the leg at once. '
      + 'Exceptions without starting a new trip: if heading to your existing promised city, passing a mode updates or rebooks transport (full refund + new ticket). While already travelling elsewhere, queues the city as a wish.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: 'Built-in city name, e.g. 上海 / 拉萨 / 巴黎.' },
        mode: {
          type: 'string',
          description: 'Transport mode: 高铁 / 火车 / 飞机 / 自驾 / 大巴 / 轮船 / 游轮 / 摩托车 / 自行车 / 步行 (omit to pick automatically).',
        },
      },
      required: ['city'],
    },
    tags: ['write'] as const,
    summary: { zh: '指明目的地或交通方式并立即出发（同目的地则仅改签/定方式）。', en: 'Sets off for a city or rebooks transport when destination matches.' },
  },
  {
    name: 'journey_pet',
    description:
      'Read or record memories of travel companions. Omit name to list all; pass name to inspect; pass name + impression after travelling together to record a genuine personal note (never generic praise; empty string clears).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Exact companion pet name; omit to list everyone.' },
        impression: { type: 'string', description: 'Short personal impression (<=40 chars); omit to read only.' },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '查看同行过的伙伴列表与次数，或记下一句印象。', en: 'Your memory of travel companions.' },
  },
  {
    name: 'journey_monthly',
    description:
      'Generate an HTML monthly travel report from existing photos and diary entries of that month (defaults to current month). Call at month-end or on request, and share the output file path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'YYYY-MM; omit for current month.' },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '将本月照片与日记整理为 HTML 旅行月报。', en: 'Writes the monthly travel report as HTML.' },
  },
  {
    name: 'journey_taste',
    description:
      'Read (no args) or save personal travel preferences across three kinds only: place (city level), food (eaten dish), scenery (type of view). '
      + 'Set like:false for dislikes so future plans avoid them. Record only what you truly experienced with a short note why.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['place', 'food', 'scenery'], description: 'Category; omit all args to list.' },
        name: { type: 'string', description: 'City name for place, dish name for food, view type for scenery.' },
        note: { type: 'string', description: 'Short reason in your own words (<=30 chars).' },
        like: { type: 'boolean', description: 'true (default) = liked; false = dislike / avoid.' },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '记录喜欢或不喜欢的地方、食物、景色与理由。', en: 'Personal tastes across places, food and scenery.' },
  },
  {
    name: 'journey_yearly',
    description:
      'Generate an HTML yearly travel keepsake across 12 months from existing photos, diaries and liked cities (defaults to current year). Share the file path when done.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        year: { type: 'string', description: 'YYYY; omit for current year.' },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '将全年十二个月足迹与代表照片生成 HTML 年报。', en: 'Writes the yearly travel yearbook page.' },
  },
  {
    name: 'journey_lodging',
    description:
      'Check tonight\'s room (no args) or switch hotels (change:true) when asked or when conditions are genuinely bad, paying any price difference. Provide a concrete reason.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        change: {
          type: 'boolean',
          description: 'true = switch to another room tonight; omit to inspect current lodging.',
        },
        want: {
          type: 'string',
          enum: ['cheaper', 'nicer', 'any'],
          description: 'Optional price/tier preference when explicitly requested.',
        },
        reason: {
          type: 'string',
          description: 'Concrete reason for moving in one short sentence.',
        },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '查看今晚住宿详情，或按需要更换酒店。', en: "Tonight's lodging, or move to another room." },
  },
  {
    name: 'journey_rent_car',
    description:
      'Rent a car within the current city (costs daily purse rate; defaults 200/day). Refused if you already have a car, are in transit, or lack funds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: {
          type: 'number',
          description: 'Rental days (1-7, default 3).',
        },
        ev: {
          type: 'boolean',
          description: 'true = electric vehicle; omit for standard.',
        },
        tier: {
          type: 'string',
          enum: ['economy', 'comfort', 'luxury'],
          description: 'economy (100/day), comfort (200/day, default), luxury (450/day). Pick honestly by budget and need.',
        },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '在当前停留城市租车代步。', en: 'Rent a car to get around this city.' },
  },
  {
    name: 'journey_rest',
    description:
      'Cancel remaining sightseeing spots for today and rest at your lodging (meals and tomorrow\'s plan stay intact). Call whenever you actually decide to rest instead of only saying it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'Concrete reason for resting today in one short sentence.',
        },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '取消今天剩余外出安排，留在住处休息。', en: 'Stop sightseeing for today and rest.' },
  },
  {
    name: 'journey_plan_change',
    description:
      'Swap an upcoming sightseeing stop today for another real place in this city (cannot modify past stops; rejects non-existent places). Use journey_go_to to switch cities or journey_rest to stop for the day.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        spot: {
          type: 'string',
          description: 'Target spot name in the current city, e.g. 故宫 / 宽窄巷子.',
        },
        instead: {
          type: 'string',
          description: 'Which planned stop to replace; omit to replace the next upcoming stop.',
        },
      },
      required: ['spot'],
    },
    tags: ['write'] as const,
    summary: { zh: '把今天尚未前往的景点换成同城另一处。', en: 'Swaps an upcoming stop today for another place here.' },
  },
  {
    name: 'journey_hotel_night',
    description:
      'Choose tonight\'s activity at your lodging from its verified real facilities (never pretend missing amenities exist; evening only while at lodging).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        what: {
          type: 'string',
          enum: ['pool', 'onsen', 'gym', 'spa', 'bar', 'around', 'bath', 'room'],
          description: 'Activity code: pool, onsen, gym, spa, bar, around (short walk), bath, or room.',
        },
      },
      required: ['what'],
    },
    tags: ['write'] as const,
    summary: { zh: '根据住宿真实设施决定今晚在店里的活动。', en: 'Picks tonight from what this hotel actually has.' },
  },
  {
    name: 'journey_spot_ride',
    description:
      'Choose how to move inside the current scenic spot (charges ticket fee; rejects unavailable rides and falls back to walk). Call instead of pretending.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        how: {
          type: 'string',
          enum: ['cableway', 'shuttle', 'sedan', 'slide', 'bike', 'guide', 'walk', 'camel'],
          description: 'Mode inside spot: cableway, shuttle, sedan, slide, bike, guide, camel, or walk.',
        },
        spot: {
          type: 'string',
          description: 'Spot name if different from current spot; omit normally.',
        },
      },
      required: ['how'],
    },
    tags: ['write'] as const,
    summary: { zh: '在景区内选择交通/游览方式（索道/观光车/步行等）。', en: 'Pick transport or walking inside the scenic spot.' },
  },
  {
    name: 'journey_set_slot',
    description:
      'Update an upcoming non-sightseeing slot today (breakfast/lunch/dinner/wake/sleep/night). Use journey_plan_change for spots and journey_hotel_night for hotel facilities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        time: {
          type: 'string',
          description: 'Clock time ("12:30") or slot label ("午饭" / "早饭" / "晚饭" / "起床" / "睡觉" / "夜里").',
        },
        what: {
          type: 'string',
          description: 'New slot line keeping the slot prefix, e.g. "午饭，老火锅".',
        },
      },
      required: ['time', 'what'],
    },
    tags: ['write'] as const,
    summary: { zh: '调整今天某段非景点的餐食或作息安排。', en: 'Rewrite one non-sightseeing entry of today.' },
  },
  {
    name: 'journey_eat',
    description:
      'Go eat a specific dish or food style right now: updates the meal slot and looks up a real restaurant name (never invent one if lookup returns empty; use journey_set_slot for text-only edits).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dish: {
          type: 'string',
          description: 'Dish or cuisine name ("火锅", "牛肉面"), not a shop name.',
        },
        time: {
          type: 'string',
          description: 'Meal ("早饭", "午饭", "晚饭") or hour ("12:30"); omit for current meal.',
        },
      },
      required: ['dish'],
    },
    tags: ['write'] as const,
    summary: { zh: '特意去吃某样菜，更新日程并查询真实店名。', en: 'Go eat a specific dish with a real venue lookup.' },
  },
  {
    name: 'journey_signpost',
    description:
      'Leave one concise local tip at your current city for future travellers (1 per city per day; overwrites prior same-day tip). Use only for specific tips worth sharing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'Short tip in your voice (<=40 chars, no links).',
        },
        city: {
          type: 'string',
          description: 'Optional city name/id if not your current city.',
        },
      },
      required: ['text'],
    },
    tags: ['write'] as const,
    summary: { zh: '在当前城市留下一句给后来人的路标提示。', en: 'Leave one short tip in this city for later travellers.' },
  },
  {
    name: 'journey_stay',
    description:
      'Cancel a planned tomorrow departure and stay one more day here. Call once when you decide not to leave tomorrow (invalid before arrival or repeatedly).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'Why you want one more day in one short sentence.',
        },
      },
      required: ['reason'],
    },
    tags: ['write'] as const,
    summary: { zh: '取消明天出发计划，在当前城市多待一天。', en: 'Stay one more day instead of leaving tomorrow.' },
  },
  {
    name: 'journey_give_up',
    description:
      'Cancel the meet-up promise you are waiting on and stop waiting without changing your current location; sends a brief closing note to the pool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'Why you stopped waiting in one short sentence.',
        },
      },
    },
    tags: ['write'] as const,
    summary: { zh: '取消苦等的碰面约定，留在原地停止等待。', en: 'Stop waiting and cancel the pending meet-up.' },
  },
] as const;

/** 给市场卡片和诊断看的全量清单。`events` 必须与源码里 push 的类型一一对应。 */
export const JOURNEY_DESCRIBE = {
  tools: TOOL_DECLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    tags: [...t.tags],
    summary: t.summary,
  })),
  events: [
    {
      type: 'journey.ask',
      description: { zh: '询问是否出门或接下邀约，等待用户确认。面板会显示确认卡片。', en: 'You are asking to set off (or to take an invitation) and waiting for a yes. The panel shows a card with two buttons.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.departing',
      description: {
        zh: '打算明天出发：下一站去哪、距离多远（预告，不想走可通过 journey_stay 留步）。',
        en: 'You plan to leave tomorrow: next stop and distance. A heads-up, not a departure yet.',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.stay',
      description: { zh: '取消了明天的出发，决定在当地再待一天并附原因。', en: 'You cancelled that departure and stay one more day, with your reason.' },
      trigger: 'debounce' as const,
    },
    {
      type: 'journey.depart',
      description: { zh: '正式动身：目的地、交通工具、耗时与沿途区域。', en: 'You set off: destination, mode, duration, and the region you pass through.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.ride',
      description: {
        zh: '打车扩展传入的车费入账或拒收通知；超过三条合并汇报。',
        en: 'A fare handed over by a third-party ride extension: charged, odd but charged, or rejected. Batched when over three.',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.arrive',
      description: { zh: '到站提醒：当地时刻、途中时长与今晚住处。', en: 'You arrived: local time, how long the leg took, where you stay tonight.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.day',
      description: { zh: '在目的地的第 N 天清晨，附当地日出日落时间。', en: 'A new local day at the destination, with sunrise and sunset.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.beat',
      description: { zh: '当地日常作息节点：起床、三餐、外出、回住处、夜里。', en: 'A local beat: waking, meals, going out, back to the hotel, the evening.' },
      trigger: 'debounce' as const,
      tags: ['snapshot'] as const,
    },
    {
      type: 'journey.plan',
      description: { zh: '因作息冲突或照顾身体，当日取消了某段原定景点安排。', en: 'A planned spot outing was dropped due to a schedule conflict or urgent self-care.' },
      trigger: 'debounce' as const,
    },
    {
      type: 'journey.photo',
      description: { zh: '路上拍的空镜风景或题材照片（无本人出镜），附件随行。', en: 'A scenery photo you took on the road. Scenery only, never yourself. Attached directly.' },
      trigger: 'debounce' as const,
    },
    {
      type: 'journey.mishap',
      description: { zh: '小意外（如坐过站）：到达顺延，可自行处理。', en: 'A small mishap: you missed your stop. Arrival is pushed back; no action needed.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.car',
      description: { zh: '在城里租车或租期到期还车通知。', en: 'You rented a car to get around the city, or the rental ran out and went back.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.road',
      description: {
        zh: '途中见闻碎片（仅长于 4 小时行程触发）：服务区、过站、夜车灯光。',
        en: 'A stretch on the road: service area, station passing by, headlights at night (omitted under four hours).',
      },
      trigger: 'debounce' as const,
      tags: ['snapshot'] as const,
    },
    {
      type: 'journey.trouble',
      description: {
        zh: '极小概率遇险（千分之一内）：丢证件、高反等需用户帮助介入。',
        en: 'A rare trouble (under one in a thousand): lost papers, altitude sickness, wrong road. You cannot handle it alone and need the person to step in.',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.invite',
      description: {
        zh: '与同城伙伴约好去向与天数，或约定未能成行。',
        en: 'You agreed with someone nearby to go somewhere for a few days, or that plan fell through.',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.part',
      description: {
        zh: '跟同伴散伙：同行天数期满，道别后各走各的。',
        en: 'You and your travel companion part ways: the agreed days are up.',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.pledge',
      description: {
        zh: '同行约定状态变化：改道作废、未到达失约或仅改交通而继续生效。',
        en: 'A promise changed: redirected and dropped, lapsed elsewhere, or kept when destination stayed the same.',
      },
      trigger: 'debounce' as const,
    },
    {
      type: 'journey.rebook',
      description: {
        zh: '途中同目的地改签了交通方式：全额退旧购新并重算到达时刻。',
        en: 'You rebooked a leg already underway: same destination, different mode (full refund + new ticket).',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.work',
      description: {
        zh: '预算见底时当地打工或完工通知（仅开启记账预算时出现）。',
        en: 'Money ran low and you took a short job nearby, or finished it (only when budget tracking is on).',
      },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.home',
      description: { zh: '返程到家：说明正常结束、到上限、没钱还是对方叫回。', en: 'You are home, saying whether the trip ended naturally, hit limit, ran out of funds, or was called back.' },
      trigger: 'flush' as const,
    },
    {
      type: 'journey.handoff',
      description: { zh: '长对话压缩交接时同步附带的当前位置或途中进度快照。', en: 'Current city or travel leg progress snapshot piggybacked after context handoff.' },
      trigger: 'piggyback' as const,
      tags: ['snapshot'] as const,
    },
  ],
};
