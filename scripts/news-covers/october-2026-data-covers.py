#!/usr/bin/env python3
"""Data-drawn SVG covers for the October 2026 newsroom takes.

Each cover is built from the article's own series (ASIC daily aggregate
short positions as a percentage of shares on issue, and end-of-day prices),
hand-composed as SVG in the house palette, then rasterised to a 1600x900 PNG
for OpenGraph. Figures are the same ones the articles state; dates marked in
the sidecar JSON were read from the official ASIC CSV for that date.

    python3 scripts/news-covers/october-2026-data-covers.py          # write svg + json
    python3 scripts/news-covers/october-2026-data-covers.py --png    # also rasterise with headless Chromium
"""
from __future__ import annotations
import json, os, subprocess, sys, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web/public/assets/news"
W, H = 1600, 900

# House palette (DESIGN.md). True red/green are quarantined for market direction.
PAPER, CARD, INK, MUTED, BORDER = "#F9F8F5", "#FDFDFC", "#483932", "#72625A", "#E5E1DC"
AMBER, AMBER_LIGHT, RUST, AVOCADO, SAGE = "#9E5210", "#FFAC4D", "#D16A47", "#87A96B", "#9AC082"
CRT, SAND, DIM_SAND, TERM_BORDER = "#0D0D0D", "#E8DEB5", "#A39A75", "#352E27"
RED, GREEN = "#EF4444", "#22C55E"
MONO = "IBM Plex Mono, JetBrains Mono, Menlo, monospace"
SERIF = "Newsreader, Georgia, serif"

ASIC = "https://download.asic.gov.au/short-selling/RR{d}-001-SSDailyAggShortPos.csv"
VERIFIED = {"20260716","20260820","20260917","20260918","20260922","20260929","20260930",
            "20261006","20261008","20261009","20261013","20261014","20261015",
            "20251016","20260320","20260428","20260429","20260512","20260909","20260910","20260911","20260921"}

def d(s: str) -> dt.date:
    return dt.date(2026, int(s[:2]), int(s[3:]))

def series(dates: str, values: str):
    ds = dates.split(); vs = [float(v) for v in values.split()]
    assert len(ds) == len(vs), (len(ds), len(vs))
    return [(d(a), b) for a, b in zip(ds, vs)]

# ---------------------------------------------------------------- data ------
D30 = "07-16 07-20 07-22 07-27 07-29 07-31 08-04 08-07 08-11 08-13 08-17 08-20 08-24 08-26 08-28 09-02 09-04 09-08 09-10 09-15 09-17 09-21 09-23 09-28 09-30 10-02 10-06 10-09 10-13 10-15"
P20 = "07-21 07-24 07-30 08-04 08-10 08-13 08-19 08-24 08-27 09-02 09-07 09-11 09-16 09-21 09-25 09-30 10-06 10-09 10-15 10-20"
P12 = "07-21 07-29 08-06 08-14 08-24 09-01 09-08 09-16 09-24 10-02 10-12 10-20"

AYA_SHORT = series(
 "07-01 07-06 07-10 07-15 07-20 07-23 07-29 08-03 08-06 08-12 08-17 08-20 08-26 08-31 09-03 09-09 09-14 09-17 09-18 09-21 09-22 09-23 09-24 09-25 09-28 09-29 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15",
 "0.966 0.926 0.929 0.944 0.979 1.075 1.215 1.348 1.496 1.564 1.739 1.647 1.816 2.151 2.319 1.839 2.009 1.776 4.730 5.848 6.320 6.663 7.118 7.386 7.694 7.632 7.736 7.853 8.334 8.553 8.959 9.513 9.827 10.162 10.055 10.153 10.172 9.593")
AYA_PRICE = series(
 "07-21 07-24 07-28 07-31 08-05 08-10 08-12 08-17 08-20 08-24 08-27 09-01 09-04 09-08 09-11 09-14 09-15 09-16 09-17 09-18 09-21 09-22 09-23 09-24 09-25 09-28 09-29 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15 10-16 10-19 10-20",
 "5.30 5.64 5.09 4.03 4.51 4.43 4.80 4.95 5.05 4.53 4.99 4.38 4.18 3.91 3.27 3.22 3.26 3.28 3.64 3.94 3.77 3.82 3.87 3.97 3.81 3.57 3.54 3.56 3.43 3.70 3.25 3.15 3.31 3.25 3.01 3.05 3.00 2.88 2.59 2.74 2.64 2.54")

LITH_SHORT = {
 "PLS": series(D30, "9.44 9.34 9.45 9.50 9.34 9.79 10.09 10.25 10.40 10.63 10.65 10.80 11.05 11.11 11.10 11.25 11.19 11.23 11.25 11.05 11.28 11.74 11.94 12.29 12.63 12.73 11.81 12.92 12.30 13.08"),
 "LTR": series(D30, "2.67 3.05 3.04 3.32 3.12 3.45 3.51 3.54 3.52 3.53 3.66 3.92 3.56 3.99 4.20 4.35 4.41 4.51 4.77 5.09 5.38 5.70 5.93 5.94 5.98 6.90 6.52 7.11 7.47 8.01"),
 "CXO": series(D30, "0.24 0.26 0.22 0.25 0.33 0.28 0.23 0.21 0.23 0.22 0.23 0.22 0.21 0.23 0.23 0.23 0.30 0.30 0.30 0.39 0.39 2.59 2.75 3.60 3.82 3.84 4.03 4.23 4.66 4.79"),
 "ELV": series(D30, "3.47 3.53 3.07 2.83 2.82 3.01 3.03 3.14 3.40 3.41 3.54 3.62 3.58 4.01 3.86 3.79 4.10 4.13 4.69 5.07 5.01 6.12 6.05 6.49 6.58 6.82 7.11 6.92 6.46 6.62"),
 "VUL": series("07-16 07-21 07-27 07-30 08-05 08-10 08-14 08-19 08-24 08-28 09-02 09-08 09-11 09-16 09-22 09-25 10-01 10-06 10-12 10-15",
               "6.89 7.08 7.07 7.28 7.46 7.40 7.44 7.52 7.22 7.08 7.24 7.33 7.76 7.61 7.57 7.06 7.47 7.56 8.15 8.82"),
}
LITH_PRICE = {
 "PLS": series(P20, "4.12 4.14 4.21 4.28 4.72 4.86 4.76 5.47 5.15 5.19 4.93 4.52 4.25 4.13 3.84 3.86 3.81 3.50 2.97 2.93"),
 "LTR": series(P20, "1.21 1.185 0.985 1.03 1.20 1.23 1.15 1.325 1.145 1.24 1.185 1.07 1.02 1.03 0.94 0.93 0.83 0.77 0.68 0.695"),
 "CXO": series(P20, "0.24 0.24 0.225 0.255 0.305 0.35 0.37 0.395 0.365 0.345 0.33 0.345 0.365 0.375 0.345 0.32 0.305 0.245 0.205 0.21"),
 "ELV": series(P12, "7.91 7.54 7.86 9.20 9.63 8.60 7.75 6.54 6.13 5.18 4.56 3.80"),
 "VUL": series(P12, "2.62 2.57 2.74 2.93 2.81 2.72 2.56 2.24 2.07 1.73 1.37 1.135"),
}
LITH_COLOUR = {"PLS": AMBER_LIGHT, "LTR": RUST, "CXO": SAND, "ELV": AVOCADO, "VUL": DIM_SAND}

