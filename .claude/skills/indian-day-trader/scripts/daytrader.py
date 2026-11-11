#!/usr/bin/env python3
"""Intraday (MIS) equity scanner, position sizer and cost calculator for NSE cash stocks.

This is a rule-based screening aid, not a prediction engine and not investment advice.
It ranks liquid stocks against a fixed checklist and says "no trade" when the checklist fails.

Subcommands:
  scan   market verdict + ranked candidates with entry / stop / target / quantity
  size   position size and net reward:risk for one trade idea
  costs  round-trip charges for one intraday trade

Data: Yahoo Finance via yfinance (often ~15 min delayed for NSE), or CSV files via --data-dir.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

IST = ZoneInfo("Asia/Kolkata")
NIFTY, VIX = "NIFTY", "INDIAVIX"
YAHOO_INDEX = {NIFTY: "^NSEI", VIX: "^INDIAVIX"}

# --- Charges for NSE equity intraday. Rates change: verify against your broker's contract note.
BROKERAGE_PCT = 0.0003      # 0.03% per order ...
BROKERAGE_CAP = 20.0        # ... capped at Rs 20 per order (typical discount broker)
STT_SELL_PCT = 0.00025      # 0.025% on the sell leg
EXCH_TXN_PCT = 0.0000297    # NSE transaction charge, both legs
SEBI_PCT = 0.000001         # Rs 10 per crore, both legs
STAMP_BUY_PCT = 0.00003     # 0.003% on the buy leg
GST_PCT = 0.18              # on brokerage + exchange + SEBI charges

# --- Screening thresholds
MIN_PRICE = 100.0
MIN_TURNOVER_CR = 100.0     # 20-day average daily turnover, Rs crore
ATR_PCT_RANGE = (1.0, 5.0)  # daily ATR as % of price: below = too dull, above = too wild
MAX_GAP_PCT = 3.0           # bigger opening gaps are news-driven and erratic
MAX_DAY_MOVE_PCT = 7.0      # stay away from stocks approaching circuit limits
MIN_RVOL = 1.0
GOOD_RVOL = 1.5
OR_BARS = 3                 # opening range = first 15 minutes of 5-minute bars
MIN_NET_RR = 1.5
TICK = 0.05

VIX_ELEVATED, VIX_EXTREME, VIX_SPIKE_PCT = 20.0, 25.0, 10.0


# ----------------------------------------------------------------------------- costs & sizing

def round_trip_costs(buy: float, sell: float, qty: int) -> dict:
    """All statutory + brokerage charges for buying and selling `qty` shares intraday."""
    buy_val, sell_val = buy * qty, sell * qty
    turnover = buy_val + sell_val
    brokerage = min(buy_val * BROKERAGE_PCT, BROKERAGE_CAP) + min(sell_val * BROKERAGE_PCT, BROKERAGE_CAP)
    stt = sell_val * STT_SELL_PCT
    exch = turnover * EXCH_TXN_PCT
    sebi = turnover * SEBI_PCT
    stamp = buy_val * STAMP_BUY_PCT
    gst = (brokerage + exch + sebi) * GST_PCT
    total = brokerage + stt + exch + sebi + stamp + gst
    return {
        "turnover": round(turnover, 2), "brokerage": round(brokerage, 2), "stt": round(stt, 2),
        "exchange": round(exch, 2), "sebi": round(sebi, 2), "stamp": round(stamp, 2),
        "gst": round(gst, 2), "total": round(total, 2),
        "breakeven_per_share": round(total / qty, 3) if qty else 0.0,
    }


def _legs(side: str, entry: float, exit_: float) -> tuple[float, float]:
    return (entry, exit_) if side == "long" else (exit_, entry)


def size_position(side: str, entry: float, stop: float, target: float, capital: float,
                  risk_pct: float, max_leverage: float = 3.0, slippage_pct: float = 0.02) -> dict:
    """Quantity such that a stop-out (including charges and slippage) loses <= risk_pct of capital."""
    if side not in ("long", "short"):
        raise ValueError("side must be long or short")
    if (side == "long" and not stop < entry < target) or (side == "short" and not target < entry < stop):
        raise ValueError(f"{side}: need stop/entry/target in the right order")
    risk_budget = capital * risk_pct / 100
    slip = entry * slippage_pct / 100 * 2          # entry + exit leg
    per_share = abs(entry - stop) + slip
    qty = int(risk_budget // per_share)
    qty = min(qty, int(capital * max_leverage // entry))
    # charges are a step function of qty; shave until the stop-out loss fits the budget
    while qty > 0:
        loss = per_share * qty + round_trip_costs(*_legs(side, entry, stop), qty)["total"]
        if loss <= risk_budget:
            break
        qty -= max(1, qty // 50)
    if qty <= 0:
        return {"qty": 0, "reason": "capital/risk budget too small for this stop distance"}
    win_costs = round_trip_costs(*_legs(side, entry, target), qty)["total"]
    loss_costs = round_trip_costs(*_legs(side, entry, stop), qty)["total"]
    net_win = abs(target - entry) * qty - slip * qty - win_costs
    net_loss = abs(entry - stop) * qty + slip * qty + loss_costs
    return {
        "qty": qty, "position_value": round(qty * entry, 2),
        "leverage_used": round(qty * entry / capital, 2),
        "max_loss": round(net_loss, 2), "max_loss_pct_capital": round(net_loss / capital * 100, 2),
        "net_profit_at_target": round(net_win, 2), "net_rr": round(net_win / net_loss, 2),
        "costs_at_target": round(win_costs, 2),
    }


# ----------------------------------------------------------------------------- indicators

def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    pc = df["Close"].shift(1)
    tr = pd.concat([df["High"] - df["Low"], (df["High"] - pc).abs(), (df["Low"] - pc).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()


def tick(x: float) -> float:
    return round(round(x / TICK) * TICK, 2)


def session_phase(now: datetime) -> tuple[str, str, bool]:
    """(phase, guidance, new_entries_allowed) for an IST timestamp. Exchange holidays are NOT known here."""
    if now.weekday() >= 5:
        return "CLOSED", "Weekend: market closed. Use this as a plan for the next session.", False
    t = now.time()
    if t < time(9, 15):
        return "PRE-OPEN", "Market not open yet. Build the watchlist; no orders.", False
    if t < time(9, 30):
        return "OPENING-RANGE", "First 15 minutes: spreads wide, direction unreliable. Watch, do not enter.", False
    if t < time(11, 30):
        return "PRIME", "Best window for breakout entries (09:30-11:30).", True
    if t < time(13, 30):
        return "MIDDAY", "Lunch-hour chop: volume dries up, breakouts fail more often. A-grade setups only, half size.", True
    if t < time(14, 45):
        return "AFTERNOON", "Second window (13:30-14:45). Trend-continuation only.", True
    if t < time(15, 15):
        return "LATE", "Too late for new entries: not enough time for the trade to work before square-off.", False
    if t < time(15, 30):
        return "SQUARE-OFF", "Brokers auto-square-off MIS positions now. Exit everything; no entries.", False
    return "CLOSED", "Market closed. Use this as a plan for the next session.", False


# ----------------------------------------------------------------------------- market regime

@dataclass
class Regime:
    verdict: str                 # TRADE | REDUCED-SIZE | NO-TRADE
    bias: str                    # bullish | bearish | neutral
    size_factor: float           # multiply normal risk by this
    nifty_close: float | None = None
    vix: float | None = None
    reasons: list[str] = field(default_factory=list)


def market_regime(nifty_d: pd.DataFrame | None, vix_d: pd.DataFrame | None,
                  nifty_today: pd.DataFrame | None = None) -> Regime:
    r = Regime("TRADE", "neutral", 1.0)
    if nifty_d is None or len(nifty_d) < 50:
        r.verdict, r.size_factor = "REDUCED-SIZE", 0.5
        r.reasons.append("No Nifty history: market direction unknown, so trade smaller or not at all.")
    else:
        c = nifty_d["Close"]
        e20, e50, last = ema(c, 20).iloc[-1], ema(c, 50).iloc[-1], c.iloc[-1]
        r.nifty_close = round(float(last), 2)
        if last > e20 > e50:
            r.bias = "bullish"
            r.reasons.append("Nifty above rising 20/50 EMA: favour longs.")
        elif last < e20 < e50:
            r.bias = "bearish"
            r.reasons.append("Nifty below falling 20/50 EMA: favour shorts, avoid bottom-fishing longs.")
        else:
            r.reasons.append("Nifty trend mixed: breakouts less reliable, be selective.")
        if nifty_today is not None and len(nifty_today):
            prev = float(c.iloc[-2]) if nifty_d.index[-1].date() == nifty_today.index[-1].date() else float(last)
            gap = (float(nifty_today["Open"].iloc[0]) / prev - 1) * 100
            day = (float(nifty_today["Close"].iloc[-1]) / prev - 1) * 100
            if abs(gap) >= 1.0:
                r.verdict, r.size_factor = "REDUCED-SIZE", min(r.size_factor, 0.5)
                r.reasons.append(f"Nifty gapped {gap:+.2f}%: gap days whipsaw; wait 30+ minutes and halve size.")
            if abs(day) >= 2.0:
                r.verdict, r.size_factor = "NO-TRADE", 0.0
                r.reasons.append(f"Nifty is {day:+.2f}% on the day: panic/euphoria conditions, stops slip badly.")
            elif day <= -0.5 and r.bias == "bullish":
                r.bias = "neutral"
                r.reasons.append(f"Nifty {day:+.2f}% today against the daily uptrend: do not force longs.")
            elif day >= 0.5 and r.bias == "bearish":
                r.bias = "neutral"
                r.reasons.append(f"Nifty {day:+.2f}% today against the daily downtrend: do not force shorts.")
    if vix_d is None or len(vix_d) < 2:
        r.reasons.append("India VIX unavailable: check it manually before trading.")
    else:
        v, vp = float(vix_d["Close"].iloc[-1]), float(vix_d["Close"].iloc[-2])
        r.vix = round(v, 2)
        chg = (v / vp - 1) * 100
        if v >= VIX_EXTREME:
            r.verdict, r.size_factor = "NO-TRADE", 0.0
            r.reasons.append(f"India VIX {v:.1f} (>= {VIX_EXTREME:.0f}): extreme volatility, sit out.")
        elif v >= VIX_ELEVATED or chg >= VIX_SPIKE_PCT:
            if r.verdict != "NO-TRADE":
                r.verdict, r.size_factor = "REDUCED-SIZE", min(r.size_factor, 0.5)
            r.reasons.append(f"India VIX {v:.1f} ({chg:+.1f}% d/d): elevated fear, halve size and widen stops.")
        elif v < 11:
            r.reasons.append(f"India VIX {v:.1f}: very quiet market, expect small ranges and failed breakouts.")
        else:
            r.reasons.append(f"India VIX {v:.1f}: normal volatility.")
    return r


# ----------------------------------------------------------------------------- stock analysis

@dataclass
class Candidate:
    symbol: str
    side: str
    state: str                   # TRIGGERED | WATCH | PLAN
    grade: str
    score: int
    entry: float
    stop: float
    target1: float               # 1R: book half, move stop to entry
    target2: float               # 2R
    qty: int
    max_loss: float
    net_rr: float
    last: float
    why: list[str]
    cautions: list[str]


def daily_metrics(d: pd.DataFrame, nifty_d: pd.DataFrame | None) -> dict | None:
    if d is None or len(d) < 30:
        return None
    c = d["Close"]
    last = float(c.iloc[-1])
    a = float(atr(d).iloc[-1])
    e20, e50 = float(ema(c, 20).iloc[-1]), float(ema(c, 50).iloc[-1])
    trend = "up" if last > e20 > e50 else "down" if last < e20 < e50 else "flat"
    rs = None
    if nifty_d is not None and len(nifty_d) > 6 and len(c) > 6:
        rs = (last / float(c.iloc[-6]) - 1) * 100 - (float(nifty_d["Close"].iloc[-1]) / float(nifty_d["Close"].iloc[-6]) - 1) * 100
    rng = d["High"] - d["Low"]
    h, l = float(d["High"].iloc[-1]), float(d["Low"].iloc[-1])
    return {
        "close": last, "atr": a, "atr_pct": a / last * 100, "trend": trend, "rs5": rs,
        "turnover_cr": float((c * d["Volume"]).tail(20).mean()) / 1e7,
        "avg_vol": float(d["Volume"].tail(20).mean()),
        "nr7": bool(rng.iloc[-1] <= rng.tail(7).min()),
        "high20": float(d["High"].tail(20).max()), "low20": float(d["Low"].tail(20).min()),
        "pdh": h, "pdl": l, "pivot": (h + l + last) / 3,
    }


def liquidity_reject(m: dict) -> str | None:
    if m["close"] < MIN_PRICE:
        return f"price below Rs {MIN_PRICE:.0f}"
    if m["turnover_cr"] < MIN_TURNOVER_CR:
        return f"illiquid (avg turnover Rs {m['turnover_cr']:.0f} cr)"
    if not ATR_PCT_RANGE[0] <= m["atr_pct"] <= ATR_PCT_RANGE[1]:
        return f"daily ATR {m['atr_pct']:.1f}% outside {ATR_PCT_RANGE[0]}-{ATR_PCT_RANGE[1]}%"
    return None


def rvol(intra: pd.DataFrame, today, n_bars: int, avg_daily_vol: float) -> tuple[float | None, bool]:
    """Today's cumulative volume vs the same number of bars on prior days. (value, is_estimate)"""
    vol_today = float(intra[intra.index.date == today]["Volume"].sum())
    prior = [float(g["Volume"].head(n_bars).sum()) for day, g in intra.groupby(intra.index.date)
             if day != today and len(g) >= n_bars]
    if prior and sum(prior) > 0:
        return vol_today / (sum(prior) / len(prior)), False
    if avg_daily_vol > 0:   # crude fallback: assumes volume is spread evenly over 75 bars
        return vol_today / (avg_daily_vol * n_bars / 75), True
    return None, True


