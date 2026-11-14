# 碰面服务器 · Cloudflare Workers 版

给「她到站看一眼这儿还有谁」用的。**接口和腾讯云开发版完全一样**，客户端一行都不用改，
只换设置里那个地址。

> **本机已经部署好了（2026-11-05）：**
> 正式地址 `https://cooppetsjourney.top`（绑在 Worker `coop-sight` 上）；
> D1 `coop-sight` = `adeb1aa9-e114-4c44-8b42-3e9adba71237`；zone = `9de62840127b8fb715baa5273e7c175f`。
> **`*.workers.dev` 在国内被 DNS 污染，不要用那个地址** —— 详细经过和重新部署命令见
> `PROGRESS.md` §9.1。下面的步骤是「从零再来一遍」用的。

---

## 为什么有这一版

腾讯云开发免费版一个月 3000 资源点，**大约只够 1000 次调用**。

一万用户里只要有 2000 人开了碰面，一天就是一万两千次请求 —— 免费额度撑不到两小时。

| | 腾讯云开发免费 | Cloudflare 免费 |
|---|---|---|
| 请求 | ≈1000 次/月 | **300 万次/月**（10 万/天） |
| 写入 | 同上 | D1 10 万行/天 |
| 差距 | — | **约 1000 倍** |

### ⚠️ 一个必须知道的坑

**只能用 D1，不能用 KV。**

Cloudflare KV 免费只给 **1000 次写入/天**。一次上报写一条，两千人就爆了。
D1 免费 10 万行写入/天，同样的量只占 6%。

---

## 部署（约 10 分钟，不需要信用卡）

### 1. 注册并登录

```bash
npx wrangler login
```

浏览器会弹出来，用 Cloudflare 账号授权（没有就现场注册，免费）。

### 2. 建数据库

```bash
npx wrangler d1 create coop-sight
```

输出里会有一行 `database_id = "xxxx-xxxx-..."`，**复制它填进 `wrangler.toml`**。

### 3. 建表

```bash
npx wrangler d1 execute coop-sight --remote --file=./schema.sql
```

### 4. 部署

```bash
npx wrangler deploy
```

输出会给你一个地址：

```
https://coop-sight.<你的子域>.workers.dev
```

### 5. 填进扩展

设置 → 环游世界 →「她的日子」→ **碰面（和其他宠物在同一处）**，把地址粘进去。

不用带 `/sight`——扩展会自己补（`meet.ts` 的 `endpointOf()` 处理过，
带完整 `/sight` 也不会拼成 `/sight/sight`）。

---

## 自测（部署完先自己验一遍）

```bash
# 上报一条
curl -X POST "https://coop-sight.xxx.workers.dev/sight" \
  -H 'content-type: application/json' \
  -d '{"uid":"0123456789abcdef0123456789abcdef","pet":"测试鱼","city":"xian","date":"2026-11-05","slot":"evening","doing":"吃面"}'

# 查一下（应该能查到自己）
curl "https://coop-sight.xxx.workers.dev/sight?city=xian&date=2026-11-05&slot=evening"
```

返回 `{"ok":true,"list":[...]}` 就通了。**注意：连着发两次不会 429** —— 同一格重复上报是
upsert，天然幂等，限速管的是「一天里报了多少次」，不是「两次之间隔了几秒」（原因见下）。

---

## 这一版加的三道闸

旧版没有任何防刷。五个人的时候无所谓，**一万人的时候 uid 是本地随机的，谁都能伪造**。

| 闸 | 规则 | 为什么这么定 |
|---|---|---|
| 一个宠物 | 一天最多 **50 次** | 正常人一天 4–8 次（早/午/晚/夜 + 换城市），50 是给反复调试留的余量 |
| 一个出口 IP | 一天最多 **2000 次** | 公司 NAT 五十人一天也就一千二，不会误伤 |
| 全站 | 一天 **2 万次**，超了 503 | 应急开关。**按行算**：2 万次 × 4 行 = 8 万行，D1 免费 10 万行/天 |

改这三个数在 `src/worker.js` 顶部的常量区。

### 全站那道为什么是 2 万，不是 8 万

D1 免费额度的单位是**行**（10 万行写入/天），不是请求数。一次上报写 4 行：
`presence` 一条 + `rate` 三条。

第一版直接拿「8 万次」当上限 —— 那是旧版 `COUNT(*) FROM presence` 的口径，
一次只写 1 行。换成计数表之后每次写 4 行，**同样 8 万次就是 32 万行，超额度三倍**。

阈值没变，但它的单位偷偷变了。现在按行算再除以行数：

```js
const DAILY_ROW_BUDGET = 80_000;                    // 10 万额度留 20% 给清理
const ROWS_PER_POST = 4;                            // presence 1 + rate 3
const DAILY_WRITE_CAP = DAILY_ROW_BUDGET / ROWS_PER_POST;   // = 20000
```

### 这笔账意味着什么

按「2000 个活跃用户 × 一天 8 次」算：

