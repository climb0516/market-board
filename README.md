# 📊 Market Board · 市场看板

> A 股、港股、美股与日韩欧主要指数实时行情，重点股票与自选（支持搜索任意股票），A 股板块热力图与港美 A 涨跌榜；汇率、油价金价作为其中两个模块

**🌐 在线访问：[https://climb0516.github.io/market-board/](https://climb0516.github.io/market-board/)**

---

## 功能

**总览**（首页）
- 三大指数主区：上证、恒指、纳指100，大号数字 + 当日分时，底色随涨跌
- 今日异动：重点股票里涨跌幅最大的 8 只，带公司 logo
- 各市场交易状态：A 股 / 港股 / 美股 / 日本 / 韩国 / 欧洲，交易中、午休、盘前、已收盘，附当地时间
- 指数卡片 + 当日分时迷你图：
  - A 股：上证、深成、创业板、沪深300、科创50
  - 港股：恒指、国企、恒生科技
  - 美股：道指、标普、纳指100；美股期指
  - 日韩欧及其他：日经、KOSPI、DAX、富时100、CAC40、美债 10 年收益率、美元指数、比特币
- A 股市场宽度（上涨 / 平盘 / 下跌家数、两市成交额）、我的自选前 8 只、汇率 · 黄金 · 原油速览（点击进入对应模块）

**重点股票**
- 美股、港股、A 股各 17～18 只，名单在 `config.json` 里改；每只都带公司 logo
- 列表 / 卡片两种视图（默认列表），卡片视图带当日分时迷你图
- 我的自选：顶部搜索框搜任意 A 股 / 港股 / 美股（名称、代码、拼音首字母，按 `/` 聚焦），点 ☆ 加入
- 管理模式可上移 / 下移 / 删除；导出 / 导入一串代码，在不同设备间同步
- 点表头排序；点一行打开**详情抽屉**（电脑上从右侧滑出、占半屏，开着时可直接点左边其他股票切换；手机上从底部升起半屏，上拉全屏、下拉收回或关闭）：
  - 行情：开高低收、成交额、市值、市盈率、市净率、换手率，分时 / 日 K / 周 K / 月 K（悬停看数值）
  - 公司简介：全称、英文名、行业、董事长、成立 / 上市日期、员工人数、注册地、官网，公司介绍（可展开）；港股、A 股另有主营业务
  - 相关资讯：8 条，标题、摘要、来源、时间，点击打开原文；底部「更多资讯」跳东方财富搜索
  - 顶部「行情 / 简介 / 资讯」导航，点击跳转，滚动时自动高亮

**板块榜单**
- A 股板块热力图：申万一级行业（31 个），或按市值前 60 的概念板块（已去掉指数成分、资金、风格类分组）；格子按市值分大小，大板块占 2×2 / 2×1 格
- 领涨 / 领跌板块 + 领涨股
- 涨跌榜：A 股 / 港股 / 美股 × 涨幅 / 跌幅 / 成交额，前 15；港美股过滤成交额不足 2000 万的仙股

**汇率**（原 [FX Board](https://github.com/climb0516/fx-board)）：港美股折算、7 个货币对行情、走势、银行换汇点差

**油价金价**（原 [OilGold](https://github.com/climb0516/oil-gold)）：调价窗口与本轮预测、各省油价、国际 / 国内金价、品牌首饰与银行金条溢价

汇率、油价金价两个模块嵌入后背景、面板、文字和涨跌色与主站统一，只保留各自的强调色。

右上角：实时 / 快照状态，↻ 立即刷新，⚡ 跳转 GitHub Actions 手动抓取，☾ 深浅色（嵌入模块同步）；手机适配。国内习惯涨红跌绿。自选、排序、主题等只存在本机浏览器。

---

## 技术架构

```
GitHub Actions（触发：每小时第 23 分钟 / 手动 dispatch / push 修改爬虫、config.json 或 workflow）
  ↓ python scraper.py（Python 3.12，只用标准库；用 runpy 依次跑 scrapers/ 下的模块，某个失败不影响其他）
  ├─ scrapers/market.py   行情 + A 股板块快照 → market.json；缺的股票 logo → logos/     每次
  ├─ scrapers/fx.py       汇率 → fx.json                                               每次（银行牌价盘中会变）
  └─ scrapers/oilgold.py  油价金价 → oilgold.json                                      北京时间 10、17 点；手动 / push 时；超过 20 小时没更新也补跑
  ↓ git commit market.json + fx.json + oilgold.json + logos/（updated 每次都变 = 心跳）→ push
       ↓
GitHub Pages
  ├─ index.html + app.js   总览 / 重点股票 / 板块榜单：浏览器直连东方财富实时行情，连不上时读 market.json 快照
  │                        点股票 → 详情抽屉（电脑右侧半屏、手机底部半屏，不写进地址）
  ├─ fx.html               汇率模块，以 iframe 嵌入（?embed=1 隐藏自身顶栏，高度随内容撑开）
  └─ oilgold.html          油价金价模块，同上
```

---

## 数据来源

**主页行情（浏览器直连，`app.js`）**

| 来源 | 方式 | 每次条数 / 范围 | 备注 |
|---|---|---|---|
| 东方财富行情 `push2` / `push2his` | 接口（JSONP） | 指数、速览、重点股票、自选、当前打开的详情一次批量请求；分时、日 / 周 / 月 K；A 股行业 / 概念板块（最多 500 条）；涨跌榜每市场取 100 条显示前 15 | 有市场在交易（含盘前）时每 15 秒刷新，否则每 60 秒；后台标签页暂停 |
| 东方财富搜索 | 接口（JSONP） | 输入后 250ms 防抖 | 名称、代码、拼音首字母 |
| 东方财富 F10 数据中心 | 接口（JSON） | 打开详情时取一条 | 美股 `RPT_USF10_INFO_ORGPROFILE`、港股 `RPT_HKF10_INFO_ORGPROFILE`、A 股 `RPT_F10_BASIC_ORGINFO` |
| 东方财富资讯搜索 | 接口（JSONP） | 搜 20 条，显示 8 条 | 标题提到公司名或代码的 ≥ 4 条时只用这些 |
| Coinbase | 接口 | 比特币 24 小时行情 1 条 | 不走快照 |
| [FinancialModelingPrep](https://financialmodelingprep.com) 图床 | 图片 | 重点股票 logo | 重点股票由抓取脚本下载到 `logos/`；其他股票在线加载，失败时显示首字头像 |

**快照与嵌入模块（GitHub Actions 抓取）**

| 来源 | 方式 | 每次条数 / 范围 | 备注 |
|---|---|---|---|
| 东方财富行情（`market.py`） | 接口 | `config.json` 里的指数、速览、重点股票（比特币除外），每批 80 个；当前 77 个 | 实时接口连不上时前端兜底，页面标「快照」 |
| 东方财富板块（`market.py`） | 接口 | A 股行业（`m:90+t:2`）、概念（`m:90+t:3`）全量，每页 100 条、最多 8 页 | 失败时沿用上一份 |
| FMP 图床（`market.py`） | 图片下载 | `config.json` 重点股票里 `logos/` 还没有的 | 校验 PNG 文件头 |
| [Frankfurter](https://www.frankfurter.app)（`fx.py`） | 接口（两个域名互为备用） | 最近 370 天 USD 基准汇率；保留 400 天 | 欧洲央行数据，工作日更新 |
| 中国外汇交易中心（`fx.py`） | 接口（需 Referer） | 最近 15 天人民币中间价，每次只请求一次 | 限流严格，连续请求几次就 403 |
| 中国银行外汇牌价（`fx.py`） | 网页解析 | USD / HKD / JPY / EUR 兑人民币 4 条 | 现汇买入 / 现汇卖出 / 中行折算价 |
| 招商银行外汇牌价（`fx.py`） | 接口（需 Referer） | 同上 4 条 | |
| 中银香港（`fx.py`） | 网页解析 | USD/HKD、USD/CNH、USD/JPY、EUR/USD 4 条 | |
| open.er-api（`fx.py`） | 接口 | 4 个币种 | 参考汇率最后兜底 |
| 东方财富数据中心（`oilgold.py`） | 接口 | 调价记录 40 条（`RPTA_WEB_YJ_BD`）；各省油价 2 页 × 500 条（`RPTA_WEB_YJ_JH`），每省保留 30 条历史 | |
| 汽油价格网 qiyoujiage.com（`oilgold.py`） | 网页解析 | 各省 98# 油价 | 东方财富没有 98# |
| 东方财富行情 + K 线（`oilgold.py`） | 接口 | 布伦特、WTI、伦敦金、COMEX 黄金、上金所 AU9999、黄金 T+D、美元/离岸人民币 7 个；布伦特日线 560 天、AU9999 / 伦敦金日线 400 天 | 实时取不到 → 日线最近两天收盘 → 新浪（仅原油、国际金价） → 上次数据 |
| holiday-cn（`oilgold.py`） | 接口 | 去年～明年 | 只用来算工作日 / 调价窗口 |
| huilvbiao.com / jinjia.com.cn（`oilgold.py`） | 网页解析 | 品牌首饰金价、银行投资金条、回收价；品牌金价涨跌 | 两站品牌名用 `BRAND_ALIAS` 统一后合并 |

**配置位置**
- 指数、速览、重点股票名单：`config.json`（前端和 `market.py` 共用）。id 是东方财富行情代码：`1.` 沪、`0.` 深、`116.` 港、`105/106/107.` 美；`mkt` 决定开收盘判断（CN/HK/US/JP/KR/UK/DE/FR，`24H` 不显示状态）
- 前端：`app.js` 顶部 `REFRESH_OPEN = 15000`、`REFRESH_IDLE = 60000`、`SPARK_EVERY = 60000`、`SECTOR_EVERY = 30000`，交易时段 `SESS`，判断休市用的代表行情 `MKT_REP`，涨跌榜范围 `RANK_FS`，概念板块过滤 `CONCEPT_NOISE`，申万一级行业名单 `SW1`
- 汇率：`scrapers/fx.py` 的 `CCYS`、`HISTORY_DAYS = 400`、`SPREAD_DAYS = 90`、`BANKS`（银行列表）
- 油价金价：`scrapers/oilgold.py` 的 `QUOTES`、`SINA_FALLBACK`、`WINDOW_DAYS = 10`、`STRAND_TON = 50`、`ADJ_KEEP = 40`、`PROVINCE_HIST = 30`、`BRAND_ALIAS`
- 运行哪些模块：`scraper.py` 的 `MODULES` 和 `oilgold_due()`

**增删来源**：重点股票只改 `config.json`（下次抓取自动补 logo）；加银行牌价在 `fx.py` 写一个返回 `(quotes, 时间)` 的函数并加进 `BANKS`；加金价 / 油价行情在 `oilgold.py` 的 `QUOTES` 加一行；新增整个模块就在 `scrapers/` 放一个脚本并加进 `scraper.py` 的 `MODULES`，同时把输出文件加进 workflow 的 `git add`。

**限制**
- 美股为延迟行情，不含盘前盘后
- 节假日没有内置日历：交易时段内代表行情的时间戳 20 分钟没变就判为休市
- 港股、美股暂无可用的行业板块数据，只有涨跌榜
- 东方财富是非公开接口，字段或限流可能变化
- 油价调价预测是粗略估算（官方算法用三地原油加权且细节不公开）

---

## 数据处理规则

**调度 `scraper.py`**
- 不带参数：每次跑 `market`、`fx`；`oilgold_due()` 为真时再跑 `oilgold`——事件是手动 dispatch 或 push、北京时间小时数为 10 或 17、或 oilgold.json 的 `updated` 距今超过 20 小时
- `python3 scraper.py all` 三个都跑；`python3 scraper.py market fx` 只跑指定的

**行情快照 `market.py`**
- 字段保持东方财富原样（f2 最新价、f3 涨跌幅、f12 代码、f13 市场、f14 名称…），前端用同一套 `normQuote()` 解析
- 某个代码返回 `"-"`（取不到）时跳过，沿用上一份；名单里删掉的代码不再保留
- `fmp_symbol()`：`105.AAPL → AAPL`、`106.BRK_B → BRK-B`、`116.00700 → 0700.HK`、`1.600519 → 600519.SS`、深市 `.SZ`、北交所（4 / 8 / 92 开头）`.BJ`

**前端行情（app.js）**
- 交易状态 `mstatus()`：按各交易所时区和 `SESS` 时段判断 交易中 / 集合竞价 / 盘前 / 盘后 / 午休 / 未开盘 / 已收盘；周末休市；交易时段内代表行情 20 分钟没更新判为休市
- 实时请求失败时 `applySnapshot()` 用 market.json 补上还没有的行情，顶栏显示「快照 · 时间」
- 迷你分时：休市市场只在首次加载取一次；卡片视图的个股分时只取当前分组
- 板块热力图：行业只取申万一级 31 个；概念先用 `CONCEPT_NOISE` 去掉指数成分、资金、风格、财报类分组，再按市值取前 60；按市值排序，行业前 3 / 概念前 4 占 2×2 格，行业前 9 / 概念前 12 占 2×1 格；颜色深浅 = |涨跌幅| / 4%（封顶）
- 领涨 / 领跌：各取 10 个，二、三级行业同名（Ⅱ / Ⅲ）只留一个
- 涨跌榜：涨幅 / 跌幅按 f3、成交额按 f6 排序；港美股涨跌幅榜过滤成交额 < 2000 万（原币种），美股另过滤股价 < 1
- 自选导入：从文本里正则提取 `市场号.代码`，只接受 A / 港 / 美三个市场

**汇率 `fx.py`**（所有汇率统一存成「1 USD = x 该币」）
- 银行牌价 `quote()`：每 100 外币报价除以 100；`mid = (买入 + 卖出) / 2`，点差 `spread = (卖出 − 买入) / mid × 100`（%）
- 参考汇率优先级：HKD / JPY / EUR 用中银香港实时中值，CNY 用中国银行现汇买卖中值；取不到依次用欧洲央行最新一天、open.er-api
- 中间价：100JPY/CNY 除以 100，统一成「1 外币 = x CNY」，作为前端可切换的「官方口径」
- 银行抓取失败时沿用旧快照并标 `stale`；点差历史每天保留当天最后一次，最多 90 天

**油价金价 `oilgold.py`**
- 工作日：holiday-cn 的放假 / 调休，没有数据的年份按周一到周五
- 调价窗口 `windows()`：从上次实际调价日起每 10 个工作日一个窗口，已过去的窗口记为 `windows_passed`（搁浅），下一个为 `next_window`
- 调价估算 `oil_estimate()`：比较「上次调价前 10 个工作日」与「上次调价后至今工作日」的布伦特均价，差值 × 美元/离岸人民币 × 7.33 桶/吨 × 1.13 增值税 = 元/吨；用历次调价回测按最小二乘拟合缩放系数 `k`；|估算| < 50 元/吨判「搁浅」，否则上调 / 下调；同时给出回测平均误差 `mae` 和方向命中率
- 吨 → 升：历次调价时各省每升涨跌额 / 每吨调幅的中位数（取不到时汽油按 1/1300、柴油按 1/1180）；柴油调幅 = 汽油 × 历次比例中位数（默认 0.96）
- 全国均价：各省 92# / 95# / 98# / 0# 的简单平均
- 金价溢价：品牌首饰金价、银行金条价相对上金所 AU9999 的溢价 %；伦敦金折人民币每克 = XAU × 美元/离岸人民币 / 31.1035
- 美元/离岸人民币取不到时按 7.1 计算

---

## 数据结构

**market.json**（行情快照）

```
{
  "updated": "2026-10-22T09:36:42+08:00",          // 北京时间，每次运行都变（心跳）
  "quotes": { "105.AAPL": { "f2": 343.99, "f3": 1.32, "f12": "AAPL", "f13": 105, "f14": "苹果", ... } },   // 东方财富原始字段
  "sectors": { "industry": [ { "f12", "f14", "f3", "f20", "f128", "f136" } ],     // 名称、涨跌幅、总市值、领涨股、领涨股涨跌幅
               "concept":  [ ... ] },
  "sources": [ { "name": "行情快照", "ok": true, "count": 77, "error": "" } ]
}
```

**fx.json**（汇率）

```
{
  "updated": "...",
  "ref": { "base": "USD", "rates": { "USD": 1.0, "HKD": 7.8468, "CNY": 6.67765, "JPY": 158.098555, "EUR": 0.890151 },
           "source": { "HKD": "中银香港", "CNY": "中国银行现汇中值", ... } },
  "cfets":   { "2026-10-22": { "USD": 6.7195, "EUR": 7.5244, "JPY": 0.042381, "HKD": 0.8564 } },       // 1 外币 = x CNY
  "history": { "2026-10-21": { "CNY": 6.6761, "EUR": 0.89015, "HKD": 7.8472, "JPY": 157.88 } },   // 最多 400 天
  "banks": [ { "id": "boc", "name": "中国银行", "region": "内地", "time": "...", "stale": false,
               "quotes": [ { "pair": "USD/CNY", "bid", "ask", "mid", "spread", "ref?" } ] } ],
  "spread_history": { "2026-10-22": { "boc:EUR/CNY": 0.7295, ... } },                         // 最多 90 天
  "sources": [ { "name", "ok", "updated", "count?", "error?" } ]
}
```

**oilgold.json**（油价金价，带缩进格式化）

```
{
  "updated": "...",
  "oil": {
    "adjustments": [ { "date", "gas", "diesel", "gas_chg", "diesel_chg" } ],               // 40 条调价记录
    "provinces": { "北京": { "date", "v89", "v92", "v95", "v98", "v0", "zde92", "zde95", "zde0",
                             "hist": [ [date, v92, v95, v0], ... ] } },                     // 每省最多 30 条
    "crude": { "brent": { "price", "prev", "chg_pct", "time", "daily?", "stale?" }, "wti": {...} },
    "brent_hist": [ [date, close], ... ],                                                   // 最近 180 条
    "last_adj": {...}, "windows_passed": ["2026-10-15"],
    "next_window": { "date": "2026-10-29", "days": 8, "holiday_data": true },
    "estimate": { "base_avg", "cur_avg", "est_ton", "est_liter92", "est_diesel_ton", "verdict",
                  "k", "per_liter", "per_liter_diesel", "diesel_k", "mae", "direction_hit", "backtest": [最多 24 条] },
    "national": { "v92", "v95", "v98", "v0" }
  },
  "gold": {
    "quotes": { "xau", "gc", "au9999", "autd", "usdcnh" },
    "xau_cny_g": 884.43,
    "brands":  [ { "name", "gold", "platinum", "bar", "date", "gold_chg", "premium" } ],
    "banks":   [ { "name", "price", "premium" } ],
    "recycle": [ { "name", "price", "date" } ],
    "au_hist": [ [date, close] ], "xau_hist": [ [date, close] ]
  },
  "sources": [ { "name", "ok", "error", "count" } ]
}
```

**其他文件**

| 文件 | 说明 |
|---|---|
| `config.json` | 指数分组（`indices`）、速览（`quick`，带跳转的嵌入模块 `tab`）、重点股票名单（`stocks.US / HK / CN`） |
| `logos/` | 重点股票的 logo，文件名为行情代码（如 `116.00700.png`）；`config.json` 加了新股票后，下次抓取自动补下载 |
| `app.js` | 主页逻辑。改完把 `index.html` 里 `app.js?v=` 的版本号加一，避免浏览器用缓存 |
| `fx.html` / `oilgold.html` | 原两个站点的页面，数据文件改名为 `fx.json` / `oilgold.json`，加了嵌入模式 |
| `scraper.py` | 抓取入口 |

---

## 前端

本项目没有使用 kit 组件，抽屉和路由都是 `app.js` 自己实现的。

**路由**：单段 hash 切换 5 个标签——`#overview`（总览，默认）、`#stocks`、`#sectors`、`#fx`、`#oilgold`；`#oilgold/gold`、`#oilgold/oil` 打开嵌入模块里对应的子页（速览卡片点进去用）。

**股票详情抽屉**
- 电脑上从右侧滑出、占半屏，开着时可直接点左边其他股票切换，点抽屉外其他地方关闭；手机上从底部升起半屏，按住顶部上拉全屏、下拉收回或关闭；`Esc` 关闭
- 内容：行情（开高低收、成交额、市值、市盈率、市净率、换手率）、分时 / 日 K / 周 K / 月 K 图（悬停看数值，周期选择记在本机）、公司简介、相关资讯 8 条；顶部「行情 / 简介 / 资讯」导航滚动高亮
- 抽屉状态不写进地址，不能用链接分享；没有「已下榜 / 过期」提示
- 刷新时只更新报价和指标，不重画图表、简介、资讯，避免打断滚动

**项目特有功能**
- 顶部搜索（按 `/` 聚焦，上下键选择、回车打开详情），点 ☆ 加自选；自选管理（上移 / 下移 / 删除）、导出 / 导入代码串
- 重点股票列表 / 卡片两种视图，点表头排序（降序 → 升序 → 取消）
- 价格变动闪烁提示；顶栏「实时 · 时间」/「快照 · 时间」/「连接失败」状态
- 嵌入模块：iframe 加载 `fx.html?embed=1&theme=<主题>` / `oilgold.html?embed=1…`，用 ResizeObserver 让高度随内容撑开（最少 600px）；切换主题、点 ↻ 时同步到 iframe
- 汇率模块内部标签：港美股折算 / 行情 / 走势 / 换汇成本；油价金价模块：油价 / 金价
- 设置（自选、名称缓存、分组、排序、视图、板块类型、涨跌榜市场和排序、K 线周期、主题）记在 `localStorage`，主页键前缀 `mb:`，油价金价模块 `og.`
- 右上角：↻ 立即刷新，⚡ 跳转 GitHub Actions 手动抓取，☾ 深浅色（默认深色）；国内习惯涨红跌绿

---

## 本地运行

```
python3 scraper.py all
python3 -m http.server 8799
# 打开 http://localhost:8799
```

- 依赖：Python 3（CI 用 3.12），只用标准库，无需 `pip install`
- 环境变量：无，不需要密钥（`scraper.py` 只读取 GitHub Actions 自带的 `GITHUB_EVENT_NAME` 判断是否跑油价金价）
- 页面必须通过 HTTP 服务打开，否则读不到 `config.json`（页面会提示）
- 汇率模块用到的中国外汇交易中心接口连续请求几次就会返回 403，本地调试别频繁跑 `scraper.py fx`

---

## 自动更新机制

| 触发方式 | 时机 |
|---|---|
| GitHub Actions 定时任务（cron `23 * * * *`） | 每小时第 23 分钟（北京时间同为每小时 :23）跑行情快照 + 汇率；油价金价只在北京时间 10:23、17:23 那两次跑，或数据超过 20 小时没更新时补跑 |
| push 到 main 分支 | 改动了 `scraper.py`、`scrapers/**`、`config.json` 或 `.github/workflows/scrape.yml` 时，三个模块都跑 |
| GitHub Actions 手动 dispatch | 按需触发，三个模块都跑（页面右上角 ⚡ 直达） |
| 浏览器实时轮询 | 打开页面期间，有市场交易时每 15 秒、全部休市时每 60 秒；板块页每 30 秒 |

- workflow：`.github/workflows/scrape.yml`，`concurrency: scrape`（不取消进行中的任务），权限 `contents: write`
- 运行完执行 `git add market.json fx.json oilgold.json logos`，有变化才提交（提交信息 `data: update <北京时间>`），然后 `git pull --rebase` 再 push
- **心跳**：market.json、fx.json 每次运行都会重写 `updated`，所以每次运行都有提交，仓库保持活跃
- GitHub 规定：仓库 60 天没有提交会自动停用定时任务；有了上面的心跳一般不会触发，若被停用需到 Actions 页面手动重新启用