def _score(side: str, m: dict, bias: str, rv: float | None, near_extreme: bool) -> tuple[int, list[str], list[str]]:
    why, cautions, s = [], [], 0
    want_trend = "up" if side == "long" else "down"
    if m["trend"] == want_trend:
        s += 2; why.append(f"daily trend {m['trend']}")
    elif m["trend"] != "flat":
        s -= 1; cautions.append(f"against the daily trend ({m['trend']})")
    rs = m["rs5"]
    if rs is not None:
        aligned = rs if side == "long" else -rs
        if aligned >= 1:
            s += 2; why.append(f"5-day relative strength vs Nifty {rs:+.1f}%")
        elif aligned > 0:
            s += 1
        elif aligned <= -1:
            cautions.append(f"relative strength vs Nifty {rs:+.1f}% works against a {side}")
    want_bias = "bullish" if side == "long" else "bearish"
    if bias == want_bias:
        s += 2; why.append(f"market bias {bias}")
    elif bias == "neutral":
        s += 1
    else:
        s -= 2; cautions.append(f"against the market ({bias}): most stocks follow the index")
    if rv is not None:
        if rv >= 2:
            s += 3; why.append(f"relative volume {rv:.1f}x")
        elif rv >= GOOD_RVOL:
            s += 2; why.append(f"relative volume {rv:.1f}x")
        elif rv >= MIN_RVOL:
            s += 1; cautions.append(f"volume only {rv:.1f}x normal: breakout less trustworthy")
    if m["nr7"]:
        s += 1; why.append("narrowest range in 7 days (range expansion likely)")
    if near_extreme:
        s += 1; why.append("near 20-day " + ("high" if side == "long" else "low"))
    return s, why, cautions


