# meetUrl 改多值 · 设计与改动方案

> 2026-11-21 · 对应《模拟鱼生-方案》§4.18（联邦 F1）与「十五、联邦什么时候做」。
> 目标：把「一个碰面服务器地址」变成「一组地址」，为 F1 留好位置。
> 本文件只写**怎么改、为什么这么改、怎么验收**，不写排期承诺。
>
> **2026-11-21 复审修订**：外部审查提出 5 条，逐条对源码核过 —— 5 条方向全部成立，已并入正文（改动处标了「复审修正」）。另有 2 处审查说错了，记在 §11。
>
> **2026-11-21 落地状态**：P0 + L0 已写进代码，等 Mr.Q 点头发版（`2.4.0`）。上限 3 台、配额全局已拍；L1 / L2 仍未动。

---

## 0. 结论先行

| 阶段 | 做什么 | 行为变化 | 建议 |
|---|---|---|---|
| **P0** | 修「全是非法地址却亮绿灯」+ 把多地址提示挪到主面板 | 只有填错地址的人看得出区别 | **现在做**，约 20 行，可单独发 |
| **L0** | 类型与解析层吃多值，`meetOptions()` 取第一台 | 无 | 跟着下一版功能一起出去，约 40 行 |
| **L1** | 单服务器状态位改成「按台」结构 | 无 | 跟 L2 一起做，不单独发 |
| **L2** | 15 个网络口遍历 + 聚合 + 文案改口径 + 配额全局化 | 有 | **不排期**，等第二个社群真的有人 |

一句话：**P0 是修今天的错，L0 是「改一次以后不用迁移」，L2 是「真联邦」。现在做 P0 + L0。**

---

## 1. 为什么现在做 L0

1. **这是方案里点名的两件「现在做」之一。** §4.18 排期表列了两条零成本动作：① 配置项改成兼容数组；② 每台服务器加 `GET /town/info`。第 ② 条已经在线上了（`cloud/sight-cf/src/worker.js:2191`），第 ① 条至今没做。
2. **触发条件已经在门口。** 2026-11-21 的读者邮件里已经出现了「自己建一台东莞服务器」这个提议 —— 「部署城」这个数从 0 变 1 是随时的事。
3. **越晚改越贵。** 配置里已经躺着的值是单值字符串。L0 让代码同时认单值和数组，之后无论谁来改都不会遇到「老配置读不出来」。
4. **它不依赖生活层。** 方案 §1.4 第五处原话：「这一处和上面四处性质不同：它不依赖模拟鱼生，是联邦的前置，所以可以随时单独做」。

---

## 2. 现状（可核）

| 位置 | 现在是什么 | 为什么是问题 |
|---|---|---|
| `src/config.ts:66` | `meetUrl: string` | 类型层面只能装一台 |
| `src/config.ts:571` | schema `type: 'string'` | 设置页只有一个输入框 |
| `src/config.ts:365` | 默认 `''` | 空＝功能全关，这个语义要保住 |
| `src/world-social.ts:127-137` | `String(cfg.meetUrl)` → `normalizeMeetUrl` → `{ url, uid, pet }` | 归一化只回一条 |
| 全仓 `meetOptions()` | **19 处调用**（world-social 11 / world-webui 4 / world.ts 2 / world-plan 1 / meet.ts 1） | 每一处都假定「一台」 |
| 单服务器状态位 | **63 处引用**：`lastMeetOk` / `poolProbe` / `nearbyProbe` / `presenceReported` / `reportFails` / `meetRetryAt` / `meetRetryStep` | 布尔＋单个对象，只能表达「一台好/坏」 |
| `src/meet.ts` | **15 个网络口**：`reportPresence` / `findNeighbors` / `reportFootprint` / `fetchFootprints` / `reportSignpost` / `fetchSignposts` / `sendInvite` / `listInvites` / `fetchStatus` / `myTakenInvites` / `acceptInvite` / `putCard` / `fetchCards` / `putProfile` / `fetchProfiles` | 一个地址一分账，多台就 15×N 次请求 |
| 文案 | `池子` 全仓命中 **52 处** | 「全城 N 只」在联邦下不成立 |
| 邀请配额 | 服务端按台算 3 发 1 接（`worker.js:526`、`1640`） | 多台时实际变成 3×N，反垃圾就漏了 |

---

## 3. 三条硬约束（决定了方案长什么样）

### 3.1 宿主 schema 做不出「字符串数组」