WTC_SHORT = series(
 "07-16 07-20 07-22 07-27 07-29 07-31 08-04 08-07 08-11 08-13 08-17 08-20 08-24 08-26 08-28 09-02 09-04 09-08 09-10 09-15 09-17 09-21 09-23 09-28 09-29 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15",
 "8.32 8.26 8.28 8.46 8.10 8.26 8.31 8.23 8.25 8.33 8.48 8.50 8.50 8.83 8.85 9.30 9.29 9.32 9.38 9.77 9.96 10.19 10.43 10.64 10.76 10.94 11.04 11.05 11.08 11.17 11.17 11.17 11.03 10.99 11.05 11.01 11.08")
WTC_PRICE = series(
 "07-21 07-24 07-30 08-04 08-10 08-13 08-19 08-24 08-27 09-02 09-07 09-11 09-16 09-21 09-25 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15 10-16 10-19 10-20",
 "34.00 30.02 37.89 37.86 41.05 41.10 39.58 43.49 39.55 37.65 36.26 32.69 32.27 31.77 31.33 32.46 31.34 33.43 32.73 31.90 32.09 32.26 33.63 34.07 33.11 33.55 34.50 37.61 38.12 38.64")

CONS_SHORT = {
 "DMP": series(D30, "13.85 13.79 13.83 13.64 13.28 12.71 12.58 12.69 12.68 12.64 12.59 12.55 12.33 12.61 12.27 11.98 11.71 11.80 11.93 12.03 12.03 11.71 11.93 11.76 11.63 11.74 11.70 11.92 12.05 11.89"),
 "TWE": series(D30, "10.56 10.57 10.33 10.38 10.32 10.40 10.51 10.77 10.78 11.31 11.78 12.01 11.97 11.87 11.87 11.74 11.71 11.62 11.56 11.38 11.32 10.72 10.83 10.86 10.64 10.51 10.54 10.54 10.27 9.90"),
 "EDV": series(D30, "9.70 9.68 9.71 9.67 9.32 9.25 9.23 8.58 8.42 8.44 8.39 8.28 8.41 8.75 8.92 8.96 9.16 9.19 9.22 9.20 9.11 8.30 8.36 8.65 8.58 8.67 8.68 8.57 8.53 8.46"),
}
CONS_PRICE = {
 "DMP": series(P20, "17.07 16.60 19.59 19.92 19.84 19.44 18.88 19.42 20.30 20.44 20.26 18.93 18.87 19.22 19.20 20.53 20.37 22.20 21.57 22.01"),
 "TWE": series(P20, "4.62 4.73 4.97 5.34 5.66 5.77 5.60 5.70 5.56 5.40 5.58 5.18 5.13 5.36 5.42 5.46 5.57 5.62 5.94 5.93"),
 "EDV": series("07-21 07-28 08-03 08-10 08-17 08-21 08-28 09-04 09-10 09-17 09-23 09-30 10-07 10-13 10-20",
               "3.36 3.54 3.52 3.63 3.52 3.39 3.11 3.26 3.12 2.98 3.01 3.01 2.97 3.05 3.21"),
}
CONS_DTC = {"EDV": 35.0, "DMP": 26.5, "TWE": 26.5}      # Shorted: position / 20-day average volume, 20 Oct
CONS_1M = {"EDV": 10.7, "DMP": 16.6, "TWE": 15.1}       # price change, month to 20 Oct

# Top ten by short interest, 16 Jul and 15 Oct (ASIC CSVs), plus each side's value for the other date.
TOP_JUL = [("LOT",22.80),("DMP",13.85),("DRO",12.87),("4DX",12.66),("FLT",12.44),("PDN",11.79),("TLX",11.70),("BOE",11.68),("CAR",11.57),("ELD",10.89)]
TOP_OCT = [("DRO",16.40),("LOT",15.48),("BOE",14.68),("ZIP",13.59),("PLS",13.08),("IPX",12.99),("PDN",12.09),("DMP",11.89),("LYC",11.73),("WTC",11.08)]
OTHER_JUL = {"ZIP":7.93,"PLS":9.44,"IPX":9.39,"LYC":9.72,"WTC":8.32}
OTHER_OCT = {"4DX":10.65,"FLT":10.31,"TLX":11.06,"CAR":5.02,"ELD":9.31}

# ------------------------------------------------------------- helpers ------
def esc(s): return s.replace("&","&amp;").replace("<","&lt;")
def text(x, y, s, size=20, fill=INK, family=MONO, weight=400, anchor="start", extra=""):
    return f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {extra}>{esc(s)}</text>'
def xscale(x0, x1, d0, d1):
    span = (d1 - d0).days or 1
    return lambda dd: x0 + (x1 - x0) * (dd - d0).days / span
def yscale(y0, y1, v0, v1):
    return lambda v: y0 - (y0 - y1) * (v - v0) / (v1 - v0)
def path(pts, sx, sy, stroke, width=4, dash=""):
    dd = " ".join(f'{"M" if i==0 else "L"} {sx(a):.1f} {sy(b):.1f}' for i,(a,b) in enumerate(pts))
    return f'<path d="{dd}" fill="none" stroke="{stroke}" stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round" {("stroke-dasharray=%s"%dash) if dash else ""}/>'
