/**
 * 前端产物冒烟测试。
 *
 * 面板跑在浏览器里，Node 这边没法「看」。但**白屏是最差的失败方式**：
 * 用户在页面上看到的是一片空白，日志里什么都没有。
 *
 * 所以这里用一套最小 DOM 桩把 `dist/webui.js` 真的跑一遍：造节点、调 invoke、走渲染。
 * 桩只实现用到的那几个方法 —— 它不验证样式，只验证**不崩、不空、文案在**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- 最小 DOM 桩 ---------------- */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    /** 注册过的事件回调。原来这里是纯空桩，2026-11-01 要验「点了复制什么」才改成记录。 */
    this.handlers = {};
    this.style = {};
    this.hidden = false;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === 'string') this.children.push(new FakeNode('#text'));
      else this.children.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(type, fn) {
    // 桩仍然不会自己触发；测试手动调 `node.handlers.click[0]()` 来验副作用。
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
  }
  get text() {
    if (this.children.length === 0) return this.textContent;
    return this.children.map((c) => c.text ?? '').join('');
  }
  /** 深搜第一个满足条件的节点。 */
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find?.(pred);
      if (hit) return hit;
    }
    return null;
  }
  all(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.all?.(pred, out);
    return out;
  }
}

function installDom() {
  const prev = globalThis.document;
  /*
   * `navigator` 在 Node 22 里是只读 getter，直接赋值会抛
   * （"Cannot set property navigator of #<Object> which has only a getter"）。
   * 所以改属性描述符，restore 时按原描述符放回去。
   */
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  /*
   * 剪贴板桩。复制是这个功能唯一真实的副作用，得能看见它复制了什么 ——
   * 否则「点了有反应」和「点了个 air」在测试里长得一模一样。
   */
  globalThis.__copied = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { clipboard: { writeText: (v) => { globalThis.__copied = String(v); return Promise.resolve(); } } },
  });
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (s) => {
      const n = new FakeNode('#text');
      n.textContent = String(s);
      return n;
    },
  };
  return () => {
    globalThis.document = prev;
    if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc);
    else delete globalThis.navigator;
    globalThis.__copied = '';
  };
}

/* ---------------- 假的 snapshot ---------------- */

const snapshot = {
  dateKey: '2026-10-31',
  clock: '19:50',
  tzLabel: 'UTC+8',
  clockDriftMs: 0,
  weatherOutOfRange: false,
  mode: 'traveling',
  place: { id: 'lanzhou', name: '兰州', region: '甘肃', tz: 'Asia/Shanghai', lat: 36.06, lon: 103.83 },
  feeling: '干，跟家里一个味道，一下就习惯了。',
  weather: '',
  leg: {
    from: '兰州', to: '天水', mode: '火车', km: 238, hours: 2.8,
    progress: 51, left: '1 小时 23 分', eta: '21:13',
  },
  lodging: null,
  sunrise: null,
  timeline: [{ at: '21:13', what: '到天水', kind: 'arrive', past: false }],
  trip: { days: 1, visited: 0, spent: 0, budget: 2000, moneyOn: false },
  diary: { dir: '/tmp/diary', days: 0, problem: null },
  photos: [],
  home: '兰州',
  speed: 1,
  guideSeen: false,
  version: '0.5.2',
  // 默认不发反馈栏 —— 没配邮箱就等于没有这一栏，测试基线也照这个来
  feedbackEmail: '',
};

function makeCtx(root, invoke) {
  return {
    pageId: 'world:journey',
    panelId: 'now',
    language: 'zh',
    root,
    signal: { aborted: false, addEventListener() {} },
    invoke,
    invokeBinary: async () => new Blob(),
    pickPath: async () => null,
    setConfig: async () => '',
    interval: () => ({ dispose() {} }),
    timeout: () => ({ dispose() {} }),
    frame: () => ({ dispose() {} }),
    own: (d) => d,
    memo: { get: (_k, f) => f, set() {} },
    guardLeave: () => ({ dispose() {} }),
    scope: {},
    mountSlot: async () => ({ dispose() {} }),
    ui: {},
    refresh: async () => {},
  };
}

