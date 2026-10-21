# Created by 青云 on 2026/10/21.
"""行情快照：指数、重点股票、汇率金价原油速览、A 股行业 / 概念板块，输出 market.json。只用标准库。

页面平时直连东方财富取实时行情，这份快照只在实时接口连不上时兜底，所以字段保持东方财富原样（f2、f3…），前端用同一套解析。
"""
import json, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "market.json"
CONFIG = ROOT / "config.json"
CST = timezone(timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"}
EM_UT = "fa5fd1943c7b386f172d6893dbfba10b"   # 东方财富行情接口的公开 ut 参数
QFIELDS = "f2,f3,f4,f5,f6,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f23,f100,f104,f105,f106,f115,f124"
SECTOR_FIELDS = "f12,f14,f3,f20,f128,f136"
SECTOR_FS = {"industry": "m:90+t:2", "concept": "m:90+t:3"}


def fetch_json(url, timeout=20):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read())


def quotes(ids):
    out = {}
    for i in range(0, len(ids), 80):
        d = fetch_json(f"https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&ut={EM_UT}"
                       f"&fields={QFIELDS}&secids={','.join(ids[i:i + 80])}")
        for x in (d.get("data") or {}).get("diff") or []:
            if isinstance(x.get("f2"), (int, float)):      # 取不到的行情返回 "-"，跳过，前端沿用上一份
                out[f"{x['f13']}.{x['f12']}"] = x
    return out


def sectors(fs):
    rows, page = [], 1
    while page <= 8:                                   # 接口每页最多 100 条
        d = (fetch_json(f"https://push2.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&ut={EM_UT}"
                        f"&fid=f3&fs={fs}&fields={SECTOR_FIELDS}").get("data") or {})
        rows += d.get("diff") or []
        if not d.get("diff") or len(rows) >= d.get("total", 0):
            break
        page += 1
    rows = [r for r in rows if isinstance(r.get("f3"), (int, float))]
    if not rows:
        raise RuntimeError("empty")
    return rows


def main():
    cfg = json.loads(CONFIG.read_text("utf-8"))
    prev = {}
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text("utf-8"))
        except Exception:
            prev = {}
    now = datetime.now(CST).isoformat(timespec="seconds")
    sources = []

    ids = [it["id"] for g in cfg["indices"] for it in g["items"]] + [it["id"] for it in cfg["quick"]]
    ids += [i for group in cfg["stocks"].values() for i in group]
    ids = [i for i in dict.fromkeys(ids) if not i.startswith("coinbase.")]
    q = dict(prev.get("quotes", {}))
    try:
        got = quotes(ids)
        q.update(got)
        sources.append({"name": "行情快照", "ok": bool(got), "count": len(got), "error": "" if got else "empty"})
    except Exception as e:
        sources.append({"name": "行情快照", "ok": False, "count": 0, "error": str(e)[:160]})
    q = {k: v for k, v in q.items() if k in ids}     # 名单里删掉的不再保留

    sec = dict(prev.get("sectors", {}))
    for kind, fs in SECTOR_FS.items():
        try:
            sec[kind] = sectors(fs)
            sources.append({"name": f"A 股{'行业' if kind == 'industry' else '概念'}板块", "ok": True, "count": len(sec[kind]), "error": ""})
        except Exception as e:
            sources.append({"name": f"A 股{'行业' if kind == 'industry' else '概念'}板块", "ok": False, "count": 0, "error": str(e)[:160]})

    data = {"updated": now, "quotes": q, "sectors": sec, "sources": sources}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"→ market.json：行情 {len(q)}/{len(ids)}，板块 " + "、".join(f"{k} {len(v)}" for k, v in sec.items()),
          "；失败：", [s["name"] for s in sources if not s["ok"]])


if __name__ == "__main__":
    main()
