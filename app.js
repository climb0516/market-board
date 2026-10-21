// Created by 青云 on 2026/10/21.
// Market Board 前端：行情直连东方财富（JSONP，打开页面时实时刷新），失败时用 GitHub Actions 抓的 market.json 快照兜底；
// 汇率、油价金价两个模块是同源子页面（fx.html / oilgold.html），以 iframe 嵌入。
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mb:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mb:' + k, JSON.stringify(v)); } catch {} },
};

// ── 常量 ──
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';          // 东方财富行情接口的公开 ut 参数
const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';   // 东方财富搜索接口的公开 token
const QFIELDS = 'f2,f3,f4,f5,f6,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f23,f100,f104,f105,f106,f115,f124';
const REFRESH_OPEN = 15000;     // 有市场在交易时的行情刷新间隔
const REFRESH_IDLE = 60000;     // 全部休市时
const SPARK_EVERY = 60000;      // 分时迷你图刷新间隔
const SECTOR_EVERY = 30000;     // 板块 / 榜单刷新间隔
const MKT_NAME = { CN: 'A 股', HK: '港股', US: '美股' };
const MKT_TAG = { CN: 'A', HK: '港', US: '美' };
// 行情代码前缀 → 市场；只有这三个市场的股票能加自选
const mktOf = id => {
  const m = String(id).split('.')[0];
  return m === '0' || m === '1' ? 'CN' : m === '116' || m === '128' ? 'HK' : m === '105' || m === '106' || m === '107' ? 'US' : null;
};

// 各交易所交易时段（当地时间，自零点起的分钟数）。节假日不内置：交易时段内行情时间戳 20 分钟没动就判为休市
const SESS = {
  CN: { tz: 'Asia/Shanghai', city: '北京', s: [[570, 690], [780, 900]], pre: [[555, 570]], preName: '集合竞价' },
  HK: { tz: 'Asia/Hong_Kong', city: '香港', s: [[570, 720], [780, 960]], pre: [[540, 570]], preName: '开市前竞价' },
  US: { tz: 'America/New_York', city: '纽约', s: [[570, 960]], pre: [[240, 570]], post: [[960, 1200]], preName: '盘前' },
  JP: { tz: 'Asia/Tokyo', city: '东京', s: [[540, 690], [750, 930]] },
  KR: { tz: 'Asia/Seoul', city: '首尔', s: [[540, 930]] },
  UK: { tz: 'Europe/London', city: '伦敦', s: [[480, 990]] },
  DE: { tz: 'Europe/Berlin', city: '法兰克福', s: [[540, 1050]] },
  FR: { tz: 'Europe/Paris', city: '巴黎', s: [[540, 1050]] },
};
// 判断节假日用的代表性行情
const MKT_REP = { CN: '1.000001', HK: '100.HSI', US: '100.SPX', JP: '100.N225', KR: '100.KS11', UK: '100.FTSE', DE: '100.GDAXI', FR: '100.FCHI' };
const STATUS_BAR = [['CN', 'A 股'], ['HK', '港股'], ['US', '美股'], ['JP', '日本'], ['KR', '韩国'], ['DE', '欧洲']];

// ── 状态 ──
const S = {
  cfg: null,
  snap: null,                     // market.json 快照
  q: {},                          // id → 归一化后的行情
  prevPx: {},                     // 上一次渲染时的价格，用于闪烁提示
  spark: {},                      // id → { pre, pts, slots }
  sectors: null, ranks: null,
  live: null,                     // 最近一次实时行情成功的时间
  liveErr: false,
  tab: 'overview',
  stockGroup: store.get('stockGroup', null),
  sort: store.get('sort', { key: null, dir: -1 }),
  sectorKind: store.get('sectorKind', 'industry'),
  rankMkt: store.get('rankMkt', 'CN'),
  rankBy: store.get('rankBy', 'gain'),
  watch: store.get('watch', []),
  names: store.get('names', {}),  // 自选的名称缓存（行情还没回来时显示）
  manage: false, io: null,        // 自选管理模式、导入导出面板
  detail: null,                   // 详情弹层 { id, period }
  frames: {},
};
const saveWatch = () => { store.set('watch', S.watch); store.set('names', S.names); };

// ── JSONP ──
let jsonpSeq = 0;
function jsonp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cb = '__mb' + (++jsonpSeq) + '_' + Date.now().toString(36);
    const s = document.createElement('script');
    const done = () => { clearTimeout(t); window[cb] = () => {}; s.remove(); };   // 超时后脚本才回来也不报错
    const t = setTimeout(() => { done(); reject(new Error('timeout')); }, timeout);
    window[cb] = d => { done(); resolve(d); };
    s.onerror = () => { done(); reject(new Error('network')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'cb=' + cb;
    document.head.appendChild(s);
  });
}