test('前端产物：能加载，且导出两个面板', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    assert.ok(bundle && typeof bundle === 'object', '没有 default 导出');
    assert.ok(bundle.panels, '没有 panels');
    assert.equal(typeof bundle.panels.now?.mount, 'function', '缺「她此刻」面板');
    assert.equal(typeof bundle.panels.album?.mount, 'function', '缺「照片」面板');
  } finally { restore(); }
});

test('前端产物：第一次打开会渲染引导，且城市和时刻都在', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    let dismissed = false;
    const ctx = makeCtx(root, async (method) => {
      if (method === 'dismissGuide') { dismissed = true; return { ...snapshot, guideSeen: true }; }
      return snapshot;
    });
    await bundle.panels.now.mount(ctx);

    const text = root.text;
    assert.match(text, /兰州/, '城市名没渲染出来');
    assert.match(text, /19:50/, '当地时刻没渲染出来');
    assert.match(text, /天水/, '目的地没渲染出来');
    assert.match(text, /第一次来/, '新手引导没出现');
    assert.match(text, /21:13/, '时间轴没渲染出来');
    // 引导必须能被点掉（桩里不触发事件，只验按钮在）
    assert.ok(root.find((n) => n.tagName === 'BUTTON'), '引导没有「知道了」按钮');
    assert.equal(dismissed, false);
  } finally { restore(); }
});

test('前端产物：看过引导之后不再出现', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...snapshot, guideSeen: true }));
    await bundle.panels.now.mount(ctx);
    const guide = root.find((n) => String(n.className).includes('jr-guide'));
    assert.ok(guide, '没找到引导节点');
    assert.equal(guide.hidden, true, '看过引导还显示着');
    assert.equal(root.text.includes('第一次来'), false, '看过引导文案还在');
  } finally { restore(); }
});

test('前端产物：相册空态说得清下一步', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ photos: [] }));
    ctx.panelId = 'album';
    await bundle.panels.album.mount(ctx);
    assert.match(root.text, /还没有照片/, '相册空态没文案');
  } finally { restore(); }
});

test('前端产物：有照片时图片指向宿主的 blob 接口', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({
      photos: [{ handle: 'log:abc123.png', title: '黄昏的麦积山', city: '天水', dateKey: '2026-10-31' }],
    }));
    ctx.panelId = 'album';
    await bundle.panels.album.mount(ctx);
    const img = root.find((n) => n.tagName === 'IMG');
    assert.ok(img, '照片没渲染成 img');
    assert.equal(img.src, '/api/blob?handle=log%3Aabc123.png', `图片地址不对：${img.src}`);
  } finally { restore(); }
});

/* ---------------- 她在家：开关 + 出发按钮 ---------------- */

const homeSnap = {
  ...snapshot,
  mode: 'home',
  leg: null,
  lodging: null,
  sunrise: null,
  timeline: [{ at: '08:00', what: '早饭', kind: 'breakfast', past: false }],
  askBeforeDepart: true,
  canDepart: true,
  restUntil: null,
  homeChanged: false,
  tripHome: '兰州',
};

test('前端产物：她在家且「等点头」开着，会出现开关和出发按钮', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => homeSnap);
    await bundle.panels.now.mount(ctx);

    const toggle = root.find((n) => String(n.className).includes('jr-toggle'));
    assert.ok(toggle, '没有开关');
    const checkbox = toggle.find((n) => n.tagName === 'INPUT');
    assert.equal(checkbox.checked, true, '开关状态没跟随配置');

    const go = root.find((n) => n.tagName === 'BUTTON' && n.textContent.includes('让她出发'));
    assert.ok(go, '没有出发按钮');
    assert.equal(go.disabled, false, '在家又不休息，按钮不该锁');
  } finally { restore(); }
});

test('前端产物：开关关着时不放出发按钮（她自己会走）', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, askBeforeDepart: false }));
    await bundle.panels.now.mount(ctx);
    assert.ok(root.find((n) => String(n.className).includes('jr-toggle')), '开关应该在（用来打开）');
    const go = root.find((n) => n.tagName === 'BUTTON' && n.textContent.includes('让她出发'));
    assert.equal(go, null, '开关关着还给了出发按钮');
    assert.match(root.text, /她自己定/, '没说清现在是自动模式');
  } finally { restore(); }
});

