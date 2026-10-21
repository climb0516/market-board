# Created by 青云 on 2026/10/20.
"""汇率模块数据抓取（原 FX Board）：参考汇率、人民币中间价、银行牌价点差、一年走势。只用标准库。

币种范围：USD / HKD / CNY / JPY / EUR。所有汇率统一存成「1 USD = x 该币」，前端按需交叉换算。
"""
import html, json, re, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "fx.json"
CST = timezone(timedelta(hours=8))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
CCYS = ["HKD", "CNY", "JPY", "EUR"]          # 相对 USD
HISTORY_DAYS = 400
SPREAD_DAYS = 90


def fetch(url, timeout=15, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def today_cst():
    return datetime.now(CST).date()


# ── 一年走势：Frankfurter（欧洲央行，工作日更新）────────────
def frankfurter_history():
    start = (today_cst() - timedelta(days=370)).isoformat()
    last_err = None
    for host in ("https://api.frankfurter.dev/v1", "https://api.frankfurter.app"):
        try:
            d = json.loads(fetch(f"{host}/{start}..?base=USD&symbols={','.join(CCYS)}"))
            return {day: {k: round(v, 6) for k, v in r.items()} for day, r in d["rates"].items()}
        except Exception as e:
            last_err = e
    raise last_err


# ── 兜底参考汇率：open.er-api（每日）──────────────────────
def er_api():
    d = json.loads(fetch("https://open.er-api.com/v6/latest/USD"))
    return {k: d["rates"][k] for k in CCYS}, d.get("time_last_update_utc", "")


# ── 人民币中间价：中国外汇交易中心（限流严格，每次只请求一次）──
CFETS_MAP = {"USD/CNY": "USD", "HKD/CNY": "HKD", "100JPY/CNY": "JPY", "EUR/CNY": "EUR"}


def cfets():
    end = today_cst()
    q = urllib.parse.urlencode({
        "startDate": (end - timedelta(days=15)).isoformat(), "endDate": end.isoformat(),
        "currency": ",".join(CFETS_MAP), "pageNum": 1, "pageSize": 30,
    })
    d = json.loads(fetch("https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew?" + q,
                         headers={"Referer": "https://www.chinamoney.com.cn/chinese/bkccpr/"}))
    cols = d["data"]["searchlist"]          # values 的列顺序以 searchlist 为准
    out = {}
    for rec in d["records"]:
        row = {}
        for col, v in zip(cols, rec["values"]):
            ccy, val = CFETS_MAP.get(col), num(v)
            if ccy and val:
                row[ccy] = round(val / 100 if col.startswith("100") else val, 6)   # 统一成 1 外币 = x CNY
        if row:
            out[rec["date"]] = row
    if not out:
        raise ValueError("empty")
    return out


# ── 银行牌价 ─────────────────────────────────────────────
def quote(pair, bid, ask):
    """bid=银行买入（你卖出基础货币），ask=银行卖出（你买入基础货币）。"""
    if not bid or not ask:
        return None
    mid = (bid + ask) / 2
    return {"pair": pair, "bid": round(bid, 6), "ask": round(ask, 6), "mid": round(mid, 6),
            "spread": round((ask - bid) / mid * 100, 4)}


def boc():
    """中国银行外汇牌价：每 100 外币兑人民币，取现汇买入 / 现汇卖出。"""
    h = fetch("https://www.boc.cn/sourcedb/whpj/")
    names = {"美元": "USD", "港币": "HKD", "日元": "JPY", "欧元": "EUR"}
    quotes, ts = [], ""
    for name, rest in re.findall(r"<tr[^>]*>\s*<td>([^<]+)</td>((?:\s*<td[^>]*>[^<]*</td>)+)", h):
        ccy = names.get(name.strip())
        if not ccy:
            continue
        cells = re.findall(r"<td[^>]*>([^<]*)</td>", rest)
        # 列：现汇买入 现钞买入 现汇卖出 现钞卖出 中行折算价 发布日期 发布时间
        q = quote(f"{ccy}/CNY", (num(cells[0]) or 0) / 100, (num(cells[2]) or 0) / 100)
        if q:
            q["ref"] = round((num(cells[4]) or 0) / 100, 6)   # 中行折算价
            quotes.append(q)
            ts = cells[5].strip()
    return quotes, ts


def cmb():
    """招商银行外汇牌价 API：每 100 外币兑人民币，rthBid 现汇买入 / rthOfr 现汇卖出。"""
    d = json.loads(fetch("https://fx.cmbchina.com/api/v1/fx/rate", headers={"Referer": "https://fx.cmbchina.com/"}))
    codes = {"USD", "HKD", "JPY", "EUR"}
    quotes, ts = [], ""
    for r in d["body"]:
        ccy = r["ccyNbrEng"].split()[-1]
        if ccy not in codes:
            continue
        q = quote(f"{ccy}/CNY", (num(r["rthBid"]) or 0) / 100, (num(r["rthOfr"]) or 0) / 100)
        if q:
            quotes.append(q)
            ts = f"{r['ratDat']} {r['ratTim']}"
    return quotes, ts


def bochk():
    """中银香港：USD/xxx 与 EUR/USD，Customer Sell = 银行买入，Customer Buy = 银行卖出。"""
    h = fetch("https://www.bochk.com/whk/rates/exchangeRatesUSD/exchangeRatesUSD-input.action?lang=en")
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h)))
    want = {"USD/HKD", "USD/CNH", "USD/JPY", "EUR/USD"}
    quotes = []
    for pair, sell, buy in re.findall(r"([A-Z]{3}/[A-Z]{3}) (\d+\.\d+) (\d+\.\d+)", t):
        if pair in want:
            q = quote(pair, num(sell), num(buy))
            if q:
                quotes.append(q)
    m = re.search(r"last updated at HK Time:\s*([\d/: ]+)", t)
    return quotes, (m.group(1).strip() if m else "")