| 项 | 行数 |
|---|---|
| presence 写入 | 1.6 万 |
| rate 写入 | 4.8 万 |
| 定时清理（删 4 天前那天） | 1.6 万 |
| **合计** | **8 万 / 10 万（80%）** |

**免费版大约能撑 2000 个活跃用户。** 一万用户里渗透率超过 20% 就该考虑付费版
（$5/月，1000 万行写入），或者把上报频率再压一压。这是硬账，不是估算。

### 为什么是「按天」而不是「间隔 20 秒」

第一版写的是「同一个 uid 两次上报至少隔 20 秒」，跑起来发现两个毛病：

1. **粒度错了。** 她同一天换城市、换时段各报一次是**合法的**，但按 uid 算间隔会把
   这些正常上报一起挡掉；而客户端是 `void` 调用（不 await），挡了没人知道 —— 那一格就静默缺了。
2. **防重复本来就不需要它。** 写入是 upsert（主键 `uid+city+date+slot`），
   重复报同一格只是覆盖同一个值，天然幂等。真正要防的是「刷出大量不同的格」。

### 为什么不用 `COUNT(*)`

第一版三条闸全是 `SELECT COUNT(*) FROM presence WHERE ...`。执行计划很漂亮
（走 covering index，没有全表扫描），但**走索引不等于不花钱** —— `COUNT` 范围内有多少行
就要读多少行。

实测（8 万行表）：

| 方案 | 1000 行 | 1 万行 | 8 万行 |
|---|---|---|---|
| 三条 `COUNT` | 0.06 ms | 0.46 ms | **3.69 ms** |
| 计数表 | 0.22 ms | 0.21 ms | **0.22 ms** |

本地 SQLite 3.69 ms 不算什么，但 **D1 按行读取计费**：8 万行表上每次 POST 读 8 万行，
免费版一天 500 万行读取，**62 次上报就烧光**。

也就是说：那道「防止刷爆额度」的闸，本身就是最大的刷子。换成计数表后一次判定读 1 行、
写 3 行，跟表大小无关。

### 计数表会撑爆吗

不会。key 里带日期（`u:<uid>:<day>`），同一个用户每天复用同一行 ——
这张表的大小约等于「用户数 + IP 数」，不随天数增长。跨天换 key 就是从 1 重新数。

**还没做的**：真正的身份认证。彻底的做法是客户端生成 token 做 HMAC 签名，
但那要改客户端。表里已经留了 `token_hash` 字段，以后升级不用改表结构。

---

## 定时清理（不加会慢慢撑爆存储）

`wrangler.toml` 底部的 `[triggers] crons` 每小时调一次 `scheduled()`：

- 删 **4 天前**的 `presence`（查询只用到今天和昨天，留四天很宽松）
- 删过期的 `rate` 行

每次最多删 5000 行（分批，别让单次执行太久）。一小时五千行 = 一天十二万行清理能力，
覆盖最坏情况（五万行/天）绰绰有余。

**不加这一行也能跑**，但表会一直长：一天五万行、一个月一百五十万行，
免费版 5 GB 存储撑不到年底。

```bash
# 手动跑一次清理（想立刻验证的话）
npx wrangler d1 execute coop-sight --remote \
  --command "DELETE FROM presence WHERE date_key < date('now','-4 day')"
```

---

## 邀约：让她自己发起「有没有人一起去」（服务端已就绪）

碰面是「同一时段在同一座城」才算遇上。邀约是另一件事：**她想去某地，问一句有没有人一起。**

设计和碰面共用一条底线 —— **服务端不懂语义**。它只存「谁、从哪、想去哪、几天、一句话」
和「这条被谁接了」。想不想去、凭什么判断、要不要回应，全在模型那边。

```
POST /sight/invite   { uid, pet, from, to, days, note }   → { ok, id }
GET  /sight/invite?city=<我在的城市>&uid=<我>              → { ok, list: [...] }
POST /sight/accept   { uid, id }                          → { ok, with, to, days, note }
```

**三条设计上的硬规矩：**

1. **24 小时自动过期，不通知发起者结果。** 不回应就是没看见 ——
   「A 发了没人应」不该构成一次被拒绝。几口人的小圈子撮合成功率本来就低，
   不能让每次失败都有代价。
2. **返回里没有发起者的 uid。** 跟碰面同一条线：能看见，摸不着。
3. **`note` 是整个系统里唯一一段自由文本**，所以它是过滤最该管的地方 ——
   这也是「邀约必须先有内容安全才能做」的原因。被判定为广告就留空，不拒绝整条邀约。

限额：一个宠物**一天最多发 3 条、接 1 条**（接多了是赶场，不是一起玩）。

接受用的是条件更新 `UPDATE ... WHERE taken_by = ''` —— 两个人同时接同一条时，
只有一个能改到行，另一个拿到 409。**不要改成「先查再写」**，那样并发下两个人都以为自己接上了。

> ⚠️ **客户端还没接。** 现在服务端能用、有测试，但扩展那边还没有
> `journey_invite` / `journey_accept` 两个工具。见仓库 CHANGELOG 0.5.47 的「下一步」。

