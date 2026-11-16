#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基金净值数据抓取脚本
- 数据源：东方财富 pingzhongdata（基金全量历史净值，无需鉴权）
- 输出：data.json（前端只读这个文件，数据与界面分离）
- 用法：python3 fetch_data.py
- 定时：.github/workflows/update-data.yml 每个交易日 16:00 自动执行并提交

指标计算规则：
- 当日净值/当日涨跌：取 Data_netWorthTrend 最后一点（equityReturn 为官方口径日涨跌%）
- 近一周/一月/三月/半年涨跌幅：用累计净值（Data_ACWorthTrend）计算，分红不失真
- 最大回撤：近一年区间内 max((峰值 - 后续谷值) / 峰值)，基于累计净值
"""

import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))  # 东八区
FUND_FILE = "funds.json"
OUT_FILE = "data.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"


def fetch_pz(code: str, retries: int = 3) -> str:
    url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js"
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://fund.eastmoney.com/"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8")
        except Exception as e:
            if i == retries - 1:
                raise
            print(f"  [retry {i + 1}] {code}: {e}", file=sys.stderr)
            time.sleep(2)


def extract_var(js: str, name: str):
    m = re.search(name + r"\s*=\s*(\[.*?\]);", js)
    if not m:
        return None
    return json.loads(m.group(1))


def find_value_at_or_before(series: list, ts_ms: int) -> float:
    """series: [(x, y)] 按 x 升序；返回时间戳 <= ts_ms 的最后一个净值，找不到则返回最早一个"""
    v = series[0][1]
    for x, y in series:
        if x <= ts_ms:
            v = y
        else:
            break
    return v


def period_return(ac_series: list, days: int, last_x: int) -> float:
    base = find_value_at_or_before(ac_series, last_x - days * 86400 * 1000)
    last = ac_series[-1][1]
    if not base:
        return None
    return round((last / base - 1) * 100, 2)


def annualize(r, days):
    """区间收益率的简单年化：r% * 365/区间天数"""
    if r is None:
        return None
    return round(r * 365 / days, 2)


def max_drawdown(ac_series: list, days: int) -> tuple:
    """区间最大回撤：max((峰值-后续谷值)/峰值)，返回 (回撤%, 谷值日期, 峰值日期)"""
    cutoff = datetime.now(TZ).replace(tzinfo=None) - timedelta(days=days)
    cutoff_ms = int(cutoff.timestamp() * 1000)
    points = [(x, y) for x, y in ac_series if x >= cutoff_ms - 7 * 86400 * 1000]
    if len(points) < 2:
        return None, None, None
    peak, peak_x = points[0][1], points[0][0]
    mdd, mdd_x, mdd_peak_x = 0.0, None, None
    for x, y in points:
        if y > peak:
            peak, peak_x = y, x
        dd = (peak - y) / peak
        if dd > mdd:
            mdd, mdd_x, mdd_peak_x = dd, x, peak_x
    return round(mdd * 100, 2), mdd_x, mdd_peak_x


def ts_to_date(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, TZ).strftime("%Y-%m-%d")


# 关键词分两级：优先选中国市场的新闻，找不到再放宽
BOND_KEYWORDS_1 = ["债市", "国债", "逆回购", "央行", "LPR", "MLF", "降准", "公开市场", "信用债", "国债收益率", "国债期货"]
BOND_KEYWORDS_2 = ["债券", "利率", "收益率"]
STOCK_KEYWORDS_1 = ["沪指", "A股", "创业板指", "深证成指", "沪深300", "两市", "涨停", "板块"]
STOCK_KEYWORDS_2 = ["股市", "创业板", "个股", "券商", "指数", "资金"]
# 海外市场新闻对国内零售客户参考意义弱，排除（除非命中中国一级关键词）
FOREIGN_BLOCKLIST = ["日本", "美国", "美联储", "美股", "美债", "日元", "美元", "特朗普", "伯克希尔", "纳斯达克", "道琼斯", "标普", "比特币", "港股", "欧洲"]

COLUMN_STOCK = 104  # 东方财富快讯：股市栏目
COLUMN_BOND = 108   # 东方财富快讯：债市栏目


def _fetch_column(col: int) -> list:
    url = ("https://np-listapi.eastmoney.com/comm/web/getFastNewsList"
           f"?client=web&biz=web_724&fastColumn={col}&sortEnd=&pageSize=30"
           f"&req_trace={int(time.time() * 1000)}")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://kuaixun.eastmoney.com/"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)["data"]["fastNewsList"]


def _pick_news(items, kw_tiers):
    for kw in kw_tiers:
        for it in items:
            title = (it.get("title") or it.get("summary") or "").strip()
            text = title + (it.get("summary") or "")
            hit = any(k in text for k in kw)
            if hit and kw is kw_tiers[0] and any(b in text for b in FOREIGN_BLOCKLIST):
                continue  # 一级关键词也要排除海外新闻
            if hit:
                return title
    return None


def fetch_market_news() -> dict:
    """抓取东方财富 7x24 快讯，各挑一条股市/债市相关新闻，拼成一句话速览。
    失败时返回中性兜底文案，不影响净值数据生成。"""
    fallback = {"stock": None, "bond": None, "brief": "今日市场消息面整体平稳"}
    try:
        stock = _pick_news(_fetch_column(COLUMN_STOCK), [STOCK_KEYWORDS_1, STOCK_KEYWORDS_2])
        bond = _pick_news(_fetch_column(COLUMN_BOND), [BOND_KEYWORDS_1, BOND_KEYWORDS_2])

        def clean(t, limit=50):
            t = re.sub(r"^【(.+?)】", r"\1：", t)  # 保留【】内主题，冒号衔接
            return t if len(t) <= limit else t[:limit] + "……"

        stock_s = clean(stock) if stock else "消息面相对平静"
        bond_s = clean(bond) if bond else "整体运行平稳"
        brief = f"今日市场速览：股市{stock_s}；债市{bond_s}。"
        return {"stock": stock, "bond": bond, "brief": brief}
    except Exception as e:
        print(f"  新闻抓取失败，使用兜底文案：{e}", file=sys.stderr)
        return fallback


def main():
    with open(FUND_FILE, encoding="utf-8") as f:
        fund_list = json.load(f)["funds"]

    results = []
    for item in fund_list:
        code = item["code"]
        print(f"抓取 {code} {item['name']} ...")
        try:
            js = fetch_pz(code)
        except Exception as e:
            print(f"  跳过（抓取失败）：{e}", file=sys.stderr)
            continue
        name = re.search(r'fS_name\s*=\s*"([^"]+)"', js)
        nw = extract_var(js, "Data_netWorthTrend")
        ac = extract_var(js, "Data_ACWorthTrend")
        if not nw or not ac or not nw:
            print(f"  跳过（数据缺失）", file=sys.stderr)
            continue
        if name:
            item = dict(item, name=name.group(1))

        last = nw[-1]
        nav_date = ts_to_date(last["x"])
        daily = last.get("equityReturn")
        if daily is None and len(nw) >= 2 and nw[-2]["y"]:
            daily = round((last["y"] / nw[-2]["y"] - 1) * 100, 2)

        mdd1, mdd1_x, mdd1_peak_x = max_drawdown(ac, 365)
        mdd6, mdd6_x, mdd6_peak_x = max_drawdown(ac, 183)
        w1 = period_return(ac, 7, last["x"])
        m1 = period_return(ac, 30, last["x"])
        m3 = period_return(ac, 91, last["x"])
        m6 = period_return(ac, 183, last["x"])
        y1 = period_return(ac, 365, last["x"])
        results.append({
            "code": code,
            "name": item["name"],
            "nav": last["y"],
            "navDate": nav_date,
            "dailyChange": daily,
            "w1": w1,
            "m1": m1,
            "m3": m3,
            "m6": m6,
            "y1": y1,
            "ann1m": annualize(m1, 30),
            "ann3m": annualize(m3, 91),
            "ann6m": annualize(m6, 183),
            "maxDrawdown1y": -abs(mdd1) if mdd1 else None,
            "ddRange": f"{ts_to_date(mdd1_peak_x)} ~ {ts_to_date(mdd1_x)}" if mdd1_x else None,
            "maxDrawdown6m": -abs(mdd6) if mdd6 else None,
            **{k: v for k, v in item.items() if k not in ("code", "name")},
        })
        time.sleep(1)  # 温和限速

    news = fetch_market_news()
    out = {
        "generatedAt": datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "marketNews": {"stock": news["stock"], "bond": news["bond"]},
        "marketBrief": news["brief"],
        "funds": results,
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n完成：{len(results)}/{len(fund_list)} 只基金 -> {OUT_FILE}")


if __name__ == "__main__":
    main()
