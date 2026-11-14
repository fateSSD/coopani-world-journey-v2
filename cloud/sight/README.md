# 碰面服务器 · 部署说明

给「她到站看一眼这儿还有谁」和「同城谁想找人一起走一段」用的。**一个人一套**，不用互通。

代码两个文件：`index.js`（云函数）+ `package.json`（依赖）。
数据库是 **PostgreSQL**，三张表：`presence` / `invites` / `rate`。

> 一个函数挂三条 HTTP 路径（`/sight`、`/sight/invite`、`/sight/accept`），
> 由 `index.js` 按路径分派。**路径名是扩展写死的**，别改名。

---

## 一、开环境（约 5 分钟）

1. 打开 https://cloudbase.net/ ，用微信或 QQ 登录；
2. 点「开通云开发」→ 选 **免费版**（3,000 资源点/月，够几十个人用）；
3. 实名认证（个人就行，身份证号）；
4. 环境名随便起，比如 `coopani`，地域选**离你最近**的（上海/北京）；
5. 等 3–5 分钟，环境建好。

> 免费版**每 6 个月要手动续一次**，到期前会提醒。忘了也不会有账单，只是服务停掉。

---

## 二、建表（2 分钟）

控制台 → **数据库（PostgreSQL）→ SQL 执行**，把 [`schema.sql`](schema.sql) 整段贴进去跑一次
（三张表：`presence` / `invites` / `rate`）。

> **不要在控制台的「集合」里建。** 那是文档型数据库，这个环境没开
> （`tcb db nosql` 会直接报「当前环境未开通文档型数据库」），
> 而代码走的是 `app.rdb()` —— 它只认 PostgreSQL 的表。

老版本（0.5.29–0.5.47）只用 `presence` 一张表。升级上来时把整段跑一次就行，
全是 `if not exists`，已经有表不会被动到。

> 2026-11-05 实际应用过（migration `20261105090517_sight_invite_tables`），
> 三张表已在线上。

---

## 三、建云函数（3 分钟）

控制台 → **云函数** → 新建：

| 项 | 填什么 |
|---|---|
| 函数名称 | `sight` |
| 运行环境 | **Node.js 18**（或更高） |
| 内存 | 128 MB 够 |
| 超时 | 10 秒够 |

建好之后，把本目录的两个文件传上去（「代码管理」里可以直接编辑/上传）：

- `index.js`
- `package.json`

然后点「**云端安装依赖**」—— 它会自己装 `@cloudbase/node-sdk`（要 **3.x**，
2.x 没有 `rdb`，运行时报 `app.rdb is not a function`）。

> 本地不用 `npm install`，也不用打包。

**线上这台的实际配置（2026-11-05 核对过）**：

| 项 | 值 |
|---|---|
| 运行时 | Nodejs20.19 |
| 入口 | `index.main` |
| 超时 | **10 秒**（原来是 3 秒。冷启动 + PostgREST 往返 3 秒不够，现改成 10） |
| 内存 | 256 MB |
| 云端安装依赖 | 开 |

> 超时不要低于 5 秒：一次邀约要打两次库（读 + 条件更新 + 回读），冷启动那一下
> 3 秒会超时 —— 表现是「偶尔发不出去」，而不是每次都失败。

---

## 四、开 HTTP 访问（5 分钟）

云函数页面 → **HTTP 访问服务** → 开启 → 绑定到 `sight` 这个函数。

```text
https://<你的环境id>.service.tcloudbase.com/sight
```

**这个地址就是设置里要填的那一项**（带不带末尾的 `/sight` 都认，代码两种都处理）。

### 要不要额外加 `/sight/invite` 和 `/sight/accept` 两条路径

**不用加。2026-11-05 已在线上验过**：`coop-pet-journey` 这个环境只配了 `/sight` 一条路由，
但打 `/sight/invite` 能直接进到函数、拿到函数自己回的 JSON ——
也就是说腾讯云的 HTTP 访问服务按**前缀**把子路径转给了同一个函数。

验法（一条 GET 就够）：

```bash
curl "https://<环境id>.app.tcloudbase.com/sight/invite?city=xian&uid=<24位hex>"
# 回 {"ok":true,"list":[]}          → 通了
# 回 {"ok":false,"error":"bad query"} → 也是通的，只是代码还是只实现碰面的旧版
# 回 HTML / 404                     → 才需要去「HTTP 访问服务 → 路由」补两条
```

**代码本身也不依赖路径。** 万一某个网关把子路径裁成了 `/sight`，
`routeOf()` 会按请求的形状分派：POST 带 `from`+`to` 就是发邀约、带 `id` 就是接、
GET 带 `uid` 不带 `date` 就是看邀约（碰面那组必须有 `date` 和 `slot`）。
所以路由加不加功能都能跑 —— 加上只是更快更清楚。