test('前端产物：还在歇着的时候按钮锁住并说明歇到哪天', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, canDepart: false, restUntil: '11-03' }));
    await bundle.panels.now.mount(ctx);
    const go = root.find((n) => n.tagName === 'BUTTON' && n.textContent.includes('让她出发'));
    assert.ok(go, '休息中也该显示按钮（灰着，让人知道这里是出口）');
    assert.equal(go.disabled, true, '休息中按钮没锁');
    assert.match(root.text, /11-03/, '没说清歇到哪天');
  } finally { restore(); }
});

test('前端产物：装了听歌联动时，面板上能看到她正在放什么', async () => {
  // 联动坏掉时一点动静都没有（读不到就当没在听歌），所以必须在界面上留一行，
  // 让用户能自己确认这条线通不通。
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({
      ...homeSnap,
      music: { title: '爱错', artist: '王力宏' },
    }));
    await bundle.panels.now.mount(ctx);
    assert.match(root.text, /在放/, '面板没有「在放」这一行');
    assert.match(root.text, /爱错/, '没显示歌名');
  } finally { restore(); }
});

test('前端产物：没在听歌时不该出现「在放」', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, music: null }));
    await bundle.panels.now.mount(ctx);
    /*
     * **不能拿整页 text 判断**（2026-11-18 修）。
     *
     * 帮助文案里有「四盏灯分别是：…听歌（**在放**什么）」—— 那句是给用户解释四盏灯的，
     * 跟有没有在放歌毫无关系。整页 `includes('在放')` 会把它当成音乐芯片，
     * 这条断言从某次改了帮助文案起就一直是红的（不是产品 bug，是断言太宽）。
     *
     * 芯片的结构是两个 span：`jr-fact-k` 放 label、`jr-fact-v` 放值。按结构找才准。
     */
    const musicChip = root.find((n) => n.className === 'jr-fact-k' && n.textContent === '在放');
    /* find() 找不到时返回 null，这里用真值判断，不赌它的返回约定。 */
    assert.ok(!musicChip, '没听歌还画了「在放」这一格');
  } finally { restore(); }
});

/* ---------------- 倍速：她的钟离你多远 ---------------- */

test('前端产物：开了倍速要说清差多少，并给同步按钮', async () => {
  // 只写「24× 速度」等于让用户自己心算 —— 他要的是「差多少」。
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const drift = (2 * 24 + 3) * 3_600_000;   // 快 2 天 3 小时
    const ctx = makeCtx(root, async () => ({ ...homeSnap, clockDriftMs: drift }));
    await bundle.panels.now.mount(ctx);
    assert.match(root.text, /比你快 2 天 3 小时/, `差值没写出来：${root.text}`);
    assert.ok(root.find((n) => String(n.className).includes('jr-sync')), '没有同步按钮');
  } finally { restore(); }
});

test('前端产物：差不到一分钟，不给按钮也不提漂移', async () => {
  // 按下去什么都不会变，那叫骗人。
  // 2026-11-02 改：这一行现在默认显示时区，「和你的时间一致」只在没有时区可显示时兜底。
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, clockDriftMs: 30_000 }));
    await bundle.panels.now.mount(ctx);
    assert.equal(
      root.find((n) => String(n.className).includes('jr-sync')), null,
      '只差半分钟还给同步按钮',
    );
    assert.doesNotMatch(root.text, /比你(快|慢)/, '差半分钟就别提跑偏了');
  } finally { restore(); }
});

test('前端产物：钟落后一天以上时说的是「慢」，不是负数', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, clockDriftMs: -30 * 3_600_000 }));
    await bundle.panels.now.mount(ctx);
    assert.match(root.text, /比你慢 1 天 6 小时/, `落后没写对：${root.text}`);
  } finally { restore(); }
});

test('前端产物：天气超窗时写明原因，不留一栏空白', async () => {
  // 空白分不清是没网还是超窗，而这两件事的处置完全相反。
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...homeSnap, weather: '', weatherOutOfRange: true }));
    await bundle.panels.now.mount(ctx);
    assert.match(root.text, /超出预报窗口/, '超窗了却什么都没说');
  } finally { restore(); }
});