def _grade(score: int, max_score: int) -> str:
    frac = score / max_score
    return "A" if frac >= 0.75 else "B" if frac >= 0.55 else "C"


def _build(symbol, side, state, entry, stop, m, bias, rv, last, capital, risk_pct, max_lev, max_score, extra_cautions):
    entry = tick(entry)
    # stops tighter than this sit inside normal noise, and charges then eat the reward
    min_dist = max(entry * 0.003, 0.25 * m["atr"])
    if side == "long":
        stop = tick(min(stop, entry - min_dist))
        r = entry - stop
        t1, t2 = tick(entry + r), tick(entry + 2 * r)
        near = entry >= m["high20"] - 0.5 * m["atr"]
    else:
        stop = tick(max(stop, entry + min_dist))
        r = stop - entry
        t1, t2 = tick(entry - r), tick(entry - 2 * r)
        near = entry <= m["low20"] + 0.5 * m["atr"]
    score, why, cautions = _score(side, m, bias, rv, near)
    cautions += extra_cautions
    sz = size_position(side, entry, stop, t2, capital, risk_pct, max_lev)
    if sz["qty"] == 0:
        return None, sz["reason"]
    if sz["net_rr"] < MIN_NET_RR:
        return None, f"net reward:risk {sz['net_rr']} after costs is below {MIN_NET_RR}"
    return Candidate(symbol, side, state, _grade(score, max_score), score, entry, stop, t1, t2, sz["qty"],
                     sz["max_loss"], sz["net_rr"], round(last, 2), why, cautions), None


