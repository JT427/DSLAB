"""Offline tests with synthetic data. Run: python3 test_daytrader.py  (or pytest)."""
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

import daytrader as dt

IST = dt.IST
TODAY = datetime(2026, 11, 10, tzinfo=IST)  # a Tuesday


def daily(start, drift, n=80, vol=5_000_000, end=TODAY - timedelta(days=1), wiggle=0.012):
    days = pd.bdate_range(end=end.date(), periods=n, tz=IST)
    close = start * np.cumprod(np.full(n, 1 + drift))
    return pd.DataFrame({"Open": close * (1 - drift), "High": close * (1 + wiggle), "Low": close * (1 - wiggle),
                         "Close": close, "Volume": vol}, index=days)


def intraday(prev_close, path, vol_today=200_000, prior_vol=60_000):
    """path: list of closes for today's 5-min bars; four prior days of flat bars for RVOL."""
    frames = []
    for back in range(4, 0, -1):
        day = TODAY - timedelta(days=back)
        if day.weekday() >= 5:
            continue
        idx = pd.date_range(day.replace(hour=9, minute=15), periods=75, freq="5min")
        frames.append(pd.DataFrame({"Open": prev_close, "High": prev_close * 1.001, "Low": prev_close * 0.999,
                                    "Close": prev_close, "Volume": prior_vol}, index=idx))
    idx = pd.date_range(TODAY.replace(hour=9, minute=15), periods=len(path), freq="5min")
    c = np.array(path, dtype=float)
    o = np.concatenate([[c[0]], c[:-1]])
    frames.append(pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.0005, "Low": np.minimum(o, c) * 0.9995,
                                "Close": c, "Volume": vol_today}, index=idx))
    return pd.concat(frames)


def market(vix=14.0, nifty_drift=0.002, nifty_path=None):
    n = daily(24000, nifty_drift, wiggle=0.005)
    v = daily(vix, 0.0)
    d = {dt.NIFTY: n, dt.VIX: v}
    i = {}
    if nifty_path is not None:
        i[dt.NIFTY] = intraday(float(n["Close"].iloc[-1]), nifty_path)
    return d, i


def at(h, m):
    return TODAY.replace(hour=h, minute=m)


def test_costs_and_sizing():
    c = dt.round_trip_costs(1000, 1010, 100)
    # brokerage 20+20, STT 25.25, exch 5.97, sebi 0.20, stamp 3.00, gst 18% of 46.17
    assert abs(c["total"] - (40 + 25.25 + 5.97 + 0.20 + 3.00 + 8.31)) < 0.05, c
    s = dt.size_position("long", 1000, 990, 1020, 200_000, 0.5)
    assert 0 < s["max_loss"] <= 1000 and s["qty"] <= 100 and s["net_rr"] < 2
    sh = dt.size_position("short", 1000, 1010, 980, 200_000, 0.5)
    assert sh["qty"] > 0 and sh["max_loss"] <= 1000
    assert dt.size_position("long", 1000, 990, 1020, 500, 0.5)["qty"] == 0
    capped = dt.size_position("long", 1000, 999, 1002, 100_000, 2, max_leverage=1)
    assert capped["position_value"] <= 100_000
    try:
        dt.size_position("long", 1000, 1010, 1020, 1e5, 0.5)
        raise AssertionError("bad stop accepted")
    except ValueError:
        pass


def test_phases():
    assert dt.session_phase(at(9, 20))[2] is False
    assert dt.session_phase(at(10, 0))[0] == "PRIME"
    assert dt.session_phase(at(12, 0))[0] == "MIDDAY"
    assert dt.session_phase(at(14, 50))[2] is False
    assert dt.session_phase(at(15, 20))[0] == "SQUARE-OFF"
    assert dt.session_phase(TODAY + timedelta(days=4, hours=10))[0] == "CLOSED"  # Saturday


