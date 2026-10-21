#!/usr/bin/env python3
"""油价金价模块数据抓取（原 OilGold） — 国内油价（调价窗口 / 本轮预测 / 各省油价）与金价（国际 / 上金所 / 银行金条 / 品牌首饰），输出 oilgold.json。
仅依赖 Python 标准库。"""
import html, json, re, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median

OUT = Path(__file__).resolve().parent.parent / "oilgold.json"
CST = timezone(timedelta(hours=8))
UA  = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
EM_UT = "fa5fd1943c7b386f172d6893dbfba10b"   # 东方财富 K 线接口的公开 ut 参数

WINDOW_DAYS   = 10      # 成品油每 10 个工作日一个调价窗口
STRAND_TON    = 50      # 测算变动不足 50 元/吨时不调（「搁浅」）
BBL_PER_TON   = 7.33    # 原油 桶/吨
VAT           = 1.13    # 增值税
OZ_GRAM       = 31.1035
ADJ_KEEP      = 40      # 保留的调价记录条数（约一年半）
PROVINCE_HIST = 30      # 每个省份保留的油价历史条数

# 东方财富行情代码：(id, 名称, secid)
QUOTES = [
    ("brent",  "布伦特原油",   "112.B00Y"),
    ("wti",    "WTI 原油",     "102.CL00Y"),
    ("xau",    "伦敦金",       "122.XAU"),
    ("gc",     "COMEX 黄金",   "101.GC00Y"),
    ("au9999", "上金所黄金9999", "118.AU9999"),
    ("autd",   "黄金 T+D",     "118.AUTD"),
    ("usdcnh", "美元/离岸人民币", "133.USDCNH"),
]
# 新浪行情作为备用（东方财富失败时）：id → 新浪代码
SINA_FALLBACK = {"brent": "hf_OIL", "wti": "hf_CL", "xau": "hf_XAU", "gc": "hf_GC"}

# ── 工具 ──────────────────────────────────────────────────────────────────────

def fetch(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout).read()

def fetch_json(url, **kw):
    return json.loads(fetch(url, **kw))

def text_of(cell):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", cell))).strip()

def num(s):
    try:
        return float(re.sub(r"[^\d.\-]", "", str(s)))
    except ValueError:
        return None

def run(label, fn):
    try:
        res = fn()
        print(f"  ✓ {label}")
        return res, ""
    except Exception as e:
        err = f"{type(e).__name__}: {e}"[:200]
        print(f"  ✗ {label} {err}")
        return None, err

def d2s(d):
    return d.isoformat()

# ── 工作日（节假日与调休来自 holiday-cn） ─────────────────────────────────────

def holidays(years):
    out = {}
    for y in years:
        try:
            data = fetch_json(f"https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{y}.json")
            for d in data.get("days", []):
                out[d["date"]] = d["isOffDay"]
        except Exception:
            pass   # 次年安排通常 11 月才公布，没有就按周一到周五算
    return out

def is_workday(d, hol):
    off = hol.get(d2s(d))
    return (not off) if off is not None else d.weekday() < 5

def add_workdays(d, n, hol):
    while n:
        d += timedelta(days=1)
        if is_workday(d, hol):
            n -= 1
    return d

def workdays_back(d, n, hol):
    """截至 d（含）往前数 n 个工作日。"""
    out = []
    while len(out) < n:
        if is_workday(d, hol):
            out.append(d)
        d -= timedelta(days=1)
    return out

# ── 东方财富 ──────────────────────────────────────────────────────────────────

def em_report(name, page_size, page=1):
    url = (f"https://datacenter-web.eastmoney.com/api/data/v1/get?reportName={name}&columns=ALL"
           f"&pageSize={page_size}&pageNumber={page}&sortColumns=DIM_DATE&sortTypes=-1")
    data = fetch_json(url)
    if not data.get("success"):
        raise RuntimeError(data.get("message"))
    return data["result"]["data"]

def adjustments():
    rows = em_report("RPTA_WEB_YJ_BD", ADJ_KEEP)
    return [{"date": r["DIM_DATE"][:10], "gas": r["VALUE"], "diesel": r["CY_JG"],
             "gas_chg": r["QY_FD"], "diesel_chg": r["CY_FD"]} for r in rows]