/* ---------------- 反馈栏 ---------------- */

test('前端产物：反馈按钮复制的是整封信，外链只能是 https', async () => {
  /*
   * ## 为什么不能是 mailto
   *
   * 第一版就是两条 `mailto:` 链接，看着对，点下去**什么都不会发生** ——
   * 宿主的 `setWindowOpenHandler` 只对 `http(s):` 调 `shell.openExternal`，
   * 其余一律 `deny`（`resources/app/app/main.cjs`）。炉石那个扩展早踩过这个坑。
   *
   * 所以这条测试盯两件事：**按钮复制出去的内容对不对**，以及**页面上没有 mailto**。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({
      ...snapshot, guideSeen: true, feedbackEmail: 'hi@example.com', version: '0.9.9',
    }));
    await bundle.panels.now.mount(ctx);

    assert.ok(root.find((n) => String(n.className).split(' ').includes('jr-fb')), '配了邮箱却没有反馈栏');

    // 页面上所有 <a> 必须是 https —— 宿主的兜底规则只放行它
    const links = root.all((n) => n.tagName === 'A');
    assert.ok(links.length >= 1, '没有能点出去的链接');
    for (const a of links) {
      assert.ok(String(a.href).startsWith('https://'), `外链必须走 https，实际：${a.href}`);
    }

    const btns = root.all((n) => n.tagName === 'BUTTON' && String(n.className).includes('jr-fb-btn'));
    assert.equal(btns.length, 2, `该有两个按钮（报 bug / 加地点），实际 ${btns.length}`);

    // 点第一个，看复制出去的是不是一整封信
    globalThis.__copied = '';
    btns[0].handlers.click[0]();
    await new Promise((r) => setTimeout(r, 0));
    const letter = globalThis.__copied;
    assert.match(letter, /收件人：hi@example\.com/, '信里没有收件人');
    assert.match(letter, /主题：.*报个 bug/, '主题没跟着按钮走');
    assert.match(letter, /0\.9\.9/, '信里没带版本号 —— 第一轮就得回头问她装的哪版');
    assert.match(letter, /兰州/, '信里没带她当时在哪儿');

    // 第二个按钮换主题，并说清要填什么
    globalThis.__copied = '';
    btns[1].handlers.click[0]();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(globalThis.__copied, /想加个地点/, '第二个按钮没换主题');
    assert.match(globalThis.__copied, /城市 \+ 地方名/, '加地点那封没写清楚要填什么');

    // 地址必须明文露出来：连 mailto 都不放行，用户手里总得有能复制的字符串
    assert.match(root.text, /hi@example\.com/, '地址没露出来，按钮之外就没辙了');
    // 群号跟邮箱并列，同样得是明文 —— 群里问一句比写一封 issue 快
    assert.match(root.text, /284525159/, '反馈栏没带 QQ 群号');
  } finally { restore(); }
});

test('前端产物：没配反馈邮箱时，那一栏整个不出现', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({ ...snapshot, guideSeen: true }));
    await bundle.panels.now.mount(ctx);
    // className 要整词比对：`jr-fb-slot` 这个空插槽也含 `jr-fb`，模糊匹配会把它当成反馈栏
    assert.equal(root.find((n) => String(n.className).split(' ').includes('jr-fb')), null,
      '没配邮箱还留着一栏 —— 点了什么都不会发生，比没有更糟');
    assert.equal(root.all((n) => n.tagName === 'A').length, 0, '没配邮箱却渲染出了邮件链接');
  } finally { restore(); }
});

test('前端产物：时钟下面显示当地时区，平时不给同步按钮', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    // 2026-11-02 Mr.Q 原话：「这个同步是不是没什么意义？换成当地的时区怎么样」
    const ctx = makeCtx(root, async () => ({ ...snapshot, guideSeen: true, tzLabel: 'UTC+9', clockDriftMs: 0 }));
    await bundle.panels.now.mount(ctx);

    assert.match(root.text, /UTC\+9/, '时区没显示出来 —— 那这一行又只剩「比你快」了');
    assert.equal(root.find((n) => String(n.className).split(' ').includes('jr-sync')), null,
      '时间没跑偏却给同步按钮，按下去什么都不会变');
  } finally { restore(); }
});

test('前端产物：她的日子跑偏一天以上，才补一句漂移并放出同步按钮', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const drift = (1 * 24 + 21) * 3_600_000;
    const ctx = makeCtx(root, async () => ({ ...snapshot, guideSeen: true, tzLabel: 'UTC+9', clockDriftMs: drift }));
    await bundle.panels.now.mount(ctx);

    assert.match(root.text, /UTC\+9/, '时区要一直在，别被漂移那句挤掉');
    assert.match(root.text, /比你快 1 天 21 小时/, '跑偏一天以上必须说清楚差多少');
    assert.ok(root.find((n) => String(n.className).split(' ').includes('jr-sync')), '这时候才该有按钮');
  } finally { restore(); }
});

test('前端产物：天气 chip 不带前导空行，也不留「天气：」前缀', async () => {
  /*
   * 2026-11-02 跑真实快照发现的：`weatherLine()` 是给事件正文用的，
   * 开头故意带一个换行当段落分隔；面板把同一坨塞进小 chip 里，
   * 原来直接 `replace(/^天气：/)` —— 开头是 `\n`，这个锚点永远匹配不到，
   * chip 里就多一个空行加一句「天气：多云…」。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({
      ...snapshot, guideSeen: true, weather: '\n天气：多云，夜里 2℃，冷。',
    }));
    await bundle.panels.now.mount(ctx);

    assert.match(root.text, /多云，夜里 2℃/, '天气本体没了');
    assert.doesNotMatch(root.text, /天气：/, '「天气：」这个前缀没摘掉，chip 里会多一层空行');
  } finally { restore(); }
});

test('前端产物：倍速不是 1 的时候，给一个「恢复正常」', async () => {
  /*
   * 2026-11-03 Mr.Q：「如果用户调倍速把宠物的时间调得过快了，得加一个把宠物时间
   * 调整回来的按钮」。
   *
   * 设置页能改，但那要先想起来自己改过、再翻到那个设置项。
   * 而且改了倍速之后「她那边比你快 20 天」会一直挂在界面上，看着像坏了。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;

    const fast = new FakeNode('div');
    const ctxFast = makeCtx(fast, async () => ({ ...snapshot, guideSeen: true, speed: 24 }));
    await bundle.panels.now.mount(ctxFast);
    const back = fast.find((n) => String(n.className).includes('jr-recall') && n.text === '恢复正常');
    assert.ok(back, '倍速 24 却没有「恢复正常」的入口');

    // 速度正常的时候不该出现 —— 那会儿按下去什么都不会变
    const slow = new FakeNode('div');
    const ctxSlow = makeCtx(slow, async () => ({ ...snapshot, guideSeen: true, speed: 1 }));
    await bundle.panels.now.mount(ctxSlow);
    const none = slow.find((n) => String(n.className).includes('jr-recall') && n.text === '恢复正常');
    assert.equal(none, null, '速度本来就是 1×，还给一个「恢复正常」');
  } finally { restore(); }
});

test('前端产物：指到同步盘之后，面板上要看得见那个路径', async () => {
  /*
   * 2026-11-03 Mr.Q：「多设备同步还是不知道怎么设置」。
   *
   * 除了设置项没讲清，还有一个更基础的原因：**填完之后界面上没有任何证据**。
   * 填了、没生效、和根本没填，看起来一模一样 —— 用户没法判断自己有没有做对。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;

    const synced = new FakeNode('div');
    const ctx1 = makeCtx(synced, async () => ({
      ...snapshot, guideSeen: true,
      diary: { shared: true, dir: 'C://Users//me//OneDrive//Coopani//journey', days: 12, problem: null },
    }));
    await bundle.panels.now.mount(ctx1);
    assert.ok(synced.text.includes('OneDrive'), '指到同步盘了，面板上却看不到路径');

    // 没填同步目录（只在本机）就不显示 —— 那是默认状态，说一句反而占地方
    const local = new FakeNode('div');
    const ctx2 = makeCtx(local, async () => ({
      ...snapshot, guideSeen: true,
      diary: { shared: false, dir: 'D://data//journey', days: 3, problem: null },
    }));
    await bundle.panels.now.mount(ctx2);
    assert.ok(!local.text.includes('D://data//journey'), '没指同步盘却把本机目录写出来了');
  } finally { restore(); }
});

test('前端产物：城市名旁边直接显示天气胶囊（无前缀、有则显示）', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async () => ({
      ...homeSnap, guideSeen: true, weather: '\n天气：多云，9~16℃',
    }));
    await bundle.panels.now.mount(ctx);
    const badge = root.find((n) => n.className === 'jr-city-weather');
    assert.ok(badge && !badge.hidden, '城市名旁边应显示天气胶囊');
    assert.equal(badge.textContent, '多云，9~16℃', '胶囊去掉天气：前缀且无空行');
  } finally { restore(); }
});

test('前端产物：碰面服务器没连上与同城没人要分开显示', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const offRoot = new FakeNode('div');
    const ctxOff = makeCtx(offRoot, async () => ({
      ...snapshot, guideSeen: true,
      social: { online: false, nearby: 0, invites: 0, pool: 0, pledge: null },
    }));
    await bundle.panels.now.mount(ctxOff);
    assert.ok(offRoot.text.includes('碰面服务器没连上'), '断连时面板应显示碰面服务器没连上');
    assert.ok(!offRoot.text.includes('这段时间没别人'), '断连时不该误显示成没人');

    const emptyRoot = new FakeNode('div');
    const ctxEmpty = makeCtx(emptyRoot, async () => ({
      ...snapshot, guideSeen: true,
      social: { online: true, nearby: 0, invites: 0, pool: 0, pledge: null },
    }));
    await bundle.panels.now.mount(ctxEmpty);
    assert.ok(emptyRoot.text.includes('这段时间没别人'), '连上了但真没人时显示这段时间没别人');

    /*
     * 第三档：这一带没人，但今天有人来过（2026-11-20）。
     *
     * 服务端一直回着 `here`，客户端原来一个字段都没接，于是「今天来过 3 只、
     * 只是这会儿不在」和「这城今天一只都没有」显示成同一句话。
     */
    const wasRoot = new FakeNode('div');
    const ctxWas = makeCtx(wasRoot, async () => ({
      ...snapshot, guideSeen: true,
      social: { online: true, nearby: 0, here: 3, invites: 0, pool: 0, pledge: null },
    }));
    await bundle.panels.now.mount(ctxWas);
    assert.ok(wasRoot.text.includes('今天来过 3 只'), `有人来过时不该说没人：${wasRoot.text.slice(0, 200)}`);
    assert.ok(!wasRoot.text.includes('这段时间没别人'), '有人来过却显示「这段时间没别人」');

    /* 优先级：此刻真有人时先说此刻，不拿「今天来过」顶替。 */
    const bothRoot = new FakeNode('div');
    const ctxBoth = makeCtx(bothRoot, async () => ({
      ...snapshot, guideSeen: true,
      social: { online: true, nearby: 2, here: 5, invites: 0, pool: 0, pledge: null },
    }));
    await bundle.panels.now.mount(ctxBoth);
    assert.ok(bothRoot.text.includes('2 个也在这一带'), '此刻有人时应当说这一带有人');
    assert.ok(!bothRoot.text.includes('今天来过'), 'nearby > 0 时不该退到「今天来过」那一档');

    /* 旧服务端不回 `here`：字段缺失要落回原来那句，不能空着或报错。 */
    const oldRoot = new FakeNode('div');
    const ctxOld = makeCtx(oldRoot, async () => ({
      ...snapshot, guideSeen: true,
      social: { online: true, nearby: 0, invites: 0, pool: 0, pledge: null },
    }));
    await bundle.panels.now.mount(ctxOld);
    assert.ok(oldRoot.text.includes('这段时间没别人'), '没有 here 字段时应当落回原来的文案');
  } finally { restore(); }
});