def test_live_long_breakout():
    d, i = market()
    d["UP"] = daily(1000, 0.004)
    pc = float(d["UP"]["Close"].iloc[-1])
    i["UP"] = intraday(pc, [pc * x for x in (1.001, 1.002, 1.003, 1.003, 1.0035, 1.004, 1.0045, 1.005, 1.0055)])
    i[dt.NIFTY] = intraday(float(d[dt.NIFTY]["Close"].iloc[-1]), [float(d[dt.NIFTY]["Close"].iloc[-1]) * 1.001] * 9)
    res = dt.scan(d, i, ["UP"], at(10, 0), 200_000, 0.5)
    assert res["mode"] == "LIVE" and res["regime"]["verdict"] == "TRADE", res
    c = res["candidates"][0]
    assert c["side"] == "long" and c["state"] == "TRIGGERED" and c["grade"] in "AB", c
    assert c["stop"] < c["entry"] < c["target1"] < c["target2"]
    assert c["max_loss"] <= 1000 and c["net_rr"] >= dt.MIN_NET_RR
    assert "Rs" in dt.render(res)


def test_live_filters():
    d, i = market()
    nc = float(d[dt.NIFTY]["Close"].iloc[-1])
    i[dt.NIFTY] = intraday(nc, [nc] * 9)
    for sym in ("GAP", "WEAK", "CHASE", "THIN"):
        d[sym] = daily(1000, 0.004, vol=5_000_000 if sym != "THIN" else 10_000)
    pc = float(d["GAP"]["Close"].iloc[-1])
    up = (1.001, 1.002, 1.003, 1.003, 1.0035, 1.004, 1.0045, 1.005, 1.0055)
    i["GAP"] = intraday(pc, [pc * 1.05 * x for x in up])
    i["WEAK"] = intraday(pc, [pc * x for x in up], vol_today=20_000)
    i["CHASE"] = intraday(pc, [pc * x for x in (1.001, 1.002, 1.003, 1.01, 1.02, 1.03, 1.035, 1.04, 1.045)])
    i["THIN"] = intraday(pc, [pc * x for x in up])
    res = dt.scan(d, i, ["GAP", "WEAK", "CHASE", "THIN"], at(10, 0), 200_000, 0.5)
    assert not res["candidates"], res["candidates"]
    sk = res["skipped"]
    assert "gapped" in sk["GAP"] and "weak volume" in sk["WEAK"] and "chase" in sk["CHASE"] and "illiquid" in sk["THIN"], sk


def test_no_trade_conditions():
    d, i = market(vix=28.0)
    d["UP"] = daily(1000, 0.004)
    res = dt.scan(d, i, ["UP"], at(8, 30), 200_000, 0.5)
    assert res["regime"]["verdict"] == "NO-TRADE" and res["candidates"] == [] and res["suppressed_by_no_trade"] == 1
    assert "NO TRADE" in dt.render(res)

    d, i = market(vix=22.0)
    d["UP"] = daily(1000, 0.004)
    res = dt.scan(d, i, ["UP"], at(8, 30), 200_000, 0.5)
    assert res["regime"]["verdict"] == "REDUCED-SIZE" and res["risk_pct_per_trade"] == 0.25

    # late in the session: live setups exist but entries are closed
    d, i = market()
    d["UP"] = daily(1000, 0.004)
    pc = float(d["UP"]["Close"].iloc[-1])
    i["UP"] = intraday(pc, [pc * (1 + 0.0002 * k) for k in range(1, 70)])
    res = dt.scan(d, i, ["UP"], at(14, 55), 200_000, 0.5)
    assert res["new_entries_allowed"] is False and res["candidates"] == []


def test_plan_mode_and_bearish_short():
    d, i = market(nifty_drift=-0.002)
    d["DOWN"] = daily(1000, -0.004)
    d["UP"] = daily(1000, 0.001)
    res = dt.scan(d, i, ["DOWN", "UP"], at(8, 0), 200_000, 0.5)
    assert res["mode"] == "PLAN" and res["regime"]["bias"] == "bearish"
    syms = {c["symbol"]: c for c in res["candidates"]}
    assert syms["DOWN"]["side"] == "short" and syms["DOWN"]["target2"] < syms["DOWN"]["entry"] < syms["DOWN"]["stop"]
    assert "UP" not in syms


def test_csv_roundtrip(tmp_path=None):
    import tempfile, pathlib
    root = pathlib.Path(tmp_path or tempfile.mkdtemp())
    d, _ = market()
    d["UP"] = daily(1000, 0.004)
    (root / "daily").mkdir(parents=True, exist_ok=True)
    for s, df in d.items():
        df.tz_localize(None).to_csv(root / "daily" / f"{s}.csv")
    assert dt.main(["scan", "--capital", "200000", "--symbols", "UP", "--data-dir", str(root), "--asof", "2026-11-10 08:00"]) == 0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