def analyse_live(symbol, m, intra, today, bias, capital, risk_pct, max_lev):
    """Opening-range breakout with VWAP and volume confirmation. Returns (Candidate|None, skip_reason|None)."""
    t = intra[intra.index.date == today]
    if len(t) < OR_BARS:
        return None, "opening range not complete"
    prev_close = m["close"]
    o, last = float(t["Open"].iloc[0]), float(t["Close"].iloc[-1])
    gap = (o / prev_close - 1) * 100
    move = (last / prev_close - 1) * 100
    if abs(gap) > MAX_GAP_PCT:
        return None, f"gapped {gap:+.1f}%: news-driven, erratic"
    if abs(move) > MAX_DAY_MOVE_PCT:
        return None, f"already {move:+.1f}% on the day: circuit-limit risk"
    orh, orl = float(t["High"].head(OR_BARS).max()), float(t["Low"].head(OR_BARS).min())
    tp = (t["High"] + t["Low"] + t["Close"]) / 3
    vol_sum = float(t["Volume"].sum())
    vwap = float((tp * t["Volume"]).sum() / vol_sum) if vol_sum else last
    rv, rv_est = rvol(intra, today, len(t), m["avg_vol"])
    a = m["atr"]
    extra = [f"relative volume is an estimate ({rv:.1f}x)"] if rv_est and rv is not None else []

    if last > orh:
        side, entry, stop = "long", orh * 1.0005, max(orl, orh - 0.5 * a)
    elif last < orl:
        side, entry, stop = "short", orl * 0.9995, min(orh, orl + 0.5 * a)
    else:  # inside the range: pick the side the daily picture supports and wait
        long_pts = (m["trend"] == "up") + ((m["rs5"] or 0) > 0) + (bias == "bullish")
        short_pts = (m["trend"] == "down") + ((m["rs5"] or 0) < 0) + (bias == "bearish")
        if long_pts == short_pts:
            return None, "inside opening range with no directional edge"
        if long_pts > short_pts:
            side, entry, stop = "long", orh * 1.0005, max(orl, orh - 0.5 * a)
        else:
            side, entry, stop = "short", orl * 0.9995, min(orh, orl + 0.5 * a)
        cand, why_not = _build(symbol, side, "WATCH", entry, stop, m, bias, rv, last, capital, risk_pct, max_lev, 11,
                               extra + ["not triggered yet: enter only on a 5-min close beyond the level with volume"])
        return cand, why_not

    if (side == "long" and last < vwap) or (side == "short" and last > vwap):
        return None, f"{side} breakout but price on the wrong side of VWAP ({vwap:.2f})"
    if rv is not None and rv < MIN_RVOL:
        return None, f"breakout on weak volume ({rv:.1f}x)"
    risk = abs(entry - stop)
    if abs(last - entry) > risk:
        return None, f"already more than 1R past the {side} trigger: do not chase; wait for a pullback to VWAP ({vwap:.2f})"
    if abs(last - o) > 1.2 * a:
        return None, "has already travelled more than its average daily range"
    return _build(symbol, side, "TRIGGERED", entry, stop, m, bias, rv, last, capital, risk_pct, max_lev, 11,
                  extra + [f"VWAP {vwap:.2f}: exit if a 5-min candle closes back through it"])


