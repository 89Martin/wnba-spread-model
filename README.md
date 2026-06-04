# WNBA Matchup Bet Card — Point Spread Model

A clean, bookmarkable web app that projects WNBA point spreads from fundamental
team factors, turns the model's implied probability into **fair odds**, and — the
key part — **validates the model's edge against a sharp book**. You enter your
best-available line/price and the sharp book's line/price for both sides; the app
shows your **Model edge** next to the **Sharp edge** (the sharp's de-vigged "true"
probability vs your price), so a model that claims +10% gets confirmed, corrected
down to +4%, or rejected as no edge. It then sizes the bet with **fractional
Kelly** (+ flat units) on a model/sharp blend you control.

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
- **You enter** (both sides): your **best-available** spread + price, and the
  **sharp** book's spread + price. Stored locally per date + game.
- **Outputs per card:**
  - **Model edge** — your model's prob at your price (the optimistic number)
  - **Sharp edge** — the sharp book's *de-vigged* true prob at your price (the honest number / market edge)
  - **Mkt pts** — how many points your offer beats the sharp number
  - model line, sharp line, model/sharp fair odds, bet win %, **EV%**, and a
    **Kelly stake in $ + units** with a **BET / LEAN / PASS** verdict (flagged
    `⚠ model hot vs sharp` when the model runs well ahead of the sharp).

### The math
- Projected home margin `M = power_home − power_away + HCA − injHome + injAway + (restHome − restAway)`
- **Sharp true line:** de-vig the two sharp prices → no-vig prob `nvH`; implied true
  home margin `μ_sharp = −sharpHome + σ·Φ⁻¹(nvH)` (so the price juice, not just the
  number, shifts the line)
- Cover probability at *your* offer line uses a normal model with **σ = 12.6** (backtest)
- **Model edge** = model cover prob − your price's breakeven; **Sharp edge** = sharp cover prob − breakeven
- **Staking prob** = `trust·model + (1−trust)·sharp`, where **trust** is the *Model trust*
  slider (0% = size purely on the sharp, 100% = size on your model; default **25%**)
- **Kelly:** `f = (b·p − (1−p)) / b` × the selected fraction (1/8, **1/4**, 1/2, Full),
  `p` = staking prob, `b` = decimal payout − 1

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
"if-the-model-is-right" value — which is exactly why the app validates against the
sharp book and sizes on the **Sharp edge** (keep **Model trust low, ~25%**). The
**BET** verdict fires on the *staking* edge, so a sharp-confirmed edge ≥ your
threshold is what counts. **Recommended default edge threshold: 3%.** Tune the
**Edge min (%)** box to taste.

---

## Daily use

1. Open your bookmarked URL. Pick the date.
2. For each game, type your **best-available** spread + price for both sides
   (the ESPN line is pre-filled as a starting point) and the **sharp** book's
   spread + price for both sides (e.g. Pinnacle/Circa). Both-side sharp prices
   let the app de-vig to the sharp's true line.
3. Set injury points and confirm the auto rest state.
4. Read the verdict. **BET** = sharp-validated edge ≥ your threshold with positive
   EV. Compare **Model edge** vs **Sharp edge** — when the model runs hot, trust
   the sharp.

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