/* ---------------- 相册：同一天拍多张要不要都留着（2026-11-20） ---------------- */

test('前端产物：相册页有「同一天拍的都留着」开关，状态以后端为准', async () => {
  /*
   * 读者报的：一天内拍的照片会覆盖旧的。后端加了 `imageKeepAll`，
   * 前端必须有一个能摸到的开关 —— 装在设置页里等于没提供，
   * 人是在相册页发现「早上那张没了」的。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const sent = [];
    const root = new FakeNode('div');
    const ctx = makeCtx(root, async (method, args) => {
      sent.push({ method, args });
      if (method === 'list') return { photos: [], keepAll: true };
      return {};
    });
    ctx.panelId = 'album';
    await bundle.panels.album.mount(ctx);

    const box = root.find((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
    assert.ok(box, '相册页没有这个开关');
    assert.equal(box.checked, true, '后端开着，前端没勾上');

    /* 点它 → 走的必须是数组参数（宿主网关硬校验），键名也得对。 */
    box.checked = false;
    await box.handlers.change[0]();
    const save = sent.find((c) => c.method === 'saveImageSettings');
    assert.ok(save, '改了开关却没有保存');
    assert.ok(Array.isArray(save.args), '宿主要求 args 是数组');
    assert.deepEqual(save.args[0], { imageKeepAll: false });
  } finally { restore(); }
});