def provinces():
    rows = []
    for page in (1, 2):
        rows += em_report("RPTA_WEB_YJ_JH", 500, page)
    out = {}
    for r in rows:   # 已按日期倒序
        p = out.setdefault(r["CITYNAME"], {"hist": []})
        if len(p["hist"]) < PROVINCE_HIST:
            p["hist"].append([r["DIM_DATE"][:10], r["V92"], r["V95"], r["V0"]])
        if "v92" not in p:
            p.update({"date": r["DIM_DATE"][:10], "v89": r["V89"], "v92": r["V92"], "v95": r["V95"], "v0": r["V0"],
                      "zde92": r["ZDE92"], "zde95": r["ZDE95"], "zde0": r["ZDE0"]})
    return out

def oil98():
    """东方财富没有 98#，从汽油价格网首页的全国表格补。"""
    page = fetch("http://www.qiyoujiage.com/").decode("utf-8", "ignore")
    page = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page)))   # 标签换成空格，否则表格各列的数字会粘在一起
    return {name: float(v98) for name, _, _, v98, _ in
            re.findall(r"([一-龥]{2,3}) (\d+\.\d+) (\d+\.\d+) (\d+\.\d+) (\d+\.\d+)", t)}

def quote(secid):
    d = fetch_json(f"https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f59,f60,f170,f86")["data"]
    if not d or d.get("f43") in (None, "-"):
        raise RuntimeError("empty quote")
    k = 10 ** d["f59"]
    return {"price": d["f43"] / k, "prev": d["f60"] / k, "chg_pct": d["f170"] / 100,
            "time": datetime.fromtimestamp(d["f86"], CST).isoformat(timespec="minutes")}

def kline_quote(secid):
    """实时行情取不到时（GitHub Actions 的服务器上部分代码会返回空值），用日线最近两天的收盘价顶上。"""
    k = kline(secid, 15)
    if len(k) < 2:
        raise RuntimeError("kline too short")
    (_, prev), (d, price) = k[-2], k[-1]
    return {"price": price, "prev": prev, "chg_pct": round((price / prev - 1) * 100, 2), "time": f"{d}T15:00+08:00", "daily": True}

def sina_quote(code):
    raw = fetch(f"https://hq.sinajs.cn/list={code}", headers={"Referer": "https://finance.sina.com.cn/"}).decode("gbk", "ignore")
    f = raw.split('"')[1].split(",")
    price, prev = float(f[0]), float(f[7])
    return {"price": price, "prev": prev, "chg_pct": round((price / prev - 1) * 100, 2) if prev else 0,
            "time": f"{f[12]}T{f[6][:5]}+08:00"}

def kline(secid, days):
    beg = (date.today() - timedelta(days=days)).strftime("%Y%m%d")
    d = fetch_json(f"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&ut={EM_UT}"
                   f"&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&beg={beg}&end=20500101")["data"]
    return [[k.split(",")[0], float(k.split(",")[1])] for k in (d or {}).get("klines", [])]

# ── 金价网站 ──────────────────────────────────────────────────────────────────

# 两个网站对同一品牌叫法不同，统一成一个名字再合并
BRAND_ALIAS = {"老庙": "老庙黄金", "菜百": "菜百首饰", "六福": "六福珠宝", "水贝": "深圳水贝（批发参考）"}
brand_name = lambda n: BRAND_ALIAS.get(n.strip(), n.strip())

def huilvbiao():
    page = fetch("https://www.huilvbiao.com/gold").decode("utf-8", "ignore")
    tables = {}
    for title, body in re.findall(r"<h3>([^<]+)</h3>(.*?)</table>", page, re.S):
        rows = [[text_of(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)] for r in re.findall(r"<tr>(.*?)</tr>", body, re.S)]
        tables[title.strip()] = [r for r in rows if r]
    brands = [{"name": brand_name(r[0]), "gold": num(r[1]), "platinum": num(r[2]), "bar": num(r[3]), "date": r[5]}
              for r in tables.get("各品牌黄金首饰金店报价", []) if len(r) >= 6]
    banks = [{"name": r[0], "price": num(r[1])} for r in tables.get("银行投资金条价格", []) if len(r) >= 2]
    recycle = [{"name": r[0], "price": num(r[1]), "date": r[3] if len(r) > 3 else ""}
               for r in tables.get("今日黄金回收价格", []) if len(r) >= 2]
    if not brands:
        raise RuntimeError("品牌金价表格没解析到")
    return {"brands": brands, "banks": banks, "recycle": recycle}

