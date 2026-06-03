# WNBA Matchup Bet Card — Point Spread Model

A clean, bookmarkable web app that projects WNBA point spreads from fundamental
team factors, turns the model's implied probability into **fair odds**, compares
those to the lines you enter, blends in a **sharp line** to temper overconfidence,
and recommends a stake using **fractional Kelly** (+ flat units) off a set bankroll.

Live URL (after deploy): `https://89Martin.github.io/wnba-spread-model/?d=YYYY-MM-DD`

---

## What it does

- **Date selector** (bookmarkable via `?d=` in the URL) pulls that day's slate live
  from ESPN — matchups, team **logos**, and **team colors** for each bet card.
- **The model** rates every team from real box-score data:
  - **Four Factors (offense):** eFG%, TOV%, OREB%, FT-rate
  - **Efficiency:** Off/Def Rating per 100 possessions, **Pace**
  - **Opponent-adjusted power rating (SRS)** from full-season results,
    blended with last season as an early-season anchor.
- **Modifiers** per card: **Injury ±** points per team, and **Rest** (auto-detected
  Rested / Normal / 3-in-4 / Back-to-back from the schedule, editable).
- **You enter** the book spread + price and (optionally) a **sharp** spread.
  Everything is stored locally in your browser, per date + game.
- **Outputs per card:** model line, blended line, model fair odds, win %,
  edge vs the de-vigged market, points of spread value, **EV%**, and a
  **Kelly stake in $ and units** with a **BET / LEAN / PASS** verdict.

### The math
- Projected home margin `M = power_home − power_away + HCA − injHome + injAway + (restHome − restAway)`
- Sharp blend (tempers the model): `proj = (1−w)·M + w·(−sharpSpread)`, `w` = the **Sharp weight** slider
- Cover probability at the book line uses a normal model with **σ = 12.6** (from the backtest)
- Fair American odds are derived from that probability; **edge = model prob − no-vig market prob**
- **Kelly:** `f = (b·p − (1−p)) / b` × the selected fraction (1/8, **1/4**, 1/2, Full), `b` = decimal payout − 1

---

## Backtest (2024 + 2025, 536 games, point-in-time / no look-ahead)

The model predicts each game using only ratings learned from prior games, then
compares to the real result. (ESPN does not retain historical *closing spreads*,
so this validates predictive accuracy — which sets σ, home-court, and the edge
threshold. To run a full market-beating CLV backtest, drop a closing-line CSV in
and extend `backtest.ps1`.)

| Metric | Result |
|---|---|
| RMSE of model line vs actual margin (**σ**) | **12.6** |
| Mean absolute error | 10.0 |
| Straight-up winner accuracy | **65.7%** |
| Bias | −0.48 (≈ unbiased) |
| Calibration slope | 0.95 (≈ perfectly calibrated) |
| Empirical home-court advantage | **2.0 pts** |

**Edge → cover probability** (σ = 12.6), used to set the threshold:

| Spread edge | Model cover % | ROI @ −110 |
|---|---|---|
| 1.5 pts | 54.7% | +4.5% |
| 2.0 pts | 56.3% | +7.5% |
| **2.5 pts** | **57.9%** | **+10.4%** |
| 3.0 pts | 59.4% | +13.4% |

Breakeven at −110 is 52.4%. Because the market (sharp/closing line) is itself a
very strong predictor, a raw model-vs-market disagreement realizes only ~half its
"if-the-model-is-right" value — so keep the **Sharp weight ~50%** and require a
real cushion. **Recommended default edge threshold: 3%** probability edge over the
no-vig market (≈ 2.5 pts of *blended* spread value). This is the app's default;
tune the **Edge min (%)** box to taste.

---

## Daily use

1. Open your bookmarked URL. Pick the date.
2. For each game, type the book spread + price (the ESPN line is pre-filled as a
   starting point) and, ideally, a **sharp** spread (e.g. Pinnacle/Circa).
3. Set injury points and confirm the auto rest state.
4. Read the verdict. **BET** = edge ≥ your threshold with positive EV.

Global settings (bankroll, Kelly fraction, unit %, sharp weight, edge min) persist
across sessions.

---

## Refreshing the ratings

Team ratings come from `data/ratings.json`. They drift slowly, so refresh every
few days (or after big roster/injury news), then redeploy:

```powershell
powershell -ExecutionPolicy Bypass -File refresh.ps1          # current season
powershell -ExecutionPolicy Bypass -File refresh.ps1 -Season 2026
git add data/ratings.json && git commit -m "refresh ratings" && git push
```

Re-run the validation any time:

```powershell
powershell -ExecutionPolicy Bypass -File backtest.ps1
```

Both scripts use only the public ESPN API (no key required). Requires PowerShell
(built into Windows).

---

## Deploy / redeploy (GitHub Pages)

```powershell
git add -A
git commit -m "update"
git push
```
GitHub Pages serves from the `main` branch root. First-time setup is done via
`gh` (see commit history) or **repo → Settings → Pages → Branch: main / root**.

## Run locally

```powershell
python -m http.server 4178
# then open http://localhost:4178
```
(Serving over HTTP is needed so the page can `fetch` `data/ratings.json`.)

---

*Decision-support tool, not betting advice. Lines you enter never leave your
browser. Bet responsibly.*