`/e/Coopanion/resources/app/build/cortico/src/core/config-schema.ts`：

- `:17` type 联合里有 `'array'`，但
- `:25` `items?: { type: 'integer' | 'number' }` —— **只允许数值**
- `:114-117` 读取时 `Array.isArray(raw) ? raw : [0,0]`，再 `Number()` 取前两位
- `:179-188` 校验要求 `raw.length === 2`，比大小顺序

也就是说 `array` 在设置页里是「区间值」（如某条价格区间），**不是「多个地址」**。想让设置页出现「加一条地址」的按钮，得改宿主，不在本扩展的能力范围内。

**结论：配置项继续留在 `type: 'string'`，多值用分隔符承载；类型层面写成 `string | string[]`，手改 `config.json` 写成数组也认。** 设置页是单行输入框，所以分隔符只认「空格 / 逗号 / 分号」（换行粘进去会被输入框吃掉）。

### 3.2 不许再用一个布尔概括多台

2026-11-20 修过的那条假断连，根因就是 `lastMeetOk` 一个布尔把「排表成功」「名单为空」「请求失败」压成一件事。多台之后这个错误会被放大 N 倍：一台挂，面板会说「没连上服务器」，而另外两台好好的。

**所以：状态必须按台存，文案必须说「哪座城没连上」。** 这是 L1 存在的唯一理由。

### 3.3 计数不能相加 —— 而且**客户端现在也没有去重的材料**

同一只鱼可以同时在两台服务器上报过到（两个社群都收录了她）。如果按台相加，面板上的「同城还有几个人」会凭空多出来。

**但「按 uid 去重」这句原来的写法是错的**（2026-11-21 复审修正）。查过协议：

- 邻居列表：`/sight` 的 SQL 是 `SELECT pet, doing FROM presence`，注释明写「防线设在最外层：漏不出 id 和时间戳」（`cloud/sight-cf/src/worker.js:2240-2284`）；客户端 `findNeighbors` 也只留 `{ pet, doing }`（`src/meet.ts:332-342`）。**响应里既没有别人的 uid，也没有 at。**
- 计数：`here` 与 `pool` 都是服务端算好的整数 `COUNT(DISTINCT uid)`（`worker.js:2268/2293`）。两台各回 `3` 和 `2`，客户端手里只有两个整数，**根本不知道里面有几只重合**。

所以 L2 有两条互斥的路，必须选一条：

| 方案 | 代价 | 隐私 |
|---|---|---|
| **A｜服务端加脱敏指纹** `fp = sha256(uid).slice(0,12)`，随每条邻居一起返回 | 改服务端 + 老服务端降级 | 可跨服去重，但多了一个稳定标识，需要明确它不能反查 |
| **B｜客户端按 `pet` 名去重，计数按台分报** | 不改服务端；重名会误合并 | 零新增暴露 |

**本方案选 B**，理由：昵称本来就可能是重名，误合并只影响一行文案；而引入一个跨服的稳定指纹，等于给「同一个人的多条记录」造了个连结键 —— 那是隐私层的新负债，为一行计数不值当。**结论：多台时不许出现任何「总共有 N 只」的表述，只能写「A 城 3 只、B 城 2 只」。**

---

## 4. P0 + L0：补丁与多值解析（现在做，约 60 行）

本节两块可以分开落地：**P0 那两块能独立修、独立发**（修的是今天就在骗人的地方），多值解析跟着下一版走。

### P0-A：全是非法地址 → 主面板亮绿灯

这不是多值引入的，是**今天就有**的（2026-11-21 复审查出）：

```
cfg.meetUrl = 'ftp://bad'        → configured = true（非空）
              meetOptions()      → normalizeMeetUrl 报错 → 返回 null
              所有请求跳过         → lastMeetOk 停在 null（初始值）
world-webui.ts:1115  online = this.lastMeetOk !== false   →  true
```

面板于是显示「同城 · 这段时间没别人」——**和「一切正常但没人」长得一模一样**。用户看着绿灯去等人，永远等不到。§6 用例 #6 要求「等同没填、面板给原因」，现在的实现正好相反。

**修法**：

```ts
// 不调 meetOptions() —— 它会在 render 路径里走 meetUid() 写盘。
// 抽一个纯函数，只解析、不生成 uid、不写任何文件：
meetUsable(): boolean {
  const raw = this.cfg.meetUrl;
  return meetBaseList(raw).bases.length > 0;   // 只解析，无副作用
}
```