/* ---------------- 相册：点图看大图（2026-11-21） ---------------- */

test('前端产物：点缩略图放大，× 关掉，箭头翻下一张', async () => {
  /*
   * 读者来信：「在这个界面做一个一键放大……有时候复制原图路径后打开是一堆桌面的截屏」。
   * 原来相册只有 168px 的缩略图，想看原图只能去媒体目录里翻，而那个目录混着别的截图。
   */
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const root = new FakeNode('div');
    const photos = [
      { handle: 'log:a.png', title: '黄昏的麦积山', city: '天水', dateKey: '2026-10-31', file: 'a.png' },
      { handle: 'log:b.png', title: '清晨的甘海子', city: '九寨沟', dateKey: '2026-11-01', file: 'b.png' },
    ];
    const ctx = makeCtx(root, async (method) => (method === 'list' ? { photos } : {}));
    ctx.panelId = 'album';
    await bundle.panels.album.mount(ctx);

    const box = root.find((n) => n.className === 'jr-lb');
    assert.ok(box, '没有放大层');
    assert.equal(box.hidden, true, '一进来就弹着一张图');

    const thumbs = root.all((n) => n.tagName === 'IMG' && n.className !== 'jr-lb-img');
    assert.equal(thumbs.length, 2, `缩略图数量不对：${thumbs.length}`);
    thumbs[0].handlers.click[0]();
    assert.equal(box.hidden, false, '点了没打开');
    const big = root.find((n) => n.className === 'jr-lb-img');
    assert.equal(big.src, '/api/blob?handle=log%3Aa.png', `放大层装错了图：${big.src}`);
    assert.match(root.find((n) => n.className === 'jr-lb-bar').text, /1 \/ 2/, '没有「第几张」');

    /* 翻下一张，不用退出去重点 */
    root.find((n) => n.className.includes('jr-lb-next')).handlers.click[0]();
    assert.equal(big.src, '/api/blob?handle=log%3Ab.png', '箭头没翻页');

    root.find((n) => n.className === 'jr-lb-x').handlers.click[0]();
    assert.equal(box.hidden, true, '× 关不掉');
    assert.equal(big.src, '', '关了还攥着那张原图，内存会涨');
  } finally { restore(); }
});