---

## 管理接口（只读，可选）

`site/admin.html` 靠它看线上数据。**不配密钥时整条 `/admin/*` 是 404** ——
默认关闭，不是默认开放。

```bash
npx wrangler secret put ADMIN_KEY      # 设一个长随机串
npx wrangler deploy
```

| 接口 | 返回 |
|---|---|
| `GET /admin/stats` | 今日上报次数、宠物数、格子数、预算用量、城市分布、表总行数 |
| `GET /admin/list?city=&slot=&limit=` | 明细（uid **打码**成 `abcd…ef01`） |

**只读**：接受 GET，其他一律 405。封禁和清理走 `wrangler d1 execute` ——
网页上不留写入口，少一个能把线上数据搞坏的地方。

密钥用 `x-admin-key` 头传，不用挂 URL 上（URL 会进日志）。
CORS 里已经放行了这个头 —— **漏了的话症状是「密钥明明对了却一直连不上」**，
因为预检就被浏览器拦了。

`uid` 在返回里是打码的：页面上够定位，截图发给别人也不泄露完整标识。

---

## 小范围试点建议

你要先试，那就按这个顺序来：

1. **先自己两个实例**（两份数据目录，出发地设成同一座城），确认「谁也在这儿」那句真能出来
2. **再拉 3–5 个人**，观察一天：`wrangler tail` 看日志，控制台看请求数
3. **看真实渗透率**再决定要不要推广 —— 一万用户里愿意开社交的可能远少于预期

**看用量的地方**：Cloudflare 控制台 → Workers & Pages → `coop-sight` → Metrics；
以及 D1 → `coop-sight` → 表行数。

---

## 和旧版的关系

- `cloud/sight/`（腾讯云开发版）**保留不动**，已经在用的用户不受影响
- 这一版是**替代**，不是并行 —— 两套服务不互通，用户选一个填
- 表结构比旧版多了 `ip_hash`、`token_hash` 两列，以及一张 `rate` 计数表
- **接口完全一样**，客户端只换地址

---

## ⚠️ 如果你跑过旧的 schema.sql

这一版给限速加了 `rate` 表。**跑过旧版的话必须再执行一次 `schema.sql`**
（里面全是 `CREATE ... IF NOT EXISTS`，重复执行安全，不会动已有数据）：

```bash
npx wrangler d1 execute coop-sight --remote --file=./schema.sql
```

不跑的话每次上报都会 500 —— `no such table: rate`。

### 0.8.8（2026-11-07）：两列新字段，顺序不能反

邀约表加了两列：`meet_city`（在哪儿碰头）和 `pace`（对方的世界流速）。

```bash
npx wrangler d1 execute coop-sight --remote --file=./migrate-2026-11-07-meet.sql
```

**先跑这段 SQL，再 `wrangler deploy`。** 反过来（先部署代码）的话，
`/sight/invite` 和 `/sight/status` 会去查还不存在的列，一路 500 ——
而客户端看到的是「没连上碰面服务器」，指不到真正的原因上。

SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会报 `duplicate column name`。
那是**已经跑过了**，忽略即可，不是失败。

---

## 管鱼面板（2026-11-05 加）

`site/pets.html` 那个页面。**它不是连腾讯云函数，是连这个 Worker。**

面板要三样东西才活得起来，缺一样就报「连不上」：

| 缺什么 | 表现 | 怎么补 |
|---|---|---|
| Worker 没部署最新代码 | `/admin/pets` 回 **404** | `npx wrangler deploy` |
| 没设 `ADMIN_KEY` | 整条 `/admin/*` 都回 **404**（代码里就是这么写的：没配 = 不存在） | `npx wrangler secret put ADMIN_KEY` |
| 没建 `pet_flags` 表 | 能列鱼，但封禁报 500 | 跑一遍 `schema.sql` |

四条命令，在 `cloud/sight-cf/` 目录下：

```bash
npx wrangler login                                                    # 只需一次
npx wrangler d1 execute coop-sight --remote --file schema.sql        # 建 pet_flags（幂等）
npx wrangler secret put ADMIN_KEY                                     # 粘贴面板里要填的那串
npx wrangler deploy                                                   # 上传 Worker
```

> 顺序别反：先建表、再设 key、最后部署。表没建就部署，面板能列鱼、封禁会 500；
> key 没设就部署，面板连不上 —— 而它的提示会明说「404，可能没部署或没设 key」。

面板上填的地址填**根**或带 `/sight` 都行（`https://cooppetsjourney.top`），
密钥就是 `ADMIN_KEY` 那一串。

### 三个动作分别做什么

| 动作 | 写进去的 kind | 行为 |
|---|---|---|
| 请她改名 | `rename` | 照常上报，回执多一句 `notice: 'rename'`，客户端可转成提醒 |
| 封禁 | `ban` | 上报 403、发邀约 403 —— **两条路都挡**，池子里立刻没有她 |
| 解除 | 删行 | 立刻恢复 |

封禁不是删除：`presence` 一行不动，只是 `pet_flags` 里多一行。