- `world-webui.ts:1089` 的 `configured` 改成 `this.meetUsable()`；
- `world-webui.ts:1115` 的 `online` 改成 `this.meetUsable() ? this.lastMeetOk !== false : false`（或者干脆让 `social` 返回 `urlNote` 说明「地址读不成网址」，前端按「不可用」渲染，而不是「离线」）；
- `world-purse.ts:1066` 同样替换 —— 那处是「路上说不清谁在」的补充说明，地址压根不能用时不该说「这会儿没连上」，应该说「地址读不成」。

**为什么不能直接调 `meetOptions()`**：它末尾有 `this.meetUid()`，首次会读写 `meet-uid.txt`（`world-social.ts:237-244`）。`uiSnapshot()` 是渲染路径，每次开面板都调一次，不该在里面做文件 IO。

另外：拆分后必须 `.map(s => s.trim()).filter(Boolean)`，否则末尾多一个逗号会切出空项，被 `normalizeMeetUrl` 当成「没填」放行，混进 `bases` 里。

### P0-B：多地址提示要挂在主面板上

填了多台时，面板必须写「目前只连第一台：xxx」。**不许静默忽略** —— 用户填了第二条却一点反馈都没有，是下一个「怎么没生效」的来源。

**但这句话不能挂在 `urlFixed` 上**（2026-11-21 复审修正，原方案写错了）：

- `urlIssue` / `urlFixed` 只在 `method === 'profile'` 那一个分支返回（`world-webui.ts:766-767`），前端只在**「同行（名片）」子页签**里渲染（`dist/webui.js:1998-2003`），模板写死成 `profileUrlFixed = '地址已自动整理：{}。'`；
- 用户天天看的**主面板「她此刻」**（`uiSnapshot().social`，`world-webui.ts:1087-1133`）根本不读这两个字段。

后果是：填了两条，主面板一个字不提；点进名片页会看到「地址已自动整理：目前只连第一台…」—— 语义是错位的。

**改法**：`social` 里新增 `urlNote` 字段，前端在同城那一行下面单独渲染；`urlFixed` 只保留「地址被整理过」的原义，两句话分开写。

顺带核对过一条容易错的假设：宿主设置页读 `type: 'string'` 就是 `String(raw)`（`config-schema.ts:118`），所以手改 `config.json` 写成数组，即使先过一遍设置页读取，也会变成逗号串 —— 两条路都通。

### L0 改什么

```ts
// src/config.ts
/** 碰面服务器。单值字符串（设置页）或字符串数组（手改 config.json）。 */
meetUrl: string | string[];

/** 一次碰面最多连几台。写死，理由见 §5 L2 第 7 条与 §10。 */
export const MEET_MAX_TARGETS = 3;
```

```ts
// src/meet.ts
export interface MeetTargetsFix {
  /** 归一化后的地址，去重、截断到 MEET_MAX_TARGETS。 */
  readonly bases: string[];
  /** 被截掉/非法/重复的项，逐条给人看。 */
  readonly notes: string[];
  /** 一条都没有时的原因（空串＝没填，不是错）。 */
  readonly error: string;
}

export function normalizeMeetTargets(raw: unknown): MeetTargetsFix;
```

- 拆分：`Array.isArray(raw)` → 逐项；`string` → 按 `/[\s,，;；]+/` 切。
- 每一项复用现有 `normalizeMeetUrl(raw)`（`meet.ts:90`）—— 补 `https://`、去零宽、剪掉 `/sight/xxx` 与 `?` `#`，一个字都不重写。
- 去重键：`new URL(base).origin + pathname`（所以 `https://a` 与 `https://a/` 是同一条）。
- 超过 3 条：留前 3，`notes` 写「还有 N 个地址没连，一台电脑最多连 3 个城」。
- 全非法：`error` 写清是哪一条、为什么（沿用 `normalizeMeetUrl` 现有的报错文本）。

### L0 不改什么

- **19 处 `meetOptions()` 调用点一处都不动。** 它保留成薄壳：

```ts
meetOptions(): MeetOptions | null {
  const fix = normalizeMeetTargets(this.cfg.meetUrl);
  this.meetUrlError = fix.error;
  this.meetUrlFixed = fix.notes.join('；');
  if (fix.error || !fix.bases.length) return null;
  return { url: fix.bases[0], uid: this.meetUid(), pet: this.opts.botName };
}
```