// ── 数据：行情 ──
const n = v => (typeof v === 'number' && isFinite(v) ? v : null);
function normQuote(d) {
  return {
    id: `${d.f13}.${d.f12}`, code: d.f12, name: d.f14,
    price: n(d.f2), pct: n(d.f3), chg: n(d.f4), vol: n(d.f5), amt: n(d.f6), turn: n(d.f8),
    pe: n(d.f115) ?? n(d.f9), pb: n(d.f23), high: n(d.f15), low: n(d.f16), open: n(d.f17), prev: n(d.f18),
    cap: n(d.f20), ind: d.f100 && d.f100 !== '-' ? d.f100 : '',
    up: n(d.f104), down: n(d.f105), flat: n(d.f106),
    time: n(d.f124) ? d.f124 * 1000 : null,
  };
}
async function fetchQuotes(ids) {
  const em = ids.filter(id => !id.startsWith('coinbase.'));
  const out = {};
  for (let i = 0; i < em.length; i += 80) {
    const chunk = em.slice(i, i + 80).join(',');
    const d = await jsonp(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&ut=${EM_UT}&fields=${QFIELDS}&secids=${chunk}`);
    (d?.data?.diff || []).forEach(x => { const q = normQuote(x); out[q.id] = q; });
  }
  if (!Object.keys(out).length && em.length) throw new Error('empty');
  await Promise.all(ids.filter(id => id.startsWith('coinbase.')).map(async id => {
    try { out[id] = await coinbase(id); } catch {}
  }));
  return out;
}
// 比特币：Coinbase 24 小时统计（open = 24 小时前的价格）
async function coinbase(id) {
  const pair = id.split('.')[1];
  const d = await fetch(`https://api.exchange.coinbase.com/products/${pair}/stats`).then(r => r.json());
  const price = +d.last, prev = +d.open;
  return { id, code: pair, name: '比特币', price, prev, chg: price - prev, pct: (price / prev - 1) * 100,
    high: +d.high, low: +d.low, open: prev, vol: +d.volume, time: Date.now() };
}
// 分时：beticks 是交易时段的秒数，前三个为竞价 / 开盘 / 收盘，之后两两成对为连续交易时段
async function fetchSpark(id) {
  const d = await jsonp(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${id}&ut=${EM_UT}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53&iscr=0&ndays=1`);
  const data = d?.data;
  if (!data?.trends?.length) throw new Error('empty');
  const pts = data.trends.map(t => { const [time, v] = t.split(','); return { t: time, v: +v }; });
  let slots = 0;
  const tk = String(data.beticks || '').split('|').map(Number);
  for (let i = 3; i + 1 < tk.length; i += 2) slots += Math.max(0, tk[i + 1] - tk[i]) / 60;
  return { pre: data.preClose, pts, slots: slots ? slots + 1 : pts.length, decimal: data.decimal };
}
async function fetchKline(id, klt) {
  const d = await jsonp(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${id}&ut=${EM_UT}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=1&lmt=120&end=20500101`);
  return (d?.data?.klines || []).map(k => { const [t, o, c, h, l, v] = k.split(','); return { t, o: +o, c: +c, h: +h, l: +l, v: +v }; });
}
// 列表接口每页最多 100 条，超过时并发取后面几页
async function clist(fs, fid, po, pz, fields) {
  const page = pn => jsonp(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${Math.min(pz, 100)}&po=${po}&np=1&fltt=2&invt=2&ut=${EM_UT}&fid=${fid}&fs=${encodeURIComponent(fs).replace(/%2B/g, '+')}&fields=${fields}`);
  const first = await page(1);
  const rows = first?.data?.diff || [];
  const want = Math.min(pz, first?.data?.total || 0);
  if (rows.length >= want) return rows;
  const rest = await Promise.all(Array.from({ length: Math.ceil(want / 100) - 1 }, (_, i) => page(i + 2).catch(() => null)));
  return rows.concat(...rest.map(d => d?.data?.diff || []));
}
async function searchStocks(q) {
  const d = await jsonp(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=${SEARCH_TOKEN}&count=12`, 6000);
  return (d?.QuotationCodeTable?.Data || []).filter(x => x.QuoteID).map(x => ({
    id: x.QuoteID, code: x.Code, name: x.Name, type: x.SecurityTypeName, mkt: mktOf(x.QuoteID),
  }));
}

// ── 格式化 ──
function fmtPx(v, d) {
  if (v == null) return '—';
  const a = Math.abs(v);
  d ??= pxDigits(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pxDigits = v => { const a = Math.abs(v ?? 0); return a >= 10 ? 2 : a >= 1 ? 3 : 4; };
const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '');
const fmtPct = v => (v == null ? '—' : `${sgn(v)}${Math.abs(v).toFixed(2)}%`);
// 涨跌额与价格保持同样的小数位：ref 传价格
const fmtChg = (v, d, ref) => (v == null ? '—' : sgn(v) + fmtPx(Math.abs(v), d ?? pxDigits(ref)));
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
function fmtBig(v) {
  if (v == null || v === 0) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return v.toLocaleString('en-US');
}
const hm = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mdhm = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const mkTag = mkt => (mkt ? `<span class="mk ${mkt}">${MKT_TAG[mkt]}</span>` : '');
// 价格位数：同一只标的的指数 / 收益率保持统一
function digitsFor(id, v) {
  if (id === '171.US10Y') return 3;
  if (id === '133.USDCNH') return 4;
  return undefined;
}

// ── 交易状态 ──
function zoned(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const h = +p.hour % 24;
  return { wd: p.weekday, min: h * 60 + +p.minute, hm: `${String(h).padStart(2, '0')}:${p.minute}` };
}
const inAny = (ranges, m) => (ranges || []).some(([a, b]) => m >= a && m < b);
function mstatus(mkt) {
  const s = SESS[mkt];
  if (!s) return { key: 'open', label: '' };
  const z = zoned(s.tz);
  if (z.wd === 'Sat' || z.wd === 'Sun') return { key: 'closed', label: '休市', z };
  if (inAny(s.s, z.min)) {
    const t = S.q[MKT_REP[mkt]]?.time;
    if (S.live && t && Date.now() - t > 20 * 60 * 1000) return { key: 'closed', label: '休市', z };
    return { key: 'open', label: '交易中', z };
  }
  if (inAny(s.pre, z.min)) return { key: 'pre', label: s.preName, z };
  if (inAny(s.post, z.min)) return { key: 'pre', label: '盘后', z };
  if (z.min > s.s[0][0] && z.min < s.s[s.s.length - 1][1]) return { key: 'break', label: '午休', z };
  return { key: 'closed', label: z.min < s.s[0][0] ? '未开盘' : '已收盘', z };
}
const anyOpen = () => Object.keys(SESS).some(m => ['open', 'pre'].includes(mstatus(m).key));

// ── 自选 ──
const inWatch = id => S.watch.includes(id);
function toggleWatch(id, name) {
  if (inWatch(id)) S.watch = S.watch.filter(x => x !== id);
  else { S.watch.push(id); if (name) S.names[id] = name; }
  saveWatch();
  rerender();
}
const starBtn = (id, name) => mktOf(id)
  ? `<button class="star ${inWatch(id) ? 'on' : ''}" data-star="${esc(id)}" data-name="${esc(name || '')}" title="${inWatch(id) ? '移出自选' : '加入自选'}">${inWatch(id) ? '★' : '☆'}</button>`
  : '';

// ── 迷你分时图 ──
function sparkSVG(sp, q) {
  if (!sp || sp.pts.length < 2) return '<svg class="spark" viewBox="0 0 200 40"></svg>';
  const W = 200, H = 40, vs = sp.pts.map(p => p.v), pre = sp.pre ?? vs[0];
  const min = Math.min(...vs, pre), max = Math.max(...vs, pre), span = max - min || 1;
  const total = Math.max(sp.slots, sp.pts.length) - 1 || 1;
  const x = i => (i / total * W).toFixed(1), y = v => (H - 3 - (v - min) / span * (H - 6)).toFixed(1);
  const last = q?.price ?? vs[vs.length - 1];
  const c = last >= pre ? 'var(--up)' : 'var(--down)';
  const line = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" x2="${W}" y1="${y(pre)}" y2="${y(pre)}" stroke="var(--line-2)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    <path d="${line}L${x(vs.length - 1)},${H}L0,${H}Z" fill="${c}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

// ── 视图：总览 ──
function indexCard(it) {
  const q = S.q[it.id], st = it.mkt !== '24H' ? mstatus(it.mkt) : null;
  const d = digitsFor(it.id, q?.price);
  const prev = S.prevPx[it.id];
  const flash = q?.price != null && prev != null && q.price !== prev ? (q.price > prev ? 'flash-up' : 'flash-down') : '';
  const unit = it.unit === '%' ? '%' : '';
  const px = it.unit === '$' ? '$' + fmtPx(q?.price, 0) : fmtPx(q?.price, d) + unit;
  return `<div class="panel card ${flash}" data-detail="${esc(it.id)}" data-name="${esc(it.name)}">
    <div class="card-head"><span class="card-name">${esc(it.name)}</span><span class="card-st">${st ? esc(st.label) : ''}</span></div>
    <div class="card-px num">${q ? px : '—'}</div>
    <div class="card-chg num"><span class="${cls(q?.chg)}">${fmtChg(q?.chg, d, q?.price)}</span><span class="${cls(q?.pct)}">${fmtPct(q?.pct)}</span></div>
    ${sparkSVG(S.spark[it.id], q)}
  </div>`;
}
function renderOverview() {
  const cfg = S.cfg;
  const bar = STATUS_BAR.map(([m, label]) => {
    const st = mstatus(m);
    return `<span class="ms ${st.key === 'open' ? 'open' : st.key === 'pre' ? 'pre' : ''}"><i></i>${label} · ${esc(st.label)}<small>${SESS[m].city} ${st.z.hm}</small></span>`;
  }).join('');
  const groups = cfg.indices.map(g => `<h2 class="section-title">${esc(g.group)}</h2><div class="cards">${g.items.map(indexCard).join('')}</div>`).join('');

  // A 股市场宽度：上证 + 深成的上涨 / 下跌 / 平盘家数（深成指返回的是深市全部股票）
  const sh = S.q['1.000001'], sz = S.q['0.399001'];
  let breadth = '<div class="empty" style="padding:12px">暂无数据</div>';
  if (sh?.up != null && sz?.up != null) {
    const up = sh.up + sz.up, down = sh.down + sz.down, flat = sh.flat + sz.flat, all = up + down + flat || 1;
    breadth = `<div class="mini-row num"><span>上涨 <b class="up">${up}</b> · 平 <b>${flat}</b> · 下跌 <b class="down">${down}</b></span></div>
      <div class="breadth"><span style="width:${up / all * 100}%;background:var(--up)"></span><span style="width:${flat / all * 100}%;background:var(--text-3)"></span><span style="width:${down / all * 100}%;background:var(--down)"></span></div>
      <div class="mini-row"><span>沪深两市成交额</span><b class="num">${fmtBig((sh.amt || 0) + (sz.amt || 0))}</b></div>`;
  }
  const watch = S.watch.slice(0, 8).map(id => {
    const q = S.q[id];
    return `<div class="mini-row click" data-detail="${esc(id)}"><span>${mkTag(mktOf(id))}${esc(q?.name || S.names[id] || id)}</span>
      <span class="num"><b>${fmtPx(q?.price)}</b> <span class="${cls(q?.pct)}">${fmtPct(q?.pct)}</span></span></div>`;
  }).join('');
  const quick = cfg.quick.map(it => {
    const q = S.q[it.id];
    return `<div class="mini-row click" data-goto="${esc(it.tab)}"><span>${esc(it.name)}</span>
      <span class="num"><b>${fmtPx(q?.price, it.digits)}</b> <span class="${cls(q?.pct)}">${fmtPct(q?.pct)}</span></span></div>`;
  }).join('');

  $('#view-overview').innerHTML = `
    <section class="hero"><div><h1>全球<em>市场</em></h1><p>A 股、港股、美股与日韩欧主要指数，页面打开时实时刷新。点卡片看分时和 K 线。</p></div></section>
    <div class="mstat">${bar}</div>
    <div class="layout">
      <main>${groups}</main>
      <aside class="aside">
        <div class="panel widget"><h3>📈 A 股市场宽度</h3>${breadth}</div>
        <div class="panel widget"><h3>⭐ 我的自选<small>${S.watch.length ? `<a href="#stocks" data-group="watch">全部 ${S.watch.length} 只 →</a>` : ''}</small></h3>
          ${watch || '<div class="muted" style="font-size:12.5px">在顶部搜索框搜股票，点 ☆ 加入自选</div>'}</div>
        <div class="panel widget"><h3>💱 汇率 · 黄金 · 原油<small>点击进入模块</small></h3>${quick}</div>
        ${dataWidget()}
      </aside>
    </div>`;
}
function dataWidget() {
  const snap = S.snap;
  return `<div class="panel widget"><h3>📡 数据</h3>
    <div class="status-row"><span>实时行情（东方财富）</span><span class="${S.liveErr ? 'bad' : 'ok'}">${S.live ? (S.liveErr ? '失败 · ' : '') + hm(S.live) : S.liveErr ? '连接失败' : '连接中'}</span></div>
    <div class="status-row"><span>快照（每小时）</span><span>${snap ? mdhm(snap.updated) : '—'}</span></div>
    <div class="note" style="margin-top:6px">交易时段每 ${REFRESH_OPEN / 1000} 秒刷新，全部休市时每分钟；切到后台暂停。实时行情连不上时显示快照数据。美股指数、个股为延迟行情。</div>
  </div>`;
}

// ── 视图：重点股票 ──
function stockIds(g) { return g === 'watch' ? S.watch : S.cfg.stocks[g] || []; }
const COLS = [
  ['name', '名称'], ['price', '最新价'], ['pct', '涨跌幅'], ['chg', '涨跌额', 'hide-m'], ['amt', '成交额', 'hide-m'],
  ['cap', '总市值', 'hide-m'], ['pe', '市盈率TTM', 'hide-m'], ['turn', '换手率', 'hide-m'],
];
function renderStocks() {
  if (!S.stockGroup) S.stockGroup = S.watch.length ? 'watch' : 'US';
  const g = S.stockGroup;
  const segs = [['watch', `自选 ${S.watch.length}`], ['US', '美股'], ['HK', '港股'], ['CN', 'A 股']]
    .map(([k, l]) => `<button data-group="${k}" class="${g === k ? 'active' : ''}">${l}</button>`).join('');
  const tools = g === 'watch' ? `<div class="toolbar"><span class="muted" style="font-size:12.5px">自选只保存在本机浏览器；换设备用导出 / 导入同步</span>
    <div class="group">
      <button class="btn ${S.manage ? 'primary' : ''}" data-act="manage">${S.manage ? '完成' : '管理'}</button>
      <button class="btn" data-act="export">导出</button><button class="btn" data-act="import">导入</button>
    </div></div>
    ${S.io ? `<div class="panel io">
      <div class="muted" style="font-size:12.5px">${S.io === 'export' ? '复制下面这串代码，在另一台设备点「导入」粘贴即可' : '粘贴导出的代码（如 105.AAPL 116.00700），会追加到现有自选，重复的跳过'}</div>
      <textarea id="io-text" spellcheck="false" ${S.io === 'export' ? 'readonly' : ''}>${S.io === 'export' ? esc(S.watch.join(' ')) : ''}</textarea>
      <div class="group" style="display:flex;gap:6px;justify-content:flex-end">
        ${S.io === 'export' ? '<button class="btn primary" data-act="copy">复制</button>' : '<button class="btn primary" data-act="do-import">导入</button>'}
        <button class="btn" data-act="close-io">关闭</button></div></div>` : ''}` : '';
  $('#view-stocks').innerHTML = `
    <section class="hero"><div><h1>重点<em>股票</em></h1><p>美股、港股、A 股各挑了市值大、关注度高的一批；自选从顶部搜索添加。点表头排序，点一行看详情。</p></div>
      <div class="seg">${segs}</div></section>
    ${tools}
    <div class="panel"><div class="table-wrap" id="st-table">${stocksTable()}</div></div>
    <p class="note">数据来自东方财富，A 股、港股为实时或短时延迟，美股为延迟行情（盘前盘后不含）。市值、成交额为原币种。</p>`;
}
function stocksTable() {
  const g = S.stockGroup, ids = stockIds(g);
  if (!ids.length) return '<div class="empty">还没有自选。在顶部搜索框输入名称或代码，点 ☆ 添加</div>';
  let rows = ids.map((id, i) => ({ id, i, q: S.q[id] || { id, name: S.names[id] || id, code: id.split('.')[1] } }));
  const { key, dir } = S.sort;
  if (key && !(g === 'watch' && S.manage)) {
    rows.sort((a, b) => key === 'name' ? dir * String(a.q.name).localeCompare(String(b.q.name), 'zh')
      : ((a.q[key] ?? -Infinity) - (b.q[key] ?? -Infinity)) * dir);
  }
  const head = COLS.map(([k, l, c]) => `<th class="sort ${key === k ? 'sorted' : ''} ${c || ''}" data-sort="${k}">${l}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const body = rows.map(({ id, i, q }) => `<tr class="click" data-detail="${esc(id)}">
    <td><div class="nm"><b>${mkTag(mktOf(id))}${esc(q.name)}</b><small>${esc(q.code)}${q.ind ? ' · ' + esc(q.ind) : ''}</small></div></td>
    <td class="num"><b>${fmtPx(q.price)}</b></td>
    <td class="num"><span class="pct-pill ${cls(q.pct)}">${fmtPct(q.pct)}</span></td>
    <td class="num hide-m ${cls(q.chg)}">${fmtChg(q.chg, undefined, q.price)}</td>
    <td class="num hide-m">${fmtBig(q.amt)}</td>
    <td class="num hide-m">${fmtBig(q.cap)}</td>
    <td class="num hide-m">${q.pe ? q.pe.toFixed(1) : '—'}</td>
    <td class="num hide-m">${q.turn != null ? q.turn.toFixed(2) + '%' : '—'}</td>
    <td class="ops"><div class="row-ops">${g === 'watch' && S.manage
      ? `<button class="star" data-move="${i}:-1" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button><button class="star" data-move="${i}:1" title="下移" ${i === ids.length - 1 ? 'disabled' : ''}>↓</button><button class="star" data-star="${esc(id)}" title="删除">✕</button>`
      : starBtn(id, q.name)}</div></td>
  </tr>`).join('');
  return `<table><thead><tr>${head}<th></th></tr></thead><tbody>${body}</tbody></table>`;
}

// ── 视图：板块榜单 ──
// 行业板块接口混着申万一、二、三级（银行 / 银行Ⅱ / 国有大型银行Ⅲ），热力图只取 31 个一级行业
const SW1 = new Set(['农林牧渔', '基础化工', '钢铁', '有色金属', '电子', '家用电器', '食品饮料', '纺织服饰', '轻工制造', '医药生物', '公用事业',
  '交通运输', '房地产', '商贸零售', '社会服务', '综合', '建筑材料', '建筑装饰', '电力设备', '国防军工', '计算机', '传媒', '通信', '银行',
  '非银金融', '汽车', '机械设备', '煤炭', '石油石化', '环保', '美容护理']);
// 概念板块里有不少是指数成分、资金、风格、财报类的分组，不算题材，去掉
const CONCEPT_NOISE = /_$|股通|MSCI|富时|标准普尔|融资融券|重仓|增仓|持股|预增|预减|扭亏|昨日|AH股|破净|权重|大盘|中盘|小盘|风格|^深成|^上证|^深证|^创业板|^HS300|^中证|中特估|周期股|行业龙头|QFII|社保|养老金|举牌|ST股|次新|高送转|转债|B股|GDR|注册制|百元股|低价股|微盘|参股|IPO|分拆|超跌|减仓|破增|趋势|新高|市净率|热股|成份|价值股|红利股|茅指数|宁组合|贬值受益|升值受益|中字头|特区|长江三角|西部大开发|京津冀|粤港澳|成渝|东北振兴/;
const RANK_FS = { CN: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', HK: 'm:116+t:3,m:116+t:4', US: 'm:105,m:106,m:107' };
async function loadSectors() {
  const fs = S.sectorKind === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  const rows = await clist(fs, 'f3', 1, 500, 'f12,f14,f3,f20,f128,f136');
  S.sectors = { kind: S.sectorKind, rows: rows.filter(r => typeof r.f3 === 'number'), live: true };
}
async function loadRanks() {
  const m = S.rankMkt, by = S.rankBy;
  const [fid, po] = by === 'amt' ? ['f6', 1] : ['f3', by === 'gain' ? 1 : 0];
  let rows = await clist(RANK_FS[m], fid, po, 100, 'f2,f3,f4,f6,f12,f13,f14,f20');
  rows = rows.filter(r => typeof r.f2 === 'number' && typeof r.f3 === 'number');
  // 港美股涨跌榜里大量是成交极少的仙股，按成交额（原币种）≥ 2000 万过滤
  if (m !== 'CN' && by !== 'amt') rows = rows.filter(r => r.f6 >= 2e7 && (m !== 'US' || r.f2 >= 1));
  S.ranks = { mkt: m, by, rows: rows.slice(0, 15).map(r => ({ ...normQuote(r), cap: n(r.f20) })) };
}
function heatColor(p) {
  const k = Math.min(1, Math.abs(p) / 4);
  const c = p > 0 ? 'var(--up)' : p < 0 ? 'var(--down)' : 'var(--text-3)';
  return `background:color-mix(in srgb, ${c} ${Math.round(12 + k * 70)}%, var(--panel-solid))`;
}
function renderSectors() {
  const sec = S.sectors && S.sectors.kind === S.sectorKind ? S.sectors : (S.snap?.sectors?.[S.sectorKind] ? { rows: S.snap.sectors[S.sectorKind], live: false } : null);
  let heat = '<div class="empty">加载中…</div>', lists = '';
  const concept = S.sectorKind === 'concept';
  const rows = sec?.rows ? (concept ? sec.rows.filter(r => !CONCEPT_NOISE.test(r.f14)) : sec.rows) : [];
  if (rows.length) {
    const big = (concept ? rows.slice().sort((a, b) => (b.f20 || 0) - (a.f20 || 0)).slice(0, 60) : rows.filter(r => SW1.has(r.f14)))
      .sort((a, b) => b.f3 - a.f3);
    heat = `<div class="heat">${big.map(r => `<div class="ht" style="${heatColor(r.f3)}" title="${esc(r.f14)} 领涨 ${esc(r.f128)}">
      <b>${esc(r.f14)}</b><span class="num">${fmtPct(r.f3)}</span><small>${esc(r.f128 || '')}</small></div>`).join('')}</div>`;
    // 二、三级行业常常同名同涨幅（电视广播Ⅱ / 电视广播Ⅲ），列表里只留一个
    const seen = new Set();
    const sorted = rows.slice().sort((a, b) => b.f3 - a.f3)
      .filter(r => { const k = r.f14.replace(/[ⅡⅢ]$/, ''); return !seen.has(k) && seen.add(k); });
    const li = rs => rs.map(r => `<tr><td>${esc(r.f14)}</td><td class="num"><span class="pct-pill ${cls(r.f3)}">${fmtPct(r.f3)}</span></td>
      <td class="muted">${esc(r.f128 || '')}</td><td class="num ${cls(r.f136)}">${typeof r.f136 === 'number' ? fmtPct(r.f136) : ''}</td></tr>`).join('');
    const th = '<thead><tr><th>板块</th><th>涨跌幅</th><th>领涨股</th><th></th></tr></thead>';
    lists = `<div class="two" style="margin-top:14px">
      <div class="panel"><div class="section-title" style="margin:14px 14px 4px">领涨</div><div class="table-wrap"><table>${th}<tbody>${li(sorted.slice(0, 10))}</tbody></table></div></div>
      <div class="panel"><div class="section-title" style="margin:14px 14px 4px">领跌</div><div class="table-wrap"><table>${th}<tbody>${li(sorted.slice(-10).reverse())}</tbody></table></div></div>
    </div>`;
  }
  const r = S.ranks && S.ranks.mkt === S.rankMkt && S.ranks.by === S.rankBy ? S.ranks : null;
  const rank = r ? (r.rows.length ? `<table><thead><tr><th>#</th><th style="text-align:left">名称</th><th>最新价</th><th>涨跌幅</th><th class="hide-m">成交额</th><th class="hide-m">总市值</th><th></th></tr></thead><tbody>
    ${r.rows.map((q, i) => `<tr class="click" data-detail="${esc(q.id)}" data-name="${esc(q.name)}"><td class="muted num">${i + 1}</td>
      <td style="text-align:left"><div class="nm"><b>${esc(q.name)}</b><small>${esc(q.code)}</small></div></td>
      <td class="num"><b>${fmtPx(q.price)}</b></td><td class="num"><span class="pct-pill ${cls(q.pct)}">${fmtPct(q.pct)}</span></td>
      <td class="num hide-m">${fmtBig(q.amt)}</td><td class="num hide-m">${fmtBig(q.cap)}</td><td class="ops">${starBtn(q.id, q.name)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">暂无数据</div>') : '<div class="empty">加载中…</div>';

  $('#view-sectors').innerHTML = `
    <section class="hero"><div><h1>板块<em>榜单</em></h1><p>A 股行业 / 概念板块涨跌，以及 A 股、港股、美股的涨跌幅与成交额榜。交易时段每 ${SECTOR_EVERY / 1000} 秒刷新。</p></div></section>
    <h2 class="section-title">A 股板块热力图<small>${concept ? '按总市值取前 60 个概念' : '申万一级行业'}，颜色越深涨跌越大${sec && !sec.live ? ' · 快照数据' : ''}</small>
      <span class="spacer"></span><span class="seg">${[['industry', '行业'], ['concept', '概念']].map(([k, l]) => `<button data-sector="${k}" class="${S.sectorKind === k ? 'active' : ''}">${l}</button>`).join('')}</span></h2>
    <div class="panel">${heat}</div>
    ${lists}
    <h2 class="section-title">涨跌榜<small>${S.rankMkt !== 'CN' && S.rankBy !== 'amt' ? '已过滤成交额不足 2000 万的个股' : ''}</small><span class="spacer"></span>
      <span class="seg">${[['CN', 'A 股'], ['HK', '港股'], ['US', '美股']].map(([k, l]) => `<button data-rank-mkt="${k}" class="${S.rankMkt === k ? 'active' : ''}">${l}</button>`).join('')}</span>
      <span class="seg">${[['gain', '涨幅'], ['loss', '跌幅'], ['amt', '成交额']].map(([k, l]) => `<button data-rank-by="${k}" class="${S.rankBy === k ? 'active' : ''}">${l}</button>`).join('')}</span></h2>
    <div class="panel"><div class="table-wrap">${rank}</div></div>
    <p class="note">港股、美股暂无可用的行业板块数据，可看涨跌榜。数据来自东方财富。</p>`;
}

// ── 视图：嵌入模块（汇率 / 油价金价） ──
function mountFrame(name, sub) {
  const box = $('#view-' + name);
  let f = S.frames[name];
  if (!f) {
    f = document.createElement('iframe');
    f.className = 'frame';
    f.title = name === 'fx' ? '汇率' : '油价金价';
    f.src = `${name}.html?embed=1&theme=${document.documentElement.dataset.theme}${sub ? '#' + sub : ''}`;
    f.addEventListener('load', () => {
      const doc = f.contentDocument;
      if (!doc) return;
      const fit = () => { f.style.height = Math.max(600, doc.body.scrollHeight) + 'px'; };
      new ResizeObserver(fit).observe(doc.body);
      fit();
    });
    box.appendChild(f);
    S.frames[name] = f;
  } else if (sub) {
    f.contentDocument?.querySelector(`[data-view="${sub}"]`)?.click();
  }
}

// ── 详情弹层 ──
const PERIODS = [['trend', '分时'], ['101', '日K'], ['102', '周K'], ['103', '月K']];
async function openDetail(id, name) {
  S.detail = { id, name, period: store.get('period', 'trend'), data: null };
  $('#modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderDetail();
  if (!S.q[id]) { try { Object.assign(S.q, await fetchQuotes([id])); } catch {} renderDetail(); }
  loadDetailChart();
}
function closeDetail() {
  S.detail = null;
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
}
async function loadDetailChart() {
  const d = S.detail;
  if (!d || d.id.startsWith('coinbase.')) return;
  const { id, period } = d;
  try {
    const data = period === 'trend' ? await fetchSpark(id) : await fetchKline(id, period);
    if (S.detail?.id === id && S.detail.period === period) { S.detail.data = data; renderDetail(); }
  } catch {
    if (S.detail?.id === id && S.detail.period === period) { S.detail.data = 'error'; renderDetail(); }
  }
}
function renderDetail() {
  const d = S.detail;
  if (!d) return;
  const q = S.q[d.id] || {}, mkt = mktOf(d.id), dg = digitsFor(d.id);
  const stats = [
    ['今开', fmtPx(q.open, dg)], ['最高', fmtPx(q.high, dg)], ['最低', fmtPx(q.low, dg)], ['昨收', fmtPx(q.prev, dg)],
    ['成交额', fmtBig(q.amt)], ['总市值', fmtBig(q.cap)], ['市盈率TTM', q.pe ? q.pe.toFixed(2) : '—'], ['市净率', q.pb ? q.pb.toFixed(2) : '—'],
    ['换手率', q.turn != null ? q.turn.toFixed(2) + '%' : '—'], ['成交量', fmtBig(q.vol)], ['行业', esc(q.ind || '—')], ['更新', q.time ? mdhm(q.time) : '—'],
  ].filter(([, v]) => mkt || v !== '—');
  let chart;
  if (d.id.startsWith('coinbase.')) chart = '<div class="empty">比特币暂无图表</div>';
  else if (d.data === 'error') chart = '<div class="empty">图表数据加载失败</div>';
  else if (!d.data) chart = '<div class="empty">加载中…</div>';
  else chart = d.period === 'trend' ? trendChart(d.data, q) : klineChart(d.data);
  $('#sheet').innerHTML = `
    <div class="sheet-head"><div class="t">
      <h2>${mkTag(mkt)}${esc(q.name || d.name || d.id)}<small>${esc(q.code || d.id.split('.').pop())}</small></h2>
      <div class="sheet-px num"><b>${fmtPx(q.price, dg)}</b><span class="${cls(q.chg)}">${fmtChg(q.chg, dg, q.price)}</span><span class="${cls(q.pct)}">${fmtPct(q.pct)}</span></div>
    </div>${starBtn(d.id, q.name || d.name)}<button class="star" data-act="close-detail" title="关闭">✕</button></div>
    <div class="stats num">${stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
      <span class="seg">${PERIODS.map(([k, l]) => `<button data-period="${k}" class="${d.period === k ? 'active' : ''}">${l}</button>`).join('')}</span>
      <span class="muted" style="font-size:12px">${d.period === 'trend' ? '当日分时' : '前复权 · 最近 120 根'}</span></div>
    <div class="kchart" id="kchart">${chart}<div class="tip" id="ktip"></div></div>`;
  bindChartHover();
}
let CH = null;   // 当前详情图表的坐标信息，供悬停提示使用
function trendChart(sp, q) {
  const W = 760, H = 300, L = 6, R = 64, T = 10, B = 22;
  const vs = sp.pts.map(p => p.v), pre = sp.pre ?? vs[0];
  const min = Math.min(...vs, pre), max = Math.max(...vs, pre), pad = (max - min) * 0.06 || max * 0.002;
  const lo = min - pad, hi = max + pad, total = Math.max(sp.slots, vs.length) - 1 || 1;
  const x = i => L + i / total * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const c = (q?.price ?? vs[vs.length - 1]) >= pre ? 'var(--up)' : 'var(--down)';
  const line = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => { const v = lo + (hi - lo) * f, yy = y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${W - R + 6}" y="${yy + 4}" font-size="11" fill="var(--text-3)">${fmtPx(v)}</text>`; }).join('');
  const t0 = sp.pts[0].t.slice(11), t1 = sp.pts[sp.pts.length - 1].t.slice(11);
  CH = { kind: 'trend', W, H, x, y, pts: sp.pts.map((p, i) => ({ i, label: p.t.slice(5), v: p.v, pct: (p.v / pre - 1) * 100 })) };
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="ksvg">${grid}
    <line x1="${L}" x2="${W - R}" y1="${y(pre)}" y2="${y(pre)}" stroke="var(--text-3)" stroke-dasharray="4 4"/>
    <path d="${line}L${x(vs.length - 1)},${H - B}L${L},${H - B}Z" fill="${c}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--text-3)">${t0}</text><text x="${x(vs.length - 1)}" y="${H - 6}" font-size="11" fill="var(--text-3)" text-anchor="end">${t1}</text>
    <line id="kx" y1="${T}" y2="${H - B}" stroke="var(--line-2)" visibility="hidden"/></svg>`;
}
function klineChart(ks) {
  if (ks.length < 2) return '<div class="empty">暂无 K 线</div>';
  const W = 760, H = 300, L = 6, R = 64, T = 10, VOL = 56, B = 22;
  const priceH = H - T - B - VOL - 8;
  const lo0 = Math.min(...ks.map(k => k.l)), hi0 = Math.max(...ks.map(k => k.h)), pad = (hi0 - lo0) * 0.05 || hi0 * 0.01;
  const lo = lo0 - pad, hi = hi0 + pad, vmax = Math.max(...ks.map(k => k.v)) || 1;
  const step = (W - L - R) / ks.length, bw = Math.max(1, step * 0.65);
  const x = i => L + step * (i + 0.5), y = v => T + (1 - (v - lo) / (hi - lo)) * priceH;
  const vy = v => H - B - v / vmax * VOL;
  const candles = ks.map((k, i) => {
    const c = k.c >= k.o ? 'var(--up)' : 'var(--down)', xx = x(i);
    const top = y(Math.max(k.o, k.c)), h = Math.max(1, Math.abs(y(k.o) - y(k.c)));
    return `<line x1="${xx}" x2="${xx}" y1="${y(k.h)}" y2="${y(k.l)}" stroke="${c}"/>
      <rect x="${xx - bw / 2}" y="${top}" width="${bw}" height="${h}" fill="${c}"/>
      <rect x="${xx - bw / 2}" y="${vy(k.v)}" width="${bw}" height="${H - B - vy(k.v)}" fill="${c}" opacity=".45"/>`;
  }).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => { const v = lo + (hi - lo) * f, yy = y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${W - R + 6}" y="${yy + 4}" font-size="11" fill="var(--text-3)">${fmtPx(v)}</text>`; }).join('');
  CH = { kind: 'k', W, H, x, y, pts: ks.map((k, i) => ({ i, k, prev: i ? ks[i - 1].c : k.o })) };
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="ksvg">${grid}${candles}
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--text-3)">${ks[0].t}</text><text x="${W - R}" y="${H - 6}" font-size="11" fill="var(--text-3)" text-anchor="end">${ks[ks.length - 1].t}</text>
    <line id="kx" y1="${T}" y2="${H - B}" stroke="var(--line-2)" visibility="hidden"/></svg>`;
}
function bindChartHover() {
  const box = $('#kchart'), svg = $('#ksvg'), tip = $('#ktip');
  if (!box || !svg || !CH) return;
  const move = e => {
    const r = svg.getBoundingClientRect();
    const cx = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * CH.W;
    let best = CH.pts[0];
    for (const p of CH.pts) if (Math.abs(CH.x(p.i) - cx) < Math.abs(CH.x(best.i) - cx)) best = p;
    const px = CH.x(best.i);
    const kx = $('#kx'); kx.setAttribute('x1', px); kx.setAttribute('x2', px); kx.setAttribute('visibility', 'visible');
    if (CH.kind === 'trend') {
      tip.innerHTML = `${esc(best.label)}<br><b class="num">${fmtPx(best.v)}</b> <span class="${cls(best.pct)}">${fmtPct(best.pct)}</span>`;
    } else {
      const k = best.k, pct = (k.c / best.prev - 1) * 100;
      tip.innerHTML = `${esc(k.t)} <span class="${cls(pct)}">${fmtPct(pct)}</span><br><span class="num">开 ${fmtPx(k.o)} 高 ${fmtPx(k.h)}<br>低 ${fmtPx(k.l)} 收 <b>${fmtPx(k.c)}</b></span>`;
    }
    tip.style.display = 'block';
    const left = px / CH.W * r.width;
    tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
    tip.style.top = '0px';
  };
  const leave = () => { tip.style.display = 'none'; $('#kx')?.setAttribute('visibility', 'hidden'); };
  box.addEventListener('mousemove', move); box.addEventListener('touchmove', move, { passive: true });
  box.addEventListener('mouseleave', leave); box.addEventListener('touchend', leave);
}

// ── 搜索 ──
const SR = { items: [], hl: -1, seq: 0, timer: null };
function renderSearch() {
  const pop = $('#search-pop'), q = $('#q').value.trim();
  if (!q) { pop.innerHTML = '<div class="sr-tip">支持名称、代码、拼音首字母（如 gzmt）。A 股、港股、美股可点 ☆ 加入自选；按 / 快速聚焦</div>'; return; }
  if (!SR.items.length) { pop.innerHTML = `<div class="sr-tip">${SR.loading ? '搜索中…' : '没有找到「' + esc(q) + '」'}</div>`; return; }
  pop.innerHTML = SR.items.map((it, i) => {
    const qt = S.q[it.id];
    return `<div class="sr ${i === SR.hl ? 'hl' : ''}" data-detail="${esc(it.id)}" data-name="${esc(it.name)}">
      <div class="nm"><b>${mkTag(it.mkt)}${esc(it.name)}</b><small>${esc(it.code)} · ${esc(it.type)}</small></div>
      <div class="px num">${qt ? `${fmtPx(qt.price)}<small class="${cls(qt.pct)}">${fmtPct(qt.pct)}</small>` : ''}</div>
      ${starBtn(it.id, it.name) || '<span style="width:30px"></span>'}</div>`;
  }).join('');
}
function onSearchInput() {
  clearTimeout(SR.timer);
  const q = $('#q').value.trim();
  $('#search-pop').classList.add('open');
  if (!q) { SR.items = []; renderSearch(); return; }
  SR.loading = true;
  SR.timer = setTimeout(async () => {
    const seq = ++SR.seq;
    try {
      const items = await searchStocks(q);
      if (seq !== SR.seq) return;
      SR.items = items; SR.hl = items.length ? 0 : -1; SR.loading = false;
      renderSearch();
      const ids = items.map(x => x.id).filter(id => !S.q[id] || Date.now() - (S.q[id]._at || 0) > 10000);
      if (ids.length) {
        const qs = await fetchQuotes(ids).catch(() => ({}));
        Object.values(qs).forEach(x => { x._at = Date.now(); });
        Object.assign(S.q, qs);
        if (seq === SR.seq) renderSearch();
      }
    } catch {
      if (seq === SR.seq) { SR.items = []; SR.loading = false; $('#search-pop').innerHTML = '<div class="sr-tip">搜索服务暂时连不上，稍后再试</div>'; }
    }
  }, 250);
}

// ── 刷新调度 ──
function pollIds() {
  const ids = new Set();
  S.cfg.indices.forEach(g => g.items.forEach(it => ids.add(it.id)));
  S.cfg.quick.forEach(it => ids.add(it.id));
  S.watch.forEach(id => ids.add(id));
  if (S.tab === 'stocks' && S.stockGroup && S.stockGroup !== 'watch') stockIds(S.stockGroup).forEach(id => ids.add(id));
  if (S.detail) ids.add(S.detail.id);
  return [...ids];
}
async function refreshQuotes() {
  try {
    const qs = await fetchQuotes(pollIds());
    Object.values(S.q).forEach(q => { S.prevPx[q.id] = q.price; });
    Object.assign(S.q, qs);
    S.live = Date.now(); S.liveErr = false;
  } catch {
    S.liveErr = true;
    applySnapshot();
  }
  updateStatus();
}
let lastSpark = 0;
async function refreshSparks(force) {
  if (!force && Date.now() - lastSpark < SPARK_EVERY) return;
  lastSpark = Date.now();
  const items = S.cfg.indices.flatMap(g => g.items).filter(it => !it.id.startsWith('coinbase.'));
  await Promise.all(items.map(async it => {
    // 休市的市场只在第一次加载时取一次
    if (!force && S.spark[it.id] && it.mkt !== '24H' && !['open', 'pre'].includes(mstatus(it.mkt).key)) return;
    try { S.spark[it.id] = await fetchSpark(it.id); } catch {}
  }));
}
let lastSector = 0;
async function refreshSectors(force) {
  if (S.tab !== 'sectors') return;
  if (!force && Date.now() - lastSector < SECTOR_EVERY) return;
  lastSector = Date.now();
  await Promise.all([loadSectors().catch(() => {}), loadRanks().catch(() => { S.ranks = { mkt: S.rankMkt, by: S.rankBy, rows: [] }; })]);
}
function applySnapshot() {
  if (!S.snap) return;
  Object.values(S.snap.quotes || {}).forEach(raw => { const q = normQuote(raw); if (!S.q[q.id]) S.q[q.id] = q; });
}
function updateStatus() {
  const dot = $('#live-dot'), st = $('#status');
  if (S.live && !S.liveErr) { dot.className = 'live-dot'; st.textContent = `实时 · ${hm(S.live)}`; }
  else if (S.snap) { dot.className = 'live-dot stale'; st.textContent = `快照 · ${mdhm(S.snap.updated)}`; }
  else { dot.className = 'live-dot idle'; st.textContent = '连接失败'; }
}
let tickTimer = null, ticking = false;
async function tick(force) {
  clearTimeout(tickTimer);
  if (ticking) return;
  ticking = true;
  const btn = $('#refresh');
  if (force) btn.classList.add('spin');
  try {
    if (!document.hidden || force) {
      await refreshQuotes();
      await Promise.all([refreshSparks(force), refreshSectors(force)]);
      rerender(true);
    }
  } finally {
    ticking = false;
    btn.classList.remove('spin');
    tickTimer = setTimeout(tick, anyOpen() ? REFRESH_OPEN : REFRESH_IDLE);
  }
}

// ── 渲染与路由 ──
function rerender(fromTick) {
  const t = S.tab;
  if (t === 'overview') renderOverview();
  else if (t === 'stocks') { if (fromTick && $('#st-table')) $('#st-table').innerHTML = stocksTable(); else renderStocks(); }
  else if (t === 'sectors') renderSectors();
  if (S.detail) renderDetailHeadOnly(fromTick);
  if ($('#search-pop').classList.contains('open')) renderSearch();
}
// 定时刷新时只更新详情的报价，不重画图表（否则悬停提示会闪）
function renderDetailHeadOnly(fromTick) {
  if (!fromTick) { renderDetail(); return; }
  const q = S.q[S.detail.id];
  const box = $('#sheet .sheet-px');
  if (!q || !box) return;
  const dg = digitsFor(S.detail.id);
  box.innerHTML = `<b>${fmtPx(q.price, dg)}</b><span class="${cls(q.chg)}">${fmtChg(q.chg, dg, q.price)}</span><span class="${cls(q.pct)}">${fmtPct(q.pct)}</span>`;
}
const TABS = ['overview', 'stocks', 'sectors', 'fx', 'oilgold'];
function route() {
  const [tab, sub] = location.hash.slice(1).split('/');
  S.tab = TABS.includes(tab) ? tab : 'overview';
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + S.tab; });
  if (S.tab === 'fx' || S.tab === 'oilgold') mountFrame(S.tab, sub);
  else {
    rerender();
    if (S.tab === 'sectors') refreshSectors(true).then(() => S.tab === 'sectors' && renderSectors());
    if (S.tab === 'stocks') refreshQuotes().then(() => S.tab === 'stocks' && rerender(true));
  }
}

// ── 事件 ──
document.addEventListener('click', e => {
  const t = e.target;
  const star = t.closest('[data-star]');
  if (star) { e.stopPropagation(); toggleWatch(star.dataset.star, star.dataset.name); if (S.detail) renderDetail(); return; }
  const mv = t.closest('[data-move]');
  if (mv) {
    const [i, d] = mv.dataset.move.split(':').map(Number), j = i + d;
    if (j >= 0 && j < S.watch.length) { [S.watch[i], S.watch[j]] = [S.watch[j], S.watch[i]]; saveWatch(); rerender(); }
    return;
  }
  if (t.closest('[data-act="close-detail"]') || t.id === 'modal') { closeDetail(); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { location.hash = tab.dataset.tab; return; }
  const goto = t.closest('[data-goto]');
  if (goto) { location.hash = goto.dataset.goto; window.scrollTo({ top: 0 }); return; }
  const grp = t.closest('[data-group]');
  if (grp) {
    e.preventDefault();
    S.stockGroup = grp.dataset.group; store.set('stockGroup', S.stockGroup);
    S.io = null;
    if (S.tab !== 'stocks') location.hash = 'stocks'; else { renderStocks(); refreshQuotes().then(() => rerender(true)); }
    return;
  }
  const so = t.closest('[data-sort]');
  if (so) {
    const k = so.dataset.sort;
    S.sort = S.sort.key !== k ? { key: k, dir: -1 } : S.sort.dir === -1 ? { key: k, dir: 1 } : { key: null, dir: -1 };
    store.set('sort', S.sort);
    $('#st-table').innerHTML = stocksTable();
    return;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'manage') { S.manage = !S.manage; renderStocks(); return; }
  if (act === 'export' || act === 'import') { S.io = S.io === act ? null : act; renderStocks(); if (S.io) $('#io-text')?.focus(); return; }
  if (act === 'close-io') { S.io = null; renderStocks(); return; }
  if (act === 'copy') {
    const ta = $('#io-text'); ta.select();
    navigator.clipboard?.writeText(ta.value).then(() => { t.textContent = '已复制'; }, () => { t.textContent = '请手动复制'; });
    return;
  }
  if (act === 'do-import') {
    const ids = ($('#io-text').value.match(/\b\d{1,3}\.[A-Za-z0-9_]+\b/g) || []).filter(id => mktOf(id));
    const add = ids.filter(id => !inWatch(id));
    S.watch.push(...new Set(add)); saveWatch();
    S.io = null; renderStocks();
    refreshQuotes().then(() => rerender(true));
    return;
  }
  const sec = t.closest('[data-sector]');
  if (sec) { S.sectorKind = sec.dataset.sector; store.set('sectorKind', S.sectorKind); renderSectors(); loadSectors().then(renderSectors, () => {}); return; }
  const rm = t.closest('[data-rank-mkt],[data-rank-by]');
  if (rm) {
    if (rm.dataset.rankMkt) { S.rankMkt = rm.dataset.rankMkt; store.set('rankMkt', S.rankMkt); }
    if (rm.dataset.rankBy) { S.rankBy = rm.dataset.rankBy; store.set('rankBy', S.rankBy); }
    renderSectors();
    loadRanks().catch(() => { S.ranks = { mkt: S.rankMkt, by: S.rankBy, rows: [] }; }).then(renderSectors);
    return;
  }
  const per = t.closest('[data-period]');
  if (per && S.detail) { S.detail.period = per.dataset.period; S.detail.data = null; store.set('period', S.detail.period); renderDetail(); loadDetailChart(); return; }
  const det = t.closest('[data-detail]');
  if (det) {
    $('#search-pop').classList.remove('open');
    openDetail(det.dataset.detail, det.dataset.name);
    return;
  }
  if (!t.closest('#search')) $('#search-pop').classList.remove('open');
});

$('#q').addEventListener('input', onSearchInput);
$('#q').addEventListener('focus', () => { $('#search-pop').classList.add('open'); renderSearch(); });
$('#q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!SR.items.length) return;
    SR.hl = (SR.hl + (e.key === 'ArrowDown' ? 1 : -1) + SR.items.length) % SR.items.length;
    renderSearch();
  } else if (e.key === 'Enter' && SR.items[SR.hl]) {
    const it = SR.items[SR.hl];
    $('#search-pop').classList.remove('open'); $('#q').blur();
    openDetail(it.id, it.name);
  } else if (e.key === 'Escape') {
    $('#search-pop').classList.remove('open'); $('#q').blur();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.detail) closeDetail();
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); $('#q').focus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
window.addEventListener('hashchange', route);

// ── 主题 ──
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  Object.values(S.frames).forEach(f => { try { f.contentDocument.documentElement.dataset.theme = t; } catch {} });
}
applyTheme(store.get('theme', 'dark'));
$('#theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t); store.set('theme', t);
});
$('#refresh').addEventListener('click', () => {
  tick(true);
  // 嵌入的模块各自有 load()，顺带重新读取它们的数据文件
  Object.values(S.frames).forEach(f => { try { f.contentWindow.load(true); } catch {} });
});

// ── 启动 ──
(async function init() {
  try {
    S.cfg = await fetch('config.json', { cache: 'no-cache' }).then(r => r.json());
  } catch {
    $('#view-overview').innerHTML = '<div class="panel empty">配置加载失败。本地预览需通过 HTTP 服务打开（python3 -m http.server）</div>';
    return;
  }
  fetch('market.json', { cache: 'no-cache' }).then(r => r.json()).then(d => {
    S.snap = d;
    if (!S.live) { applySnapshot(); updateStatus(); if (!['fx', 'oilgold'].includes(S.tab)) rerender(); }
  }).catch(() => {});
  route();
  tick(true);
})();
