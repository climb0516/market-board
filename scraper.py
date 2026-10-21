# Created by 青云 on 2026/10/21.
"""Market Board 数据抓取入口：依次运行 scrapers/ 下的三个模块，某个模块失败不影响其他模块。

- market.py   行情快照（实时接口连不上时兜底）      每次都跑
- fx.py       汇率（原 FX Board）                  每次都跑（银行牌价盘中会变）
- oilgold.py  油价金价（原 OilGold）               北京时间 10 点、17 点各一次；手动触发、修改爬虫后 push 时也跑；
                                                    定时任务被 GitHub 延迟错过时，数据超过 20 小时没更新也补跑

用法：python scraper.py            按上面的规则
      python scraper.py all        三个都跑
      python scraper.py fx market  只跑指定的
"""
import json, os, runpy, sys, traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CST = timezone(timedelta(hours=8))
MODULES = ["market", "fx", "oilgold"]


def oilgold_due(now):
    if os.environ.get("GITHUB_EVENT_NAME") in ("workflow_dispatch", "push"):
        return True
    if now.hour in (10, 17):
        return True
    try:
        updated = datetime.fromisoformat(json.loads((ROOT / "oilgold.json").read_text("utf-8"))["updated"])
        return now - updated > timedelta(hours=20)
    except Exception:
        return True


def main(argv):
    now = datetime.now(CST)
    if argv and argv[0] == "all":
        todo = MODULES
    elif argv:
        todo = [m for m in argv if m in MODULES]
    else:
        todo = ["market", "fx"] + (["oilgold"] if oilgold_due(now) else [])
    print(f"== {now:%Y-%m-%d %H:%M} 运行：{'、'.join(todo)}")
    failed = []
    for m in todo:
        print(f"\n── {m} ──")
        try:
            runpy.run_path(str(ROOT / "scrapers" / f"{m}.py"), run_name="__main__")
        except Exception:
            traceback.print_exc()
            failed.append(m)
    if failed:
        print(f"\n!! 失败模块：{'、'.join(failed)}（沿用上一份数据）")


if __name__ == "__main__":
    main(sys.argv[1:])