- 多地址提示的口径见 §4 P0-B。`urlFixed` 不兼收这类提示。
- **配置键名不动**：仍是 `worlds.journey.meetUrl`（`config.ts:571`）。改名要迁移老配置，而 L0 的全部意义就是「一次都不迁」。
- **`urlIssue` / `urlFixed` 语义不动**：`world-webui.ts:766-767` 照旧，`urlFixed` 仍只放 `normalizeMeetUrl` 的整理说明，不再兼收「只连第一台」这类提示。

### 兼容性核查（全仓三处读取点）

| 位置 | 现在怎么写 | 改类型后是否安全 |
|---|---|---|
| `src/world-social.ts:127` | `String(this.cfg.meetUrl ?? '')` | 安全；数组会被拼成 `a,b`，正好落进分隔符分支 |
| `src/world-purse.ts:1066` | `String(...).trim() !== ''` | **不安全**，见 §4 P0-A |
| `src/world-webui.ts:1089` | `String(...).trim() !== ''` | **不安全**，见 §4 P0-A |

### 判据

- **P0**：新增两条测试 —— ① 全非法地址时 `social.online === false` 且带原因；② 填 2 条时主面板（`social.urlNote`）出现「只连第一台」。现有断言一条不改。
- **L0**：现有 **1195 条**测试全绿（97 个文件，基线 2026-11-21 实测 1195 过 0 失败），**一条断言都不用改**。
- `git diff` 里没有任何业务分支被改道。

---

## 5. L1 + L2：真多台（不排期）

### L1 状态按台（行为仍然不变）

```ts
interface MeetSiteState {
  base: string;
  ok: 'ok' | 'fail' | 'unknown';
  retryAt: number;      // 每台自己的退避位
  retryStep: number;
  pool: { at: number; n: number; day: string } | null;
  nearby: { at: number; here: number; cityId: string; day: string } | null;
  presence: { cityId: string; day: string } | null;
  fails: number;
}
// world: sites: Map<string, MeetSiteState>   —— 键是归一化后的 base
```

- `lastMeetOk: boolean` 删除，改为 `sites.get(base).ok`；面板文案取「全部 ok / 部分 fail / 全部 fail」三档。
- 退避按台：一台挂不该让另一台停止重试（这是 L1 唯一有实际行为改善的地方，但它只在多台时可见，单台与今天等价）。

### L2 遍历与聚合

1. **并行，不串行。** 现在单台超时 5 秒（`meet.ts:53`）；串行 3 台就是 15 秒，会拖住她的作息。改 `Promise.allSettled` + 总预算 5 秒，超时的台记 `fail`，不抛。
2. **15 个口分三类，不能一刀切。**（2026-11-21 复审修正，原方案写成「全部 per-target」是错的）

   | 类别 | 口 | 做法 |
   |---|---|---|
   | **广播类**（写自己的状态，发几份都等价） | `reportPresence` / `reportSignpost` / `putProfile` | 逐台发，各台自算成功 |
   | **查询类**（取回后合并） | `findNeighbors` / `fetchStatus` / `listInvites` / `fetchProfiles` / `fetchSignposts` | 逐台取，按 §5.3 合并 |
   | **单台类**（写一份契约，重复发会分叉） | `sendInvite` / `acceptInvite` / `putCard` / `fetchCards` / `myTakenInvites` / `reportFootprint` / `fetchFootprints` | **只发往指定的一台**，见下 |

3. **`sendInvite` 只能发往一台，绝不能广播。** 这是全篇最容易埋雷的一处：

   服务端每收到一次 `/invite` 就自己生成一个 `inviteId`。三台同时发，会得到**三个不同的 id**，指向三条互相独立的邀约。A 服的鱼接了第 1 条、B 服的鱼接了第 2 条，她本地只能认领一条 `pledge` —— 另一条必然被放鸽子，而且她**不知道**自己放过谁。

   **规则**：`sendInvite` 发往 `bases[0]`（首选台），或调用方显式指定的一台。目标鱼在哪台，就先查哪台的 `list` 里有没有这个名字。
4. **合并规则**：
   - 邻居：按 `pet` 去重，重复时留较新的一条并附 `via`（来自哪座城）。**不能按 uid** —— 服务端不返回（§3.3）；
   - `here` / `pool`：**按台分报，不求和**。文案写成「长安 3 只、洛阳 2 只」；单台时保持今天原话；
   - 邀约：跨台合并，同一条只出现一次。**合并键 `base + '|' + inviteId`**，且这个键只能用于**列表展示**。