BANKS = [
    ("boc", "中国银行", "内地", boc),
    ("cmb", "招商银行", "内地", cmb),
    ("bochk", "中银香港", "香港", bochk),
]


# ── 主流程 ───────────────────────────────────────────────
def main():
    old = {}
    if DATA_FILE.exists():
        try:
            old = json.loads(DATA_FILE.read_text("utf-8"))
        except Exception:
            old = {}
    now = datetime.now(CST).isoformat(timespec="seconds")
    sources = []

    def run(name, fn):
        try:
            res = fn()
            sources.append({"name": name, "ok": True, "updated": now})
            return res
        except Exception as e:
            prev = next((s for s in old.get("sources", []) if s["name"] == name), {})
            sources.append({"name": name, "ok": False, "error": str(e)[:120], "updated": prev.get("updated")})
            return None

    # 一年走势
    history = dict(old.get("history", {}))
    hist = run("Frankfurter 走势", frankfurter_history)
    if hist:
        history.update(hist)
        sources[-1]["count"] = len(hist)
    cutoff = (today_cst() - timedelta(days=HISTORY_DAYS)).isoformat()
    history = {k: history[k] for k in sorted(history) if k >= cutoff}

    # 中间价
    cf = dict(old.get("cfets", {}))
    got = run("外汇交易中心 中间价", cfets)
    if got:
        cf.update(got)
        sources[-1]["count"] = len(got)
    cf = {k: cf[k] for k in sorted(cf) if k >= cutoff}

    # 银行牌价：失败时沿用旧快照并标 stale
    old_banks = {b["id"]: b for b in old.get("banks", [])}
    banks = []
    for bid, name, region, fn in BANKS:
        res = run(name, fn)
        if res and res[0]:
            quotes, ts = res
            banks.append({"id": bid, "name": name, "region": region, "time": ts, "quotes": quotes, "stale": False})
            sources[-1]["count"] = len(quotes)
        elif bid in old_banks:
            banks.append({**old_banks[bid], "stale": True})

    # 参考汇率（1 USD = x）：优先实时银行中间价，其次欧洲央行 / er-api
    ref, ref_src = {"USD": 1.0}, {}
    base = history[max(history)] if history else {}
    er = run("open.er-api 兜底", er_api)
    er_rates = er[0] if er else {}
    live = {b["id"]: {q["pair"]: q["mid"] for q in b["quotes"]} for b in banks if not b["stale"]}
    hk, boc_cn = live.get("bochk", {}), live.get("boc", {})
    # 人民币默认用市场价（中行现汇买卖中值），中间价与市场价可能差 0.5% 以上，作为前端可切换的「官方口径」
    picks = {
        "HKD": [("中银香港", hk.get("USD/HKD"))],
        "JPY": [("中银香港", hk.get("USD/JPY"))],
        "EUR": [("中银香港", 1 / hk["EUR/USD"] if hk.get("EUR/USD") else None)],
        "CNY": [("中国银行现汇中值", boc_cn.get("USD/CNY"))],
    }
    for c in CCYS:
        for src, v in picks[c] + [("欧洲央行", base.get(c)), ("open.er-api", er_rates.get(c))]:
            if v:
                ref[c], ref_src[c] = round(v, 6), src
                break

    # 点差历史：每天保留当天最后一次快照
    sh = dict(old.get("spread_history", {}))
    day = today_cst().isoformat()
    sh[day] = {f"{b['id']}:{q['pair']}": q["spread"] for b in banks if not b["stale"] for q in b["quotes"]} or sh.get(day, {})
    sh = {k: sh[k] for k in sorted(sh)[-SPREAD_DAYS:]}

    data = {
        "updated": now,                 # 每次都变 = 心跳，保证每次运行都有提交
        "ref": {"base": "USD", "rates": ref, "source": ref_src},
        "cfets": cf,
        "history": history,
        "banks": banks,
        "spread_history": sh,
        "sources": sources,
    }
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print("ref", ref, ref_src)
    print("history", len(history), "cfets", len(cf), "banks", [(b["name"], len(b["quotes"]), b["stale"]) for b in banks])
    print("failed", [s["name"] for s in sources if not s["ok"]])


if __name__ == "__main__":
    main()