def grid(x0, x1, sy, ticks, fmt, colour, labelx, label_fill, size=18):
    out=[]
    for t in ticks:
        y=sy(t); out.append(f'<line x1="{x0}" x2="{x1}" y1="{y:.1f}" y2="{y:.1f}" stroke="{colour}" stroke-width="1"/>')
        out.append(text(labelx, y+6, fmt(t), size, label_fill, anchor="end"))
    return "\n".join(out)
def frame(bg):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img">\n<rect width="{W}" height="{H}" fill="{bg}"/>'
def mon(dd): return dd.strftime("%-d %b")
def source_line(y, fill, extra=""):
    return text(80, y, "Source: ASIC daily aggregate short-position reports, % of shares on issue, published T+4" + extra, 17, fill)

# NEXTDC: every ASIC observation 10 Aug to 15 Oct 2026 (the full published record for the window), daily closes to the 16 Oct pre-halt close.
NXT_SHORT = series(
 "08-10 08-11 08-12 08-13 08-14 08-17 08-18 08-19 08-20 08-21 08-24 08-25 08-26 08-27 08-28 08-31 09-01 09-02 09-03 09-04 09-07 09-08 09-09 09-10 09-11 09-14 09-15 09-16 09-17 09-18 09-21 09-22 09-23 09-24 09-25 09-28 09-29 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15",
 "7.84 7.81 7.76 7.68 7.63 7.64 7.60 7.58 7.66 7.65 7.66 7.68 7.71 7.80 8.01 7.94 8.03 8.02 8.01 8.11 8.03 8.06 8.05 9.43 9.56 9.34 9.28 9.09 8.96 8.64 8.38 8.36 8.47 8.48 8.48 8.53 8.59 8.77 8.73 8.68 8.69 8.69 8.55 8.46 8.52 8.56 8.63 8.52 8.35")
NXT_PRICE = series(
 "08-10 08-11 08-12 08-13 08-14 08-17 08-18 08-19 08-20 08-21 08-24 08-25 08-26 08-27 08-28 08-31 09-01 09-02 09-03 09-04 09-07 09-08 09-09 09-10 09-11 09-14 09-15 09-16 09-17 09-18 09-21 09-22 09-23 09-24 09-25 09-28 09-29 09-30 10-01 10-02 10-05 10-06 10-07 10-08 10-09 10-12 10-13 10-14 10-15 10-16",
 "14.40 14.46 14.44 14.68 14.88 14.81 14.73 13.90 13.90 13.67 13.36 13.59 13.80 13.58 13.87 13.81 13.23 12.72 12.54 12.86 12.75 12.52 12.79 12.30 12.06 11.71 11.24 11.39 11.06 11.36 10.98 11.40 11.57 11.41 11.21 10.91 10.81 10.83 10.60 10.74 10.64 10.41 10.23 10.28 10.37 10.15 9.38 9.57 8.86 9.18")
NXT_DROP = 5.51   # 21 Oct 2026, 10:08am, Capital Brief; the stock was halted 19 and 20 Oct

# -------------------------------------------------------------- covers ------
def cover_aya():
    s=[frame(PAPER)]
    s.append(text(80, 78, "SHORTED · ASX: AYA · ARTRYA", 20, AMBER, weight=700))
    s.append(text(80, 150, "The step", 72, INK, SERIF, 500))
    s.append(text(80, 196, "Reported short position, 1 July to 15 October 2026", 22, MUTED))
    x0,x1,y0,y1 = 80, 1300, 760, 260
    sx = xscale(x0,x1,d("07-01"),d("10-20")); sy = yscale(y0,y1,0,12)
    s.append(grid(x0,x1,sy,[0,2,4,6,8,10,12],lambda t:f"{t}%",BORDER,x0-12,MUTED))
    # price on the right axis, muted
    py = yscale(y0,y1,2,6)
    s.append(path(AYA_PRICE, sx, py, RUST, 3, '"8 8"'))
    s.append(text(x1+14, py(AYA_PRICE[-1][1])+6, f"${AYA_PRICE[-1][1]:.2f}", 20, RUST))
    s.append(text(x1+14, py(AYA_PRICE[0][1])+6, f"${AYA_PRICE[0][1]:.2f}", 20, RUST))
    s.append(text(x1+14, py(6)+6, "price", 16, RUST))
    # short series: ink before the step, amber from 17 Sep
    before=[p for p in AYA_SHORT if p[0] <= d("09-17")]
    after=[p for p in AYA_SHORT if p[0] >= d("09-17")]
    s.append(path(before, sx, sy, INK, 5))
    s.append(path(after, sx, sy, AMBER, 7))
    # the one-day step 17 -> 18 Sep
    xa, xb = sx(d("09-17")), sx(d("09-18"))
    s.append(f'<line x1="{xa:.1f}" x2="{xa:.1f}" y1="{sy(1.776):.1f}" y2="{sy(4.73)-18:.1f}" stroke="{AMBER}" stroke-width="2" stroke-dasharray="4 6"/>')
    s.append(text(xa-14, sy(3.3), "+2.95pp in one session, 18 Sep", 19, AMBER, weight=700, anchor="end"))
    peak = max(AYA_SHORT, key=lambda p:p[1])
    s.append(f'<circle cx="{sx(peak[0]):.1f}" cy="{sy(peak[1]):.1f}" r="9" fill="{AMBER}"/>')
    s.append(text(sx(peak[0])-16, sy(peak[1])-22, f"{peak[1]:.2f}% · {mon(peak[0])}", 26, INK, weight=700, anchor="end"))
    s.append(f'<circle cx="{sx(AYA_SHORT[0][0]):.1f}" cy="{sy(AYA_SHORT[0][1]):.1f}" r="7" fill="{INK}"/>')
    s.append(text(sx(AYA_SHORT[0][0])+14, sy(AYA_SHORT[0][1])-16, f"{AYA_SHORT[0][1]:.2f}%", 22, INK, weight=700))
    s.append(text(x0, 800, "1 Jul", 18, MUTED)); s.append(text(x1, 800, "15 Oct", 18, MUTED, anchor="end"))
    s.append(source_line(856, MUTED, "; price is the daily close to 20 October"))
    s.append("</svg>")
    return "\n".join(s)