5. **`Pledge` / `Ask` 必须持久化 `meetBase`。**（原方案漏了）

   现在 `Pledge` 只有 `inviteId`（`src/state.ts:135`），`Ask` 也只有 `inviteId`（`:196`）。三台里，这个 id 只存在于发出去的那一台 —— 几天后到了会合城，`matesHere` 判定、临别 `putCard` / `fetchCards` 全都要发回**那台**。不存 `meetBase`，就只能回头猜，或者静默丢名片。

   顺带一条：`meet.ts` 里有三处硬编码 `/^[a-f0-9]{16}$/`（`:613`、`:1089`、`:1142`），**合成键 `base|id` 传进去会被当场拒掉**。所以合成键只能活在合并后的展示层，所有网络调用必须还原成裸 `inviteId` + 独立的 `meetBase` 参数。

   （注：原报告说这里有个常量 `INVITE_ID_RE` —— 该常量不存在，是三处内联正则。结论不变。）
6. **文案口径**：单台保持今天的原话（不改，免得吓人）；多台写成「看得见的 3 个城 · 各自的人数」。**禁止**出现「全城」「总数」这类词 —— 方案 §4.18 约束①：没有全局视图。
7. **配额全局化**（L2 里最容易被漏的）：服务端按台算 3 发 1 接，多台等于 3×N。客户端自己记一本日账（`dataDir/meet-quota.json`，键 `date`），**第 4 条起拒发并说明**。配合第 3 条（只发首选台），这一条其实自动成立 —— 但仍要记日账，防止「换首选台」绕开。
8. **足迹只记本地**（方案约束③）：非首选目标一律不上报 `footprints`。`footprints` 是永久数据，跨城写会在两台上各留一份 `visits`，五期熟客定价就废了。

---

## 6. 边界与反例（每条都要有测试）

| # | 场景 | 期望 |
|---|---|---|
| 1 | `https://a` 与 `https://a/` 同时填 | 去重成一条 |
| 2 | 一台 500、一台正常 | 面板写「xx 城没连上」，另一台数据照显 |
| 3 | 两台都报同一只鱼 | 邻居按 `pet` 去重；**计数不合并**，分报「a 城 1 只、b 城 1 只」 |
| 4 | 地址粘成 `…/sight/status` | 剪到根（复用现有逻辑） |
| 5 | 填了 5 条 | 只用前 3 条 + 明确提示 |
| 6 | 全部非法（`ftp://bad`） | **主面板不亮绿灯**，写明「地址读不成网址」；`social.online` 必须是 `false` |
| 7 | 老配置单值 | 行为逐字不变 |
| 8 | 两台各发 3 条邀约 | 第 4 条起客户端拒发 |
| 9 | 一台 5 秒不回 | 总耗时 ≤ 5 秒（并行），不拖作息 |
| 10 | N=1 | 文案里不出现「个城」 |
| 11 | 填了 2 条 | 主面板（不是名片页）出现「目前只连第一台」 |
| 12 | 串尾多一个逗号 `https://a,` | 不切出空项，不误判为「没填」 |
| 13 | 三台都发 `sendInvite` | **不可能** —— 实现里只发一台，测试断言只产生一个 `inviteId` |
| 14 | 接下邀约后跨过 2 天再去会合城 | `matesHere` 发回原台（`Pledge.meetBase`），不是 `bases[0]` |
| 15 | 合成键 `base\|id` 传进 `acceptInvite` | 不可能发生；网络层只收裸 16 位 id |

---

## 7. 验收判据

- **L0**：1195 条全绿、零断言改动；`git diff` 不含业务分支；手改 `config.json` 写成数组能正常读；**用例 #6 / #11 / #12 新增测试**。
- **L1**：单台场景的输出与今天逐字相同（用现有快照对拍）。
- **L2**：新增单测覆盖上表 15 条；沿用历次 144 天模拟的口径跑一次长跑，请求数 ≤ 3× 且不触额度；单台用户的界面文案与今天相同。

---

## 8. 明确不做

- **目录托管**（F1 的「一份目录说明哪些城在哪」）—— 要一个稳定地址、收录规则、下线处理，另立一项。现在 `landingPage()` 只发本机地址与在线数（`worker.js:1593-1700`），没有列表。
- **服务器间同步 / 签名 / 吊销 / 冲突解决（F2）** —— 方案已定不做。
- **`homeTown` 切换、跨城拜访全流程、跨城足迹合并** —— 等第二个社群出现才知道该按什么分。