def jinjia():
    page = fetch("https://www.jinjia.com.cn/").decode("utf-8", "ignore")
    seg = page[page.find("品牌金店今日金价"):]
    seg = seg[: seg.find("</ul>")]
    out = {}
    for li in re.findall(r"<li>(.*?)</li>", seg, re.S):
        name = text_of((re.search(r'class="name">(.*?)</div>', li, re.S) or [None, ""])[1])
        nums = [text_of(x) for x in re.findall(r'class="npx"[^>]*>(.*?)</span>', li, re.S)]
        chg = [text_of(x) for x in re.findall(r'class="open"><span[^>]*>(.*?)</span>', li, re.S)]
        dt = text_of((re.search(r'class="time">(.*?)</div>', li, re.S) or [None, ""])[1])
        if not name or not nums:
            continue
        def signed(s):
            v = num(s)
            return None if v is None else (-v if "↓" in s else v)
        gold, plat = num(nums[0]), num(nums[1]) if len(nums) > 1 else None
        out[brand_name(name)] = {"gold": gold or None, "platinum": plat or None,   # 网站偶尔把铂金价写成 0，当缺失处理
                     "gold_chg": signed(chg[0]) if chg else None, "date": dt}
    if not out:
        raise RuntimeError("品牌金价没解析到")
    return out

# ── 油价测算 ──────────────────────────────────────────────────────────────────

def avg_on(series, days):
    vals = [series[d2s(d)] for d in days if d2s(d) in series]
    return sum(vals) / len(vals) if vals else None

def oil_estimate(adjs, brent_hist, hol, fx, provs, today):
    """粗略估算本轮调价：比较「上次调价前 10 个工作日」与「上次调价后至今」的布伦特均价，换算成元/吨，
    系数用历次调价回测拟合。官方算法用三地原油加权且细节不公开，所以只是估算。"""
    series = {d: c for d, c in brent_hist}
    adates = [date.fromisoformat(a["date"]) for a in adjs]

    def x_of(prev_adj, upto):
        base = avg_on(series, workdays_back(prev_adj, WINDOW_DAYS, hol))
        cur_days = [prev_adj + timedelta(days=i) for i in range(1, (upto - prev_adj).days + 1)]
        cur = avg_on(series, [d for d in cur_days if is_workday(d, hol)])
        if base is None or cur is None:
            return None, base, cur
        return (cur - base) * fx * BBL_PER_TON * VAT, base, cur

    # 回测：历次调价（相邻两次实际调价之间）的估算值 vs 实际值，拟合缩放系数
    pairs = []
    for i in range(len(adates) - 1):
        x, _, _ = x_of(adates[i + 1], adates[i])
        if x is not None:
            pairs.append((adjs[i]["date"], x, adjs[i]["gas_chg"]))
    k = sum(x * y for _, x, y in pairs) / sum(x * x for _, x, _ in pairs) if pairs else 1.0
    backtest = [{"date": d, "est": round(x * k), "actual": y} for d, x, y in pairs]
    mae = round(sum(abs(b["est"] - b["actual"]) for b in backtest) / len(backtest)) if backtest else None
    hit = sum((b["est"] > 0) == (b["actual"] > 0) for b in backtest)

    # 吨 → 升：用历次调价时各省每升涨跌额 / 每吨涨跌额的中位数（hist 每项 [date, v92, v95, v0]）
    def liter_ratio(col, key):
        ratios = []
        for a in adjs:
            if not a[key]:
                continue
            deltas = [p["hist"][j][col] - p["hist"][j + 1][col] for p in provs.values()
                      for j in range(len(p["hist"]) - 1) if p["hist"][j][0] == a["date"]]
            if deltas:
                ratios.append(median(deltas) / a[key])
        return median(ratios) if ratios else None
    per_liter = liter_ratio(1, "gas_chg") or 1 / 1300
    per_liter_diesel = liter_ratio(3, "diesel_chg") or 1 / 1180
    # 柴油每吨调幅通常略低于汽油，按历次调价的比例换算
    diesel_k = median([a["diesel_chg"] / a["gas_chg"] for a in adjs if a["gas_chg"]]) if adjs else 0.96

    last_adj = adates[0]
    x, base, cur = x_of(last_adj, today)
    est = round(x * k) if x is not None else None
    verdict = None if est is None else ("搁浅" if abs(est) < STRAND_TON else ("上调" if est > 0 else "下调"))
    return {
        "base_avg": round(base, 2) if base else None, "cur_avg": round(cur, 2) if cur else None,
        "est_ton": est, "est_liter92": round(est * per_liter, 3) if est is not None else None,
        "est_diesel_ton": round(est * diesel_k) if est is not None else None,
        "verdict": verdict, "k": round(k, 3), "per_liter": round(per_liter, 6),
        "per_liter_diesel": round(per_liter_diesel, 6), "diesel_k": round(diesel_k, 3),
        "mae": mae, "direction_hit": f"{hit}/{len(backtest)}", "backtest": backtest[:24],
    }