def cover_lithium():
    s=[frame(CRT)]
    s.append(text(80, 78, "SHORTED · LITHIUM PRODUCERS · PLS LTR CXO ELV VUL", 20, AMBER_LIGHT, weight=700))
    s.append(text(80, 150, "Building into the slump", 72, SAND, SERIF, 500))
    s.append(text(80, 196, "Short position, 16 July to 15 October 2026; share price rebased to 21 July = 100", 22, DIM_SAND))
    # left panel: shorts
    x0,x1,y0,y1 = 80, 980, 760, 250
    d0,d1 = d("07-16"), d("10-15")
    sx = xscale(x0,x1,d0,d1); sy = yscale(y0,y1,0,14)
    s.append(grid(x0,x1,sy,[0,2,4,6,8,10,12,14],lambda t:f"{t}%",TERM_BORDER,x0-12,DIM_SAND))
    for code,pts in LITH_SHORT.items():
        s.append(path(pts, sx, sy, LITH_COLOUR[code], 5 if code=="PLS" else 4))
        last=pts[-1]
        s.append(text(x1+12, sy(last[1])+7, f"{code} {last[1]:.2f}%", 21, LITH_COLOUR[code], weight=700))
    # fix label overlaps: nudge ELV/VUL (6.62 vs 8.82 fine), LTR 8.01 vs VUL 8.82 close -> handled by offset below
    s.append(text(x0, 800, mon(d0), 18, DIM_SAND)); s.append(text(x1, 800, mon(d1), 18, DIM_SAND, anchor="end"))
    # right panel: prices rebased
    rx0,rx1,ry0,ry1 = 1230, 1520, 760, 250
    p0,p1 = d("07-21"), d("10-20")
    rsx = xscale(rx0,rx1,p0,p1); rsy = yscale(ry0,ry1,30,170)
    s.append(grid(rx0,rx1,rsy,[50,100,150],lambda t:f"{t}",TERM_BORDER,rx0-12,DIM_SAND))
    for code,pts in LITH_PRICE.items():
        base=pts[0][1]; rb=[(a,b/base*100) for a,b in pts]
        s.append(path(rb, rsx, rsy, LITH_COLOUR[code], 3))
    s.append(text(rx0, 800, "21 Jul", 18, DIM_SAND)); s.append(text(rx1, 800, "20 Oct", 18, DIM_SAND, anchor="end"))
    s.append(text(rx0, 232, "Prices, 21 Jul = 100", 19, DIM_SAND))
    s.append(text(rx1, rsy(36), "down 29% to 57%", 22, RUST, weight=700, anchor="end"))
    s.append(source_line(856, DIM_SAND, "; prices are daily closes"))
    s.append("</svg>")
    return "\n".join(s)

def cover_wtc():
    s=[frame(PAPER)]
    s.append(text(80, 78, "SHORTED · ASX: WTC · WISETECH GLOBAL", 20, AMBER, weight=700))
    s.append(text(80, 150, "Record short, no action", 72, INK, SERIF, 500))
    s.append(text(80, 196, "Short position (amber, left) and share price (ink, right), 16 July to 20 October 2026", 22, MUTED))
    x0,x1,y0,y1 = 80, 1340, 760, 250
    d0,d1 = d("07-16"), d("10-20")
    sx = xscale(x0,x1,d0,d1); sy = yscale(y0,y1,6,12); py = yscale(y0,y1,26,46)
    s.append(grid(x0,x1,sy,[6,7,8,9,10,11,12],lambda t:f"{t}%",BORDER,x0-12,MUTED))
    for t in [30,35,40,45]:
        s.append(text(x1+12, py(t)+6, f"${t}", 18, MUTED))
    # ASIC announcement marker
    xm = sx(d("10-14"))
    s.append(f'<rect x="{xm:.1f}" y="{y1}" width="{sx(d1)-xm:.1f}" height="{y0-y1}" fill="{CARD}" stroke="{BORDER}"/>')
    s.append(f'<line x1="{xm:.1f}" x2="{xm:.1f}" y1="{y1}" y2="{y0}" stroke="{AMBER}" stroke-width="2" stroke-dasharray="6 6"/>')
    s.append(text(xm-12, y0-54, "14 Oct", 20, AMBER, weight=700, anchor="end"))
    s.append(text(xm-12, y0-28, "\"Resolution of ASIC matters\"", 18, AMBER, anchor="end"))
    s.append(path(WTC_PRICE, sx, py, INK, 3.5))
    s.append(path(WTC_SHORT, sx, sy, AMBER, 6))
    last=WTC_SHORT[-1]
    s.append(f'<circle cx="{sx(last[0]):.1f}" cy="{sy(last[1]):.1f}" r="9" fill="{AMBER}"/>')
    s.append(text(sx(last[0])-16, sy(last[1])-24, f"{last[1]:.2f}% short · 15 Oct", 26, INK, weight=700, anchor="end"))
    lp=WTC_PRICE[-1]
    s.append(f'<circle cx="{sx(lp[0]):.1f}" cy="{py(lp[1]):.1f}" r="7" fill="{INK}"/>')
    s.append(text(sx(lp[0])+12, py(lp[1])-14, f"${lp[1]:.2f}", 24, INK, weight=700))
    s.append(text(sx(lp[0])+12, py(lp[1])+14, "+15% in four sessions", 18, MUTED))
    s.append(text(sx(WTC_SHORT[0][0])+10, sy(WTC_SHORT[0][1])+34, f"{WTC_SHORT[0][1]:.2f}% · 16 Jul", 20, AMBER, weight=700))
    # days to cover tile
    s.append(f'<rect x="100" y="{y0-96}" width="470" height="52" fill="{CARD}" stroke="{BORDER}"/>')
    s.append(text(116, y0-61, "Days to cover  20.7  (position ÷ 20-day average volume)", 18, INK))
    s.append(text(x0, 800, "16 Jul", 18, MUTED)); s.append(text(x1, 800, "20 Oct", 18, MUTED, anchor="end"))
    s.append(source_line(856, MUTED, "; price is the daily close"))
    s.append("</svg>")
    return "\n".join(s)