---

## 9. 需要你拍的三件事

1. **上限几台？** 我建议 3（够「自己的城 + 两座想去逛逛的城」，且 15 口 × 3 已经是 45 次/轮的放大）。写死，不跟配置。
2. **邀请配额按全局还是按台？** 我建议全局（客户端日账）。按台的话，联邦一开，一天能发 3×N 条。
3. **P0 和 L0 分开发。** 建议：P0（假绿灯 + 主面板提示）**现在修、可以单独发一个小版本** —— 它修的是今天就在骗人的东西，跟联邦无关；L0（多值解析）**不单发**，跟着下一版功能一起出去，因为它今天换不来任何可见好处，只换「以后不用迁配置」。

---

## 10. 风险

| 风险 | 处理 |
|---|---|
| 请求放大 N 倍 | 上限 3 + 只在「到站 / 开面板 / 找伴」三个时机打，不逐 tick |
| 文案 52 处改漏 | 只改「计数口径」那 6 处核心，其余按需；改完用 N=1 快照对拍 |
| 「总数」语义被误解 | 多台时统一改口径，并在面板写「你能连到的城」，不写「全城」 |
| L0 变成永久的半成品 | 面板明确写「目前只连第一台」，让人一眼看出这是留位置，不是做完了 |
| 多台发邀约放鸽子（**新增**） | `sendInvite` 只发一台 + `Pledge.meetBase` 持久化 + 用例 #13/#14 |
| 合成 id 撞上 16 位正则（**新增**） | 合成键不出展示层；网络层只收裸 id（用例 #15） |
| 跨台计数假装能去重（**新增**） | 按 §3.3 选 B：按台分报，绝不求和 |

---

## 11. 复审记录（2026-11-21）

外部审查共 5 条，逐条核过源码：

| # | 审查意见 | 核实结果 | 处理 |
|---|---|---|---|
| 1 | 「只连第一台」挂在 `urlFixed` 上，主面板看不到 | **成立**。`urlIssue`/`urlFixed` 只在 `profile` 分支返回（`world-webui.ts:766`），前端只在名片页渲染（`webui.js:1998`），`social`（`:1087`）不读 | §4 改为 `social.urlNote`，两句话拆开 |
| 2 | 全非法地址时主面板亮绿灯 | **成立**。`configured` 判非空 → `meetOptions()` 返回 null → `lastMeetOk` 停 null → `online = lastMeetOk !== false` = true（`world-webui.ts:1115`） | §4 P0-A，`meetUsable()` 无副作用判据 |
| 3 | 服务端不返 `uid`，客户端无法去重邻居/计数 | **成立**。`/sight` 只 `SELECT pet, doing`（`worker.js:2240`），`here`/`pool` 是整数 `COUNT(DISTINCT uid)` | §3.3 重写，选 B（按台分报） |
| 4 | `Pledge`/`Ask` 要存 `meetBase`，合成键会被 16 位正则拒 | **成立**（细节有误，见下）。`Pledge` 无 `meetBase`（`state.ts:118-145`），三处内联 `/^[a-f0-9]{16}$/`（`meet.ts:613/1089/1142`） | §5 L2 第 5 条 |
| 5 | `sendInvite` 不能广播，否则多台各生成 id 导致放鸽子 | **成立**。每次 `/invite` 服务端独立生成 id，本地只认一条 `pledge` | §5 L2 第 3 条 |

**两处审查说错了**：

1. **`INVITE_ID_RE` 这个常量不存在。** 审查写「`meet.ts:703` 有硬正则 `INVITE_ID_RE`」—— `meet.ts` 里没有这个标识符，实际是三处内联正则（`:613`、`:1089`、`:1142`）。**结论不受影响**（合成 id 照样被拒），但行号和常量名都对不上，照着改会扑空。
2. **修法不能直接调 `meetOptions()`。** 审查建议「改调 `this.meetOptions() !== null`」—— `meetOptions()` 末尾有 `this.meetUid()`，首次会读写 `meet-uid.txt`（`world-social.ts:237`）。`uiSnapshot()` 是渲染路径，不该在里面做文件 IO。所以改成抽纯函数 `meetUsable()`。

**审查没提到、我补的一条**：`pool` 走 `poolAndOnline()` 的 1 分钟缓存，`here` 是实时查询（`worker.js:2262-2276`）。两个数新鲜度不同，跨台摆在一起时不能暗示它们同一时刻 —— 文案里别写「此刻共 N 只」。