---

## 五、填进扩展（1 分钟）

Cortico → 扩展 → 环游世界 → 设置 →「她的日子」→ **碰面（和其他宠物在同一处）**

把地址粘进去，保存。

---

## 六、验证

### 碰面

1. 她的下一次**到站**或**跨天**会触发一次上报；
2. 面板的「第 N 天」那条消息末尾，如果同城同时段有别人，会多一句：
   > 小满和阿七也在这儿，一个吃面，一个逛夜市。

### 邀约

让她待在某座城里，然后对她说「看看这儿有没有人想一起走」——
她会调 `journey_accept`（不带 id），把同城挂着的邀约列出来。

想自己验通不通，直接打接口更快：

```bash
# 发
curl -X POST "https://<环境id>.service.tcloudbase.com/sight/invite" \
  -H "content-type: application/json" \
  -d '{"uid":"0123456789abcdef0123","pet":"测试鱼","from":"xian","to":"lasa","days":2,"note":"想看雪山"}'

# 看（换个 uid 当「别人」）
curl "https://<环境id>.service.tcloudbase.com/sight/invite?city=xian&uid=ffffffffffffffffffff"

# 接
curl -X POST "https://<环境id>.service.tcloudbase.com/sight/accept" \
  -H "content-type: application/json" \
  -d '{"uid":"ffffffffffffffffffff","id":"<上面返回的 id>"}'
```

**只有你一个人用时，这些永远不会有人回应** —— 那是正常的，不是坏了。

---

## 七、接口长什么样

```http
POST /sight
{ "uid": "...", "pet": "大肥鱼", "city": "xian", "date": "2026-11-04",
  "slot": "evening", "doing": "吃面" }
→ { "ok": true }

GET /sight?city=xian&date=2026-11-04&slot=evening&exclude=<自己>&limit=3
→ { "ok": true, "list": [ { "pet": "小满", "doing": "吃面" } ] }

POST /sight/invite
{ "uid": "...", "pet": "大肥鱼", "from": "xian", "to": "lasa", "days": 3, "note": "想看雪山" }
→ { "ok": true, "id": "abcdef0123456789" }

GET /sight/invite?city=xian&uid=<自己>
→ { "ok": true, "list": [ { "id": "...", "pet": "小满", "to": "lasa", "days": 3, "note": "..." } ] }

POST /sight/accept
{ "uid": "...", "id": "abcdef0123456789" }
→ { "ok": true, "with": "小满", "to": "lasa", "days": 3, "note": "..." }
```

`slot` 只有四个值：`morning` / `afternoon` / `evening` / `night`。
`days` 是「在那儿待几天」，夹在 1–30。

**碰面返回里永远只有 `pet` 和 `doing` 两个字段。** 这是设计，不是偷懒 ——
没有 id 就没有加好友的可能，没有时间戳就查不出别人的轨迹。
**邀约返回里也永远没有发起者的 uid**，只给名字和「想去哪」。
接了之后也**不通知发起方**：24 小时自己过期，「发了没人应」不该构成一次社交失败。

限额：一天发 3 条、接 1 条。想改就改 `index.js` 顶上那两个常量。

---

## 八、出问题怎么看

| 现象 | 先看这里 |
|---|---|
| 一直没有「谁也在这儿」 | 两个人是不是**同城 + 同日 + 同时段**；`slot` 是不是对得上 |
| 邀约说「这台服务器上还没有邀约功能」 | HTTP 访问服务里是不是只加了 `/sight`，缺 `/sight/invite` 和 `/sight/accept` |
| 报错 500 + 日志里 `relation "invites" does not exist` | 第二节那段 SQL 没跑，或者跑在另一个环境的库上 |
| 报错 500 + 日志里 `app.rdb is not a function` | `@cloudbase/node-sdk` 装成了 2.x，`package.json` 要 `^3.18.7` 并重新「云端安装依赖」 |
| 报错 400 | 字段格式不对（uid 必须是 20–64 位十六进制，date 必须是 `YYYY-MM-DD`，id 必须是 16 位十六进制） |
| 邀约发了没人接 | 正常的。只有**同一座城里**的人看得见，而且 24 小时就过期 |
| 完全没反应 | 设置里的地址是不是少了协议头 `https://` |

---

## 九、成本

免费版 3,000 资源点/月（1,000 点 ≈ 1 元）。

一次碰面 = 一次上报 + 一次查询 ≈ 2–5 点；一次邀约多两组读写。
**够几百人用一个月。**

真用超了，个人版 19.9 元/月。