def cover_consumer():
    s=[frame("#F2F0ED")]
    s.append(text(80, 78, "SHORTED · ASX: DMP TWE EDV · CONSUMER", 20, AMBER, weight=700))
    s.append(text(80, 150, "Crowded exits", 72, INK, SERIF, 500))
    s.append(text(80, 196, "Days of average volume needed to buy back each short position, with the position and price over three months", 22, MUTED))
    rows=[("EDV","Endeavour Group",8.46),("DMP","Domino's Pizza",11.89),("TWE","Treasury Wine",9.90)]
    top=250; rh=180; bx0=400; bx1=1240; maxd=40
    for i,(code,name,pct) in enumerate(rows):
        y=top+i*rh
        s.append(text(80, y+46, code, 44, INK, weight=700))
        s.append(text(80, y+76, name, 18, MUTED))
        s.append(text(80, y+104, f"{pct:.2f}% short · 15 Oct", 18, MUTED))
        # runway: 5-day segments
        dtc=CONS_DTC[code]; seg=(bx1-bx0)/maxd*5
        for k in range(8):
            x=bx0+k*seg; filled = (k+1)*5 <= dtc; part = (not filled) and k*5 < dtc
            wseg = seg-6
            if filled or part:
                wfill = wseg if filled else (bx0+(bx1-bx0)*dtc/maxd - x - 6)
                s.append(f'<rect x="{x:.1f}" y="{y+22}" width="{max(wfill,0):.1f}" height="64" fill="{AMBER if filled else AMBER_LIGHT}"/>')
            s.append(f'<rect x="{x:.1f}" y="{y+22}" width="{wseg:.1f}" height="64" fill="none" stroke="{BORDER}"/>')
        xe=bx0+(bx1-bx0)*dtc/maxd
        s.append(text(xe+14, y+66, f"{dtc:.1f} days", 30, INK, weight=700))
        # sparklines: short (ink) and price (rust) over 3 months, far right
        kx0,kx1=1320,1520
        sp=CONS_SHORT[code]; pr=CONS_PRICE[code]
        sxs=xscale(kx0,kx1,sp[0][0],sp[-1][0]); lo=min(v for _,v in sp); hi=max(v for _,v in sp)
        sys_=yscale(y+54,y+24,lo,hi); s.append(path(sp,sxs,sys_,INK,3))
        s.append(text(kx1+8, sys_(sp[-1][1])+5, "short", 14, INK))
        pxs=xscale(kx0,kx1,pr[0][0],pr[-1][0]); plo=min(v for _,v in pr); phi=max(v for _,v in pr)
        pys=yscale(y+106,y+70,plo,phi); s.append(path(pr,pxs,pys,RUST,3))
        s.append(text(kx1+8, pys(pr[-1][1])+5, f"+{CONS_1M[code]:.1f}%", 14, RUST, weight=700))
    for k in range(0,45,10):
        x=bx0+(bx1-bx0)*k/maxd
        s.append(text(x, 800, f"{k} days", 16, MUTED, anchor="middle" if k else "start"))
    s.append(text(1580, 232, "Jul to Oct: short (ink), price (rust, 1-month change)", 13, MUTED, anchor="end"))
    s.append(source_line(856, MUTED, "; days to cover and price are Shorted's, 20 October"))
    s.append("</svg>")
    return "\n".join(s)

def cover_market():
    s=[frame(CRT)]
    s.append(text(80, 78, "SHORTED · ASX MOST SHORTED · 16 JULY TO 15 OCTOBER 2026", 20, AMBER_LIGHT, weight=700))
    s.append(text(80, 150, "Half the top ten turned over", 72, SAND, SERIF, 500))
    s.append(text(80, 196, "The ten most shorted stocks on each date, and where each one moved", 22, DIM_SAND))
    xl, xr, y0, y1 = 420, 1000, 790, 250
    sy = yscale(y0, y1, 4, 24)
    for t in [5,10,15,20]:
        yy=sy(t); s.append(f'<line x1="{xl}" x2="{xr}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="{TERM_BORDER}"/>')
        s.append(text(xl-150, yy+6, f"{t}%", 18, DIM_SAND, anchor="end"))
    s.append(text(xl, 230, "16 Jul", 20, DIM_SAND, anchor="end")); s.append(text(xr, 230, "15 Oct", 20, DIM_SAND))
    jul=dict(TOP_JUL); oct_=dict(TOP_OCT)
    codes=set(jul)|set(oct_)
    def place(labels, anchor_x, side):
        # avoid label collisions: sort by y, push apart by 24px
        labels.sort(key=lambda t:t[1]); ys=[y for _,y,_,_ in labels]; gap=23
        for i in range(1,len(ys)): ys[i]=max(ys[i], ys[i-1]+gap)          # push down
        top=min(ys[-1], y0+8)
        ys[-1]=top
        for i in range(len(ys)-2,-1,-1): ys[i]=min(ys[i], ys[i+1]-gap)    # push back up from the floor
        return [(c,yy,col,t) for (c,_,col,t),yy in zip(labels,ys)]
    left_labels=[]; right_labels=[]
    for c in sorted(codes):
        vj = jul.get(c, OTHER_JUL.get(c)); vo = oct_.get(c, OTHER_OCT.get(c))
        entrant = c in oct_ and c not in jul; leaver = c in jul and c not in oct_
        col = AMBER_LIGHT if entrant else (DIM_SAND if leaver else SAND)
        s.append(f'<line x1="{xl}" x2="{xr}" y1="{sy(vj):.1f}" y2="{sy(vo):.1f}" stroke="{col}" stroke-width="{5 if entrant else 3}" {"stroke-dasharray=\"6 8\"" if leaver else ""} stroke-linecap="round"/>')
        s.append(f'<circle cx="{xl}" cy="{sy(vj):.1f}" r="6" fill="{col}"/><circle cx="{xr}" cy="{sy(vo):.1f}" r="6" fill="{col}"/>')
        left_labels.append((c, sy(vj)+6, col, f"{c} {vj:.2f}%"))
        right_labels.append((c, sy(vo)+6, col, f"{vo:.2f}% {c}"))
    for c,yy,col,t in place(left_labels, xl, "l"):
        s.append(text(xl-16, yy, t, 17, col, weight=700 if col==AMBER_LIGHT else 400, anchor="end"))
    for c,yy,col,t in place(right_labels, xr, "r"):
        s.append(text(xr+16, yy, t, 17, col, weight=700 if col==AMBER_LIGHT else 400))
    # legend + stats, right column
    lx=1200
    s.append(f'<line x1="{lx}" x2="{lx+40}" y1="300" y2="300" stroke="{AMBER_LIGHT}" stroke-width="5"/>'); s.append(text(lx+52, 306, "entered the ten", 18, SAND))
    s.append(f'<line x1="{lx}" x2="{lx+40}" y1="336" y2="336" stroke="{SAND}" stroke-width="3"/>'); s.append(text(lx+52, 342, "stayed", 18, SAND))
    s.append(f'<line x1="{lx}" x2="{lx+40}" y1="372" y2="372" stroke="{DIM_SAND}" stroke-width="3" stroke-dasharray="6 8"/>'); s.append(text(lx+52, 378, "left the ten", 18, SAND))
    s.append(text(lx, 480, "16", 96, AMBER_LIGHT, weight=700))
    s.append(text(lx+130, 480, "stocks above 10%", 22, SAND))
    s.append(text(lx+130, 510, "on 15 Oct; 12 in Sept", 18, DIM_SAND))
    s.append(text(lx, 610, "188 : 104", 54, SAND, weight=700))
    s.append(text(lx, 646, "risers to fallers, week to 12 Oct", 18, DIM_SAND))
    s.append(text(lx, 730, "XJO below its 200-day", 22, RUST, weight=700))
    s.append(text(lx, 760, "Cash rate 4.35% · CPI 4.0%", 18, DIM_SAND))
    s.append(source_line(856, DIM_SAND, "; LOT's fall is a doubled share count, not covering"))
    s.append("</svg>")
    return "\n".join(s)