/* ---------------- 邀约页（2026-11-25） ---------------- */

/** 邀约页要的三份数据：plan / board / post。抽出来给两个用例共用。 */
function inviteInvoke(sent) {
  return async (method, args) => {
    sent.push({ method, args });
    if (method === 'plan') {
      return {
        here: { id: 'chengdu', name: '成都' },
        meet: null,
        dest: { id: 'lasa', name: '拉萨' },
        nameProblem: '',
        meetProblem: '',
        meetReady: true,
        legs: [{ label: '成都 → 拉萨', km: 2000, modes: ['火车', '飞机'] }],
        ok: true,
        reason: '',
      };
    }
    if (method === 'board') {
      return {
        ready: true,
        reason: '',
        here: { id: 'chengdu', name: '成都' },
        pool: 641,
        mineTaken: 2,
        list: [{
          id: 'a1b2c3d4e5f6a7b8', pet: '小雪', to: 'lasa', toName: '拉萨',
          days: 3, note: '一起去看布达拉宫', meetName: '西安', taken: false, mode: '火车',
        }],
        canPost: '',
      };
    }
    if (method === 'post') return { ok: true, text: '发出去了：成都 → 拉萨，在那儿一起待 2 天。' };
    return {};
  };
}

test('前端产物：邀约页有填表三格、把可用交通方式列出来、公告栏看得见别人发的约', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const sent = [];
    const root = new FakeNode('div');
    const ctx = makeCtx(root, inviteInvoke(sent));
    ctx.panelId = 'invite';
    await bundle.panels.invite.mount(ctx);
    /* mount 里那两件事是 fire-and-forget，等一轮微任务再看渲染结果。 */
    await new Promise((r) => setTimeout(r, 0));

    const inputs = root.all((n) => n.tagName === 'INPUT');
    assert.ok(inputs.length >= 3, `目的地 / 在哪汇合 / 一句话该有三个输入框，实际 ${inputs.length}`);

    /* 方式按钮来自 plan —— 写死的下拉做不到「牛津没有机场就不给飞机」。 */
    const chips = root.all((n) => String(n.className).includes('jr-inv-chip'));
    const names = chips.map((c) => c.textContent);
    assert.ok(names.includes('飞机'), `没列出可用交通方式：${names.join('/')}`);
    assert.ok(names.includes('火车'), `没列出可用交通方式：${names.join('/')}`);
    /* 天数那组也在，同样走 chips；别把「其实没渲染」当成通过。 */
    assert.ok(names.some((n) => /^2天$/.test(n)), `天数 chips 没渲染：${names.join('/')}`);

    /* 两段路的实况 */
    assert.match(root.text, /成都 → 拉萨/);
    assert.match(root.text, /2000/);

    /* 公告栏 */
    assert.match(root.text, /小雪/, '公告栏没显示别人发的约');
    assert.match(root.text, /一起去看布达拉宫/);
    assert.match(root.text, /641/, '没显示公共池条数');
    assert.match(root.text, /西安/, '碰头城没显示');
    /* 对方挑的走法（2026-11-25 起是协议字段，不再是正文前缀）——公告栏上要看得见。 */
    assert.match(root.text, /怎么去 火车/, '对方怎么去没显示');

    /* 宿主网关硬校验数组参数 —— plan 那两个值必须原样传过去。 */
    const plan = sent.find((s) => s.method === 'plan');
    assert.ok(plan, '没调 plan');
    assert.ok(Array.isArray(plan.args), 'plan 的参数必须是数组');
    assert.equal(plan.args.length, 2);
  } finally { restore(); }
});