def analyse_plan(symbol, m, bias, capital, risk_pct, max_lev):
    """No live data: next-session levels from the previous day's high/low."""
    long_pts = (m["trend"] == "up") + ((m["rs5"] or 0) > 0) + (bias == "bullish")
    short_pts = (m["trend"] == "down") + ((m["rs5"] or 0) < 0) + (bias == "bearish")
    if long_pts == short_pts or max(long_pts, short_pts) < 2:
        return None, "no clear directional edge on the daily chart"
    a = m["atr"]
    if long_pts > short_pts:
        side, entry, stop = "long", m["pdh"] * 1.0005, m["pdh"] - 0.4 * a
    else:
        side, entry, stop = "short", m["pdl"] * 0.9995, m["pdl"] + 0.4 * a
    return _build(symbol, side, "PLAN", entry, stop, m, bias, None, m["close"], capital, risk_pct, max_lev, 8,
                  ["plan only: valid if price breaks the level after 09:30 with above-average volume and Nifty agrees",
                   "skip if the stock opens with a gap beyond the entry level"])


# ----------------------------------------------------------------------------- data

def _norm(df: pd.DataFrame | None) -> pd.DataFrame | None:
    if df is None or df.empty:
        return None
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"]).sort_index()
    if df.index.tz is None:
        df.index = df.index.tz_localize(IST)       # naive timestamps are assumed to be IST
    else:
        df.index = df.index.tz_convert(IST)
    return df if len(df) else None