# Australian petroleum statistics (DCCEEW, via Shorted), July of each year, megalitres.
FUEL_YEARS = list(range(2010, 2027))
FUEL_IMPORTS = [1449,1747,1743,2120,2132,2565,2516,2956,3134,3112,3314,3333,3459,4480,5139,4783,4468]
FUEL_REFINERY = [3714,3499,3459,3109,3214,2468,2382,2495,2506,2403,1704,1599,1255,1222,1088,1150,1230]
FUEL_IMP = [(dt.date(y,7,1), v) for y,v in zip(FUEL_YEARS, FUEL_IMPORTS)]
FUEL_REF = [(dt.date(y,7,1), v) for y,v in zip(FUEL_YEARS, FUEL_REFINERY)]

def cover_fuel():
    s=[frame(CRT)]
    s.append(text(80, 78, "SHORTED · AUSTRALIA'S FUEL SUPPLY · JULY 2010 TO JULY 2026", 20, AMBER_LIGHT, weight=700))
    s.append(text(80, 150, "Five weeks of diesel", 72, SAND, SERIF, 500))
    s.append(text(80, 196, "Fuel imported refined (amber) and refined at home (sand), each July; days held under the obligation, right", 22, DIM_SAND))
    x0,x1,y0,y1 = 80, 880, 760, 260
    sx = xscale(x0,x1,dt.date(2010,7,1),dt.date(2026,7,1)); sy = yscale(y0,y1,0,6000)
    s.append(grid(x0,x1,sy,[0,2000,4000,6000],lambda t:f"{t/1000:.0f} GL",TERM_BORDER,x0-12,DIM_SAND))
    s.append(path(FUEL_REF, sx, sy, SAND, 4))
    s.append(path(FUEL_IMP, sx, sy, AMBER_LIGHT, 6))
    s.append(text(sx(FUEL_IMP[-1][0])+14, sy(FUEL_IMP[-1][1])+8, f"imported {FUEL_IMP[-1][1]/1000:.1f} GL", 21, AMBER_LIGHT, weight=700))
    s.append(text(sx(FUEL_REF[-1][0])+14, sy(FUEL_REF[-1][1])+8, f"refined {FUEL_REF[-1][1]/1000:.1f} GL", 21, SAND))
    s.append(text(sx(FUEL_IMP[0][0])+10, sy(FUEL_IMP[0][1])+40, "2010: 3.7 GL refined, 1.4 imported", 17, DIM_SAND))
    cross = dt.date(2015,7,1)
    s.append(f'<line x1="{sx(cross):.1f}" x2="{sx(cross):.1f}" y1="{y1}" y2="{y0}" stroke="{TERM_BORDER}" stroke-dasharray="4 8"/>')
    s.append(text(sx(cross)+8, y1+24, "2015: imports overtake refining", 16, DIM_SAND))
    for y in (2010,2014,2018,2022,2026):
        s.append(text(sx(dt.date(y,7,1)), 800, f"Jul {y}", 17, DIM_SAND, anchor="middle" if y not in (2010,2026) else ("start" if y==2010 else "end")))
    # right: days of cover as three vertical gauges against the 50-day target
    gx=1210; gw=80; gap=50; gy0=760; gy1=320
    gs = yscale(gy0, gy1, 0, 60)
    for i,(label,days,ml) in enumerate([("Petrol",41,"1,730 ML"),("Diesel",33,"3,044 ML"),("Jet",28,"757 ML")]):
        x=gx+i*(gw+gap)
        s.append(f'<rect x="{x}" y="{gy1}" width="{gw}" height="{gy0-gy1}" fill="none" stroke="{TERM_BORDER}"/>')
        s.append(f'<rect x="{x}" y="{gs(days):.1f}" width="{gw}" height="{gy0-gs(days):.1f}" fill="{AMBER if label=="Diesel" else DIM_SAND}"/>')
        s.append(text(x+gw/2, gs(days)-12, f"{days} days", 24, SAND, weight=700, anchor="middle"))
        s.append(text(x+gw/2, 800, label, 18, DIM_SAND, anchor="middle"))
        s.append(text(x+gw/2, 824, ml, 14, DIM_SAND, anchor="middle"))
    right = gx+3*gw+2*gap
    for t,lab in ((50,"50-day target, 2030"),(32,"diesel floor, 32")):
        yy=gs(t); s.append(f'<line x1="{gx-10}" x2="{right+10}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="{RUST if t==50 else SAND}" stroke-width="2" stroke-dasharray="6 6"/>')
        if t==50: s.append(text(right+10, yy-8, lab, 15, RUST, anchor="end"))
        else: s.append(text(gx-16, yy+5, lab, 15, SAND, anchor="end"))
    s.append(text(gx, 296, "Days held, 13 Oct 2026", 18, DIM_SAND))
    s.append(text(80, 856, "Source: DCCEEW Australian Petroleum Statistics (volumes, via Shorted); fuelplan.gov.au (days held under the Minimum Stockholding Obligation)", 17, DIM_SAND))
    s.append("</svg>")
    return "\n".join(s)