test('前端产物：邀约页按发布 —— 五个参数走数组，成功后就地回执并刷新公告栏', async () => {
  const restore = installDom();
  try {
    const bundle = (await import('../dist/webui.js')).default;
    const sent = [];
    const root = new FakeNode('div');
    const ctx = makeCtx(root, inviteInvoke(sent));
    ctx.panelId = 'invite';
    await bundle.panels.invite.mount(ctx);
    await new Promise((r) => setTimeout(r, 0));

    const go = root.find((n) => String(n.className).includes('jr-inv-go'));
    assert.ok(go, '没有发布按钮');
    const boardsBefore = sent.filter((s) => s.method === 'board').length;

    go.handlers.click[0]();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const post = sent.find((s) => s.method === 'post');
    assert.ok(post, '点了发布却没发请求');
    assert.ok(Array.isArray(post.args), 'post 的参数必须是数组（宿主网关硬校验）');
    assert.equal(post.args.length, 5, `目的地/汇合/天数/一句话/怎么去 五格，实际 ${post.args.length}`);

    assert.match(root.text, /发出去了/, '回执没显示出来');
    const boardsAfter = sent.filter((s) => s.method === 'board').length;
    assert.ok(boardsAfter > boardsBefore, '发完之后应刷新公告栏');
  } finally { restore(); }
});