def load_csv(data_dir: Path, symbols: list[str]):
    """data_dir/daily/<SYM>.csv and data_dir/intraday/<SYM>.csv (5-min), columns Date,Open,High,Low,Close,Volume."""
    out = {"daily": {}, "intraday": {}}
    for kind in out:
        for s in symbols + [NIFTY, VIX]:
            p = data_dir / kind / f"{s}.csv"
            if p.exists():
                out[kind][s] = _norm(pd.read_csv(p, index_col=0, parse_dates=True))
    return out["daily"], out["intraday"]


def load_yahoo(symbols: list[str]):
    try:
        import yfinance as yf
    except ImportError:
        sys.exit("yfinance not installed. Run: pip install yfinance pandas  (or pass --data-dir with CSV files)")
    tickers = {s: f"{s}.NS" for s in symbols} | YAHOO_INDEX
    out = []
    for period, interval in (("6mo", "1d"), ("5d", "5m")):
        raw = yf.download(list(tickers.values()), period=period, interval=interval, group_by="ticker",
                          auto_adjust=False, progress=False, threads=True)
        frames = {}
        for s, t in tickers.items():
            try:
                frames[s] = _norm(raw[t])
            except (KeyError, TypeError):
                frames[s] = None
        out.append(frames)
    return out[0], out[1]


# ----------------------------------------------------------------------------- scan