def cover_nxt():
    s=[frame(PAPER)]
    s.append(text(80, 78, "SHORTED · ASX: NXT · NEXTDC", 20, AMBER, weight=700))
    s.append(text(80, 150, "Short before the fall", 72, INK, SERIF, 500))
    s.append(text(80, 196, "Short position (amber, left) and share price (ink, right), 10 August to 21 October 2026", 22, MUTED))
    x0,x1,y0,y1 = 80, 1300, 760, 250
    d0,d1 = d("08-10"), d("10-21")
    sx = xscale(x0,x1,d0,d1); sy = yscale(y0,y1,6.5,10); py = yscale(y0,y1,4,16)
    s.append(grid(x0,x1,sy,[7,8,9,10],lambda t:f"{t}%",BORDER,x0-12,MUTED))
    for t in [8,10,12,14]:
        s.append(text(x1+12, py(t)+6, f"${t}", 18, MUTED))
    # halt zone: 19 and 20 Oct, no trade
    xh0, xh1 = sx(d("10-16")), sx(d1)
    s.append(f'<rect x="{xh0:.1f}" y="{y1}" width="{xh1-xh0:.1f}" height="{y0-y1}" fill="{CARD}" stroke="{BORDER}"/>')
    s.append(text((xh0+xh1)/2, y1+22, "halt", 16, MUTED, anchor="middle"))
    # convertible pricing and index rebalance markers
    xc = sx(d("09-10"))
    s.append(f'<line x1="{xc:.1f}" x2="{xc:.1f}" y1="{y1}" y2="{y0}" stroke="{AMBER}" stroke-width="2" stroke-dasharray="6 6"/>')
    s.append(text(xc-12, y1+30, "10 Sep", 20, AMBER, weight=700, anchor="end"))
    s.append(text(xc-12, y1+54, "A$1.1bn convertible priced;", 18, AMBER, anchor="end"))
    s.append(text(xc-12, y1+76, "18.6m-share delta placement", 18, AMBER, anchor="end"))
    xr = sx(d("09-18"))
    s.append(f'<line x1="{xr:.1f}" x2="{xr:.1f}" y1="{y1}" y2="{y0}" stroke="{BORDER}" stroke-width="2" stroke-dasharray="4 8"/>')
    s.append(text(xr+8, y0-28, "18 Sep · ASX 50 rebalance, 21.9m shares traded", 17, MUTED))
    # price: the tape to the halt, flat through it, then the 21 Oct print
    s.append(path(NXT_PRICE, sx, py, INK, 3.5))
    lp = NXT_PRICE[-1]
    s.append(f'<line x1="{sx(lp[0]):.1f}" x2="{xh1:.1f}" y1="{py(lp[1]):.1f}" y2="{py(lp[1]):.1f}" stroke="{INK}" stroke-width="2" stroke-dasharray="3 6"/>')
    s.append(f'<line x1="{xh1:.1f}" x2="{xh1:.1f}" y1="{py(lp[1]):.1f}" y2="{py(NXT_DROP):.1f}" stroke="{INK}" stroke-width="2" stroke-dasharray="3 6"/>')
    s.append(f'<circle cx="{sx(lp[0]):.1f}" cy="{py(lp[1]):.1f}" r="7" fill="{INK}"/>')
    s.append(text(sx(lp[0])-14, py(lp[1])+34, f"${lp[1]:.2f} · 16 Oct close", 20, INK, weight=700, anchor="end"))
    s.append(f'<circle cx="{xh1:.1f}" cy="{py(NXT_DROP):.1f}" r="9" fill="{INK}"/>')
    s.append(text(xh1-16, py(NXT_DROP)+8, f"${NXT_DROP:.2f} · 21 Oct, 10:08am", 26, INK, weight=700, anchor="end"))
    s.append(text(xh1-16, py(NXT_DROP)-22, "about 40% below the pre-halt close", 18, MUTED, anchor="end"))
    # short position
    s.append(path(NXT_SHORT, sx, sy, AMBER, 6))
    pk = max(NXT_SHORT, key=lambda p:p[1])
    s.append(f'<circle cx="{sx(pk[0]):.1f}" cy="{sy(pk[1]):.1f}" r="7" fill="{AMBER}"/>')
    s.append(text(sx(pk[0])+14, sy(pk[1])-6, f"{pk[1]:.2f}% · 11 Sep, 72.6m shares", 20, AMBER, weight=700))
    last = NXT_SHORT[-1]
    s.append(f'<circle cx="{sx(last[0]):.1f}" cy="{sy(last[1]):.1f}" r="9" fill="{AMBER}"/>')
    s.append(f'<line x1="{sx(last[0]):.1f}" x2="{sx(last[0]):.1f}" y1="{sy(last[1])-12:.1f}" y2="{sy(9.05):.1f}" stroke="{AMBER}" stroke-width="1.5"/>')
    s.append(text(sx(last[0])-10, sy(9.05)-30, f"{last[1]:.2f}% short · 15 Oct", 26, INK, weight=700, anchor="end"))
    s.append(text(sx(last[0])-10, sy(9.05)-6, "63.4m shares; the last report before the halt", 17, MUTED, anchor="end"))
    s.append(text(sx(NXT_SHORT[0][0])+10, sy(NXT_SHORT[0][1])+60, f"{NXT_SHORT[0][1]:.2f}% · 10 Aug", 20, AMBER, weight=700))
    # guidance tile
    s.append(f'<rect x="100" y="{y0-96}" width="560" height="52" fill="{CARD}" stroke="{BORDER}"/>')
    s.append(text(116, y0-61, "FY27 EBITDA guidance  A$385–410m → A$245–265m  (21 Oct)", 18, INK))
    s.append(text(x0, 800, "10 Aug", 18, MUTED)); s.append(text(x1, 800, "21 Oct", 18, MUTED, anchor="end"))
    s.append(source_line(856, MUTED, "; price is the daily close; 21 Oct is the 10:08am price per Capital Brief"))
    s.append("</svg>")
    return "\n".join(s)