def windows(last_adj, hol, today):
    """从上次实际调价日起，每 10 个工作日一个窗口；返回已过去的窗口（搁浅的）和下一个窗口。"""
    passed, w = [], last_adj
    while True:
        w = add_workdays(w, WINDOW_DAYS, hol)
        if w >= today:
            return passed, w
        passed.append(d2s(w))

# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    prev = {}
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text())
        except Exception:
            pass
    now = datetime.now(CST)
    today = now.date()

    print("→ 抓取")
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_hol   = pool.submit(lambda: holidays([today.year - 1, today.year, today.year + 1]))
        f_adj   = pool.submit(run, "调价记录", adjustments)
        f_prov  = pool.submit(run, "各省油价", provinces)
        f_98    = pool.submit(run, "98# 油价", oil98)
        f_q     = {qid: pool.submit(run, f"行情 {name}", lambda s=secid: quote(s)) for qid, name, secid in QUOTES}
        f_brent = pool.submit(run, "布伦特日线", lambda: kline("112.B00Y", 560))
        f_auk   = pool.submit(run, "黄金9999 日线", lambda: kline("118.AU9999", 400))
        f_xauk  = pool.submit(run, "伦敦金日线", lambda: kline("122.XAU", 400))
        f_hlb   = pool.submit(run, "汇率表金价", huilvbiao)
        f_jj    = pool.submit(run, "金价网", jinjia)

    sources = []
    def src(name, res, err, count=None):
        sources.append({"name": name, "ok": res is not None, "error": err,
                        "count": count if count is not None else (len(res) if res is not None else 0)})

    hol = f_hol.result()
    p_oil, p_gold = prev.get("oil", {}), prev.get("gold", {})

    # 行情：东方财富实时 → 东方财富日线 → 新浪 → 上次数据
    quotes = {}
    for qid, name, secid in QUOTES:
        q, err = f_q[qid].result()
        if q is None:
            q, err2 = run(f"行情 {name}（日线备用）", lambda s=secid: kline_quote(s))
            err = "" if q is not None else f"{err}; 日线: {err2}"
        if q is None and qid in SINA_FALLBACK:
            q, err2 = run(f"行情 {name}（新浪备用）", lambda c=SINA_FALLBACK[qid]: sina_quote(c))
            err = "" if q is not None else f"{err}; 新浪: {err2}"
        if q is None:
            q = (p_oil.get("crude", {}) | p_gold.get("quotes", {})).get(qid)
            if q:
                q = {**q, "stale": True}
        quotes[qid] = q
    bad_q = [n for qid, n, _ in QUOTES if not quotes.get(qid) or quotes[qid].get("stale")]
    sources.append({"name": "行情（原油 / 金价 / 汇率）", "ok": not bad_q, "error": "、".join(bad_q), "count": len(QUOTES) - len(bad_q)})
    fx = (quotes.get("usdcnh") or {}).get("price") or 7.1

    # ── 油价 ──
    adjs, err = f_adj.result();   src("调价记录（东方财富）", adjs, err)
    adjs = adjs or p_oil.get("adjustments", [])
    provs, err = f_prov.result(); src("各省油价（东方财富）", provs, err)
    provs = provs or p_oil.get("provinces", {})
    v98, err = f_98.result();     src("98# 油价（汽油价格网）", v98, err)
    for name, p in provs.items():
        p["v98"] = (v98 or {}).get(name) or (p_oil.get("provinces", {}).get(name, {}) or {}).get("v98")
    brent_hist, err = f_brent.result(); src("布伦特日线", brent_hist, err)
    brent_hist = brent_hist or p_oil.get("brent_hist", [])

    oil = {"adjustments": adjs, "provinces": provs, "crude": {k: quotes.get(k) for k in ("brent", "wti")},
           "brent_hist": brent_hist[-180:]}
    if adjs:
        last_adj = date.fromisoformat(adjs[0]["date"])
        passed, nxt = windows(last_adj, hol, today)
        oil["last_adj"] = adjs[0]
        oil["windows_passed"] = passed
        oil["next_window"] = {"date": d2s(nxt), "days": (nxt - today).days,
                              "holiday_data": str(nxt.year) in {k[:4] for k in hol}}
        if brent_hist and provs:
            oil["estimate"] = oil_estimate(adjs, brent_hist, hol, fx, provs, today)
        vals = [p["v92"] for p in provs.values() if p.get("v92")]
        oil["national"] = {k: round(sum(p[k] for p in provs.values() if p.get(k)) / max(1, sum(1 for p in provs.values() if p.get(k))), 2)
                           for k in ("v92", "v95", "v98", "v0")} if vals else {}

    # ── 金价 ──
    hlb, err = f_hlb.result(); src("品牌 / 银行金条 / 回收价（汇率表）", hlb, err, len((hlb or {}).get("brands", [])))
    jj, err  = f_jj.result();  src("品牌金价涨跌（金价网）", jj, err)
    hlb = hlb or {k: p_gold.get(k, []) for k in ("brands", "banks", "recycle")}
    au = (quotes.get("au9999") or {}).get("price")
    brands = {b["name"]: dict(b) for b in hlb["brands"]}
    for name, j in (jj or {}).items():   # 金价网补涨跌和 huilvbiao 没有的品牌
        b = brands.setdefault(name, {"name": name, "bar": None})
        b["gold"] = b.get("gold") or j["gold"]
        b["platinum"] = b.get("platinum") or j["platinum"]
        b["gold_chg"] = j["gold_chg"]
        b["date"] = b.get("date") or j["date"]
    for b in brands.values():
        b["premium"] = round((b["gold"] / au - 1) * 100, 1) if b.get("gold") and au else None
    banks = [{**b, "premium": round((b["price"] / au - 1) * 100, 1) if b.get("price") and au else None} for b in hlb["banks"]]
    au_hist, err = f_auk.result();   src("黄金9999 日线", au_hist, err)
    xau_hist, err = f_xauk.result(); src("伦敦金日线", xau_hist, err)
    xau = (quotes.get("xau") or {}).get("price")
    gold = {
        "quotes":    {k: quotes.get(k) for k in ("xau", "gc", "au9999", "autd", "usdcnh")},
        "xau_cny_g": round(xau * fx / OZ_GRAM, 2) if xau else None,
        "brands":    sorted(brands.values(), key=lambda b: -(b.get("gold") or 0)),
        "banks":     sorted(banks, key=lambda b: b.get("price") or 0),
        "recycle":   hlb["recycle"],
        "au_hist":   au_hist or p_gold.get("au_hist", []),
        "xau_hist":  xau_hist or p_gold.get("xau_hist", []),
    }

    data = {"updated": now.isoformat(timespec="seconds"),   # 每次都变，保证每次运行都有提交
            "oil": oil, "gold": gold, "sources": sources}
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    ok = sum(s["ok"] for s in sources)
    e = oil.get("estimate") or {}
    print(f"→ 完成：{ok}/{len(sources)} 个来源正常；下次调价 {oil.get('next_window', {}).get('date')}，"
          f"预测 {e.get('verdict')} {e.get('est_ton')} 元/吨（回测平均误差 {e.get('mae')}）；"
          f"品牌金价 {len(gold['brands'])} 家 → {OUT.name}")

if __name__ == "__main__":
    main()