def scan(daily: dict, intraday: dict, symbols: list[str], now: datetime, capital: float, risk_pct: float,
         max_lev: float = 3.0, top: int = 5) -> dict:
    phase, guidance, entries_ok = session_phase(now)
    nifty_d = daily.get(NIFTY)
    nifty_i = intraday.get(NIFTY)
    today = now.date()
    live = phase not in ("CLOSED", "PRE-OPEN") and any(
        df is not None and df.index[-1].date() == today for s, df in intraday.items() if s not in (NIFTY, VIX))
    warnings = []
    nifty_today = None
    if live and nifty_i is not None:
        nifty_today = nifty_i[nifty_i.index.date == today]
    regime = market_regime(nifty_d, daily.get(VIX), nifty_today)
    if phase == "MIDDAY" and regime.verdict == "TRADE":
        regime.verdict, regime.size_factor = "REDUCED-SIZE", 0.5
    if live and not entries_ok:
        regime.verdict, regime.size_factor = "NO-TRADE", 0.0
    eff_risk = risk_pct * regime.size_factor if regime.size_factor else risk_pct
    mode = "LIVE" if live else "PLAN"
    if phase not in ("CLOSED", "PRE-OPEN") and not live:
        warnings.append("Market hours but no intraday bars for today: showing a PLAN from daily data only.")

    cands, skipped = [], {}
    for s in symbols:
        d = daily.get(s)
        # in live mode the daily frame may already contain today's partial bar: drop it
        if d is not None and live and d.index[-1].date() == today:
            d = d.iloc[:-1]
        m = daily_metrics(d, nifty_d.iloc[:-1] if (live and nifty_d is not None and nifty_d.index[-1].date() == today) else nifty_d)
        if m is None:
            skipped[s] = "no/insufficient daily data"
            continue
        rej = liquidity_reject(m)
        if rej:
            skipped[s] = rej
            continue
        if live:
            i = intraday.get(s)
            if i is None or i.index[-1].date() != today:
                skipped[s] = "no intraday data today"
                continue
            age = (now - i.index[-1].to_pydatetime()) / timedelta(minutes=1)
            if age > 25 and "stale" not in " ".join(warnings):
                warnings.append(f"Intraday data is stale ({age:.0f} min old for {s}). Confirm every level on your broker terminal.")
            c, why_not = analyse_live(s, m, i, today, regime.bias, capital, eff_risk, max_lev)
        else:
            c, why_not = analyse_plan(s, m, regime.bias, capital, eff_risk, max_lev)
        if c is None:
            skipped[s] = why_not
        elif c.grade == "C":
            skipped[s] = f"low-quality {c.side} setup (score {c.score})"
        else:
            cands.append(c)
    order = {"TRIGGERED": 0, "WATCH": 1, "PLAN": 2}
    cands.sort(key=lambda c: (order[c.state], -c.score, -c.net_rr))
    if regime.verdict == "NO-TRADE":
        shown = []
    else:
        shown = cands[:top]
    return {
        "as_of_ist": now.strftime("%Y-%m-%d %H:%M"), "mode": mode, "phase": phase, "phase_guidance": guidance,
        "new_entries_allowed": bool(entries_ok and regime.verdict != "NO-TRADE") if live else False,
        "regime": asdict(regime), "capital": capital, "risk_pct_per_trade": round(eff_risk, 3),
        "daily_loss_limit": round(capital * min(3 * risk_pct, 2.0) / 100, 2),
        "candidates": [asdict(c) for c in shown], "suppressed_by_no_trade": len(cands) if regime.verdict == "NO-TRADE" else 0,
        "skipped": skipped, "warnings": warnings,
    }


def render(res: dict) -> str:
    r = res["regime"]
    L = [f"=== NSE intraday scan | {res['as_of_ist']} IST | mode {res['mode']} | session {res['phase']} ===",
         res["phase_guidance"], "",
         f"MARKET VERDICT: {r['verdict']}   bias: {r['bias']}   Nifty: {r['nifty_close']}   India VIX: {r['vix']}"]
    L += [f"  - {x}" for x in r["reasons"]]
    L += [f"  ! {w}" for w in res["warnings"]]
    L += ["", f"Capital Rs {res['capital']:,.0f} | risk per trade {res['risk_pct_per_trade']}% "
              f"| STOP TRADING FOR THE DAY at a loss of Rs {res['daily_loss_limit']:,.0f}", ""]
    if r["verdict"] == "NO-TRADE":
        L.append(f"NO TRADE. {res['suppressed_by_no_trade']} setups were found but are withheld because conditions fail the checklist.")
    elif not res["candidates"]:
        L.append("No stock passes the checklist. Not trading is the correct decision.")
    for i, c in enumerate(res["candidates"], 1):
        L.append(f"{i}. {c['symbol']}  {c['side'].upper()}  [{c['state']}]  grade {c['grade']} (score {c['score']})  last {c['last']}")
        verb = "above" if c["side"] == "long" else "below"
        L.append(f"   entry {verb} {c['entry']} | stop {c['stop']} | T1 {c['target1']} (book half, stop to entry) | T2 {c['target2']}")
        L.append(f"   qty {c['qty']} | max loss Rs {c['max_loss']:,.0f} | net R:R {c['net_rr']}")
        if c["why"]:
            L.append("   why: " + "; ".join(c["why"]))
        for x in c["cautions"]:
            L.append(f"   caution: {x}")
    if res["skipped"]:
        L += ["", "Skipped:"] + [f"  {s}: {why}" for s, why in sorted(res["skipped"].items())]
    L += ["", "Screening aid only - not investment advice, not a prediction. Check the event calendar and live prices before acting."]
    return "\n".join(L)