COVERS = {
 "aya-shorts-tenfold-since-july-price-halves": (cover_aya, {"AYA": AYA_SHORT}, {"AYA": AYA_PRICE},
   "Finding: the ASX's largest four-week short build. Subject: Artrya's own position line. Action: the single-session step on 18 September and the climb to 10.17%, with the price falling beneath it. Hook: one hard vertical step in an otherwise flat line. Caveat: a position, not a thesis; the price line is the close, not a prediction."),
 "lithium-shorts-build-pls-ltr-cxo-price-slump": (cover_lithium, LITH_SHORT, LITH_PRICE,
   "Finding: lithium shorts rose through the whole quarter while prices fell. Subject: five position lines. Action: all five rising as rebased prices fall. Hook: two panels moving in opposite directions. Caveat: shows reported positions and closes, not a lithium price series."),
 "wtc-record-short-meets-asic-no-action": (cover_wtc, {"WTC": WTC_SHORT}, {"WTC": WTC_PRICE},
   "Finding: the position held at 11% through ASIC's no-action announcement while the price jumped. Subject: short line against price line. Action: the price lifting off from the 14 October marker while the amber line stays flat. Hook: a dated marker with a shaded after-zone. Caveat: positions after 15 October are not yet published."),
 "crowded-exits-dmp-twe-edv-days-to-cover": (cover_consumer, CONS_SHORT, CONS_PRICE,
   "Finding: three consumer shorts with 26 to 35 days to cover as prices rise. Subject: three runways. Action: the runways' length in five-day segments, with the position and price sparklines beside them. Hook: the longest runway belongs to the smallest position. Caveat: days to cover is arithmetic on recent volume, not a forecast of covering."),
 "asx-shorts-broaden-downtrend-rba-october-2026": (cover_market, {"top-ten 16 Jul": TOP_JUL, "top-ten 15 Oct": TOP_OCT}, None,
   "Finding: half the ten most shorted stocks changed in a quarter. Subject: a slope chart of fifteen stocks across two dates. Action: five amber entrants rising into the ten, five leaving. Hook: Lotus's line falls without any covering. Caveat: counts above 10% are ordinary-share lines; the macro figures are the publishers' series as Shorted holds them."),
 "australia-fuel-security-33-days-diesel-hormuz-october-2026": (cover_fuel, {"refined product imports, July": FUEL_IMP, "refinery output, July": FUEL_REF}, None,
   "Finding: Australia makes a fifth of its fuel and holds five weeks of diesel while the strait closes again. Subject: two volume lines crossing in 2015, imports rising, refining falling. Action: three gauges of days held against the 50-day target line. Hook: the diesel gauge is amber and sits a day above its floor. Caveat: days are a national average of stock in tanks and on water, not a forecast; the series is July of each year."),
 "nxt-shorts-8pc-into-40pc-fall-jemena-m3-delay": (cover_nxt, {"NXT": NXT_SHORT}, {"NXT": NXT_PRICE},
   "Finding: the 8.35% position met a 40% fall it had not been built for, and was shrinking. Subject: short line against price line through the convertible hedge spike, the index rebalance and the halt. Action: the amber line steps up on 10 September and bleeds back; the ink line falls to the halt zone and drops out of it. Hook: the dashed drop to $5.51 after two blank sessions. Caveat: the 21 October figure is a reported intraday price, not a close; positions after 15 October are not yet published."),
}

def write_all(png: bool):
    for slug,(fn, shorts, prices, brief) in COVERS.items():
        folder = OUT/slug; folder.mkdir(parents=True, exist_ok=True)
        svg = fn(); (folder/"cover.svg").write_text(svg)
        def ser(x):
            if isinstance(x, list) and x and isinstance(x[0][0], dt.date) and slug.startswith("australia-fuel"):
                return [{"period": a.isoformat(), "megalitres": b, "source": "DCCEEW Australian Petroleum Statistics via Shorted get_economic_series"} for a,b in x]
            if isinstance(x, list) and x and isinstance(x[0][0], dt.date):
                return [{"date": a.isoformat(), "value": b,
                         "sourceUrl": ASIC.format(d=a.strftime("%Y%m%d")),
                         "verifiedAgainstCsv": a.strftime("%Y%m%d") in VERIFIED} for a,b in x]
            if isinstance(x, list): return [{"code": a, "value": b} for a,b in x]
            return x
        meta = {
          "slug": slug, "format": "cover.svg hand-composed from the series below; cover.png is a 1600x900 Chromium rasterisation",
          "brief": brief, "retrievedDate": "2026-10-21",
          "shortSeries": {"basis": "ASIC daily aggregate, % of total product in issue, T+4; values via Shorted's get_stock_history (downsampled), dates marked verifiedAgainstCsv were read from the official CSV", "series": {k: ser(v) for k,v in shorts.items()}},
          "priceSeries": None if prices is None else {"basis": "Daily close, AUD, via Shorted's get_stock_prices (downsampled)", "series": {k: [{"date": a.isoformat(), "close": b} for a,b in v] for k,v in prices.items()}},
          "generator": "scripts/news-covers/october-2026-data-covers.py",
        }
        (folder/"position-series.json").write_text(json.dumps(meta, indent=2))
        print("wrote", folder/"cover.svg")
        if png:
            html = folder/"cover.render.html"
            font = (ROOT/"web/src/fonts/newsreader/Newsreader-Variable.woff2").as_uri()
            html.write_text(f'<!doctype html><html><head><style>@font-face{{font-family:Newsreader;src:url("{font}") format("woff2");font-weight:200 800}} html,body{{margin:0;width:{W}px;height:{H}px;overflow:hidden}}</style></head><body>{svg}</body></html>')
            subprocess.run(["node", str(ROOT/"scripts/news-covers/render.mjs"), str(html), str(folder/"cover.png"), str(W), str(H)], check=True)
            html.unlink()
            print("rasterised", folder/"cover.png")

if __name__ == "__main__":
    write_all("--png" in sys.argv)