# ----------------------------------------------------------------------------- CLI

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="market verdict and ranked candidates")
    s.add_argument("--capital", type=float, required=True, help="trading capital in Rs")
    s.add_argument("--risk-pct", type=float, default=0.5, help="max loss per trade as %% of capital (default 0.5)")
    s.add_argument("--max-leverage", type=float, default=3.0, help="cap on position value / capital (default 3; legal max 5)")
    s.add_argument("--symbols", help="comma-separated NSE symbols (overrides --universe)")
    s.add_argument("--universe", type=Path, default=Path(__file__).with_name("universe.txt"))
    s.add_argument("--data-dir", type=Path, help="read CSVs instead of Yahoo Finance")
    s.add_argument("--asof", help="override current IST time, 'YYYY-MM-DD HH:MM' (for testing/replay)")
    s.add_argument("--top", type=int, default=5)
    s.add_argument("--json", action="store_true")

    z = sub.add_parser("size", help="position size for one idea")
    z.add_argument("--side", choices=["long", "short"], required=True)
    for a in ("entry", "stop", "target", "capital"):
        z.add_argument(f"--{a}", type=float, required=True)
    z.add_argument("--risk-pct", type=float, default=0.5)
    z.add_argument("--max-leverage", type=float, default=3.0)

    c = sub.add_parser("costs", help="round-trip intraday charges")
    c.add_argument("--buy", type=float, required=True)
    c.add_argument("--sell", type=float, required=True)
    c.add_argument("--qty", type=int, required=True)

    a = p.parse_args(argv)
    if a.cmd == "costs":
        out = round_trip_costs(a.buy, a.sell, a.qty)
        out["net_pnl"] = round((a.sell - a.buy) * a.qty - out["total"], 2)
        print(json.dumps(out, indent=2))
        return 0
    if a.cmd == "size":
        try:
            print(json.dumps(size_position(a.side, a.entry, a.stop, a.target, a.capital, a.risk_pct, a.max_leverage), indent=2))
        except ValueError as e:
            sys.exit(f"error: {e}")
        return 0

    if not 0 < a.risk_pct <= 2:
        sys.exit("error: --risk-pct must be between 0 and 2. Risking more than 2% of capital per trade is how accounts blow up.")
    if not 1 <= a.max_leverage <= 5:
        sys.exit("error: --max-leverage must be between 1 and 5 (5x is the regulatory ceiling for intraday equity).")
    if a.symbols:
        symbols = [x.strip().upper() for x in a.symbols.split(",") if x.strip()]
    else:
        symbols = [ln.split("#")[0].strip() for ln in a.universe.read_text().splitlines()]
        symbols = [x for x in symbols if x]
    now = datetime.strptime(a.asof, "%Y-%m-%d %H:%M").replace(tzinfo=IST) if a.asof else datetime.now(IST)
    daily, intraday = load_csv(a.data_dir, symbols) if a.data_dir else load_yahoo(symbols)
    if not any(v is not None for k, v in daily.items() if k not in (NIFTY, VIX)):
        sys.exit("error: no price data could be loaded (network blocked or bad symbols?). No recommendation can be made.")
    res = scan(daily, intraday, symbols, now, a.capital, a.risk_pct, a.max_leverage, a.top)
    print(json.dumps(res, indent=2) if a.json else render(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
