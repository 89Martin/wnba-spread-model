<#
  backtest.ps1  --  Walk-forward validation of the WNBA spread model
  ------------------------------------------------------------------
  Pulls 2024 + 2025 results from ESPN and runs a POINT-IN-TIME (no look-ahead)
  margin power-rating model. For every game it predicts the margin using only
  ratings learned from games already played, then compares to the real result.

  Outputs:
    - MAE / RMSE of (predicted margin - actual margin)   -> sets the model's sigma
    - Straight-up pick accuracy
    - Mean bias and implied home-court advantage
    - A spread-edge -> cover-probability table to ground the edge threshold

  NOTE: ESPN does not retain historical CLOSING SPREADS, so this validates the
  model's predictive accuracy (which sets sigma & HCA and bounds the threshold).
  A full market-beating CLV backtest needs a closing-line CSV; drop one in and
  this script can be extended to read it.

  Run: powershell -ExecutionPolicy Bypass -File backtest.ps1
#>
$ErrorActionPreference='Stop'
function Get-Json($u){ for($i=0;$i -lt 3;$i++){ try{return Invoke-RestMethod -Uri $u -TimeoutSec 60}catch{Start-Sleep -Milliseconds 800} } throw "fetch fail $u" }

function Get-Season($yr){
  $r=Get-Json "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=$($yr)0501-$($yr)1031&limit=1000"
  $g=@()
  foreach($e in $r.events){
    if($e.status.type.state -ne 'post'){continue}
    if($e.season.type -lt 2){continue}
    $c=$e.competitions[0]; $h=$null;$a=$null
    foreach($t in $c.competitors){ if($t.homeAway -eq 'home'){$h=$t}else{$a=$t} }
    if(-not $h -or -not $a){continue}
    $g+=[pscustomobject]@{ date=[datetime]$e.date; season=$yr
      home=$h.team.abbreviation; away=$a.team.abbreviation
      margin=([int]$h.score-[int]$a.score) }   # home - away
  }
  return ($g | Sort-Object date)
}

Write-Host "Pulling seasons..." -ForegroundColor Cyan
$s2024=Get-Season 2024
$s2025=Get-Season 2025
Write-Host ("  2024: {0} games   2025: {1} games" -f $s2024.Count,$s2025.Count)

# ---- walk-forward margin-Elo ----
# pred(home margin) = R[home]-R[away]+HCA ; update R by K*(actual-pred)
function Run-Model([object]$games,[double]$K,[double]$HCA,$carry,[int]$burnin){
  $R=@{}; if($carry){ foreach($e in $carry.GetEnumerator()){ $R[$e.Key]=[double]$e.Value*0.75 } }  # regress carryover to mean
  $preds=@()
  $i=0
  foreach($g in $games){
    if(-not $R.ContainsKey($g.home)){$R[$g.home]=[double]0}
    if(-not $R.ContainsKey($g.away)){$R[$g.away]=[double]0}
    [double]$pred=[double]$R[$g.home]-[double]$R[$g.away]+$HCA
    if($i -ge $burnin){
      $preds+=[pscustomobject]@{pred=$pred;actual=[double]$g.margin}
    }
    [double]$err=[double]$g.margin-$pred
    $R[$g.home]=[double]$R[$g.home]+($K*$err)
    $R[$g.away]=[double]$R[$g.away]-($K*$err)
    $i++
  }
  return [pscustomobject]@{preds=$preds;R=$R}
}

function Stats($preds){
  $n=$preds.Count
  $se=0.0;$ae=0.0;$bias=0.0;$correct=0
  foreach($p in $preds){
    $e=$p.actual-$p.pred; $se+=$e*$e; $ae+=[math]::Abs($e); $bias+=$e
    if([math]::Sign($p.pred) -eq [math]::Sign($p.actual) -and $p.actual -ne 0){$correct++}
  }
  return @{n=$n; rmse=[math]::Sqrt($se/$n); mae=$ae/$n; bias=$bias/$n; su=$correct/$n}
}

Write-Host "`nTuning K (HCA=2.5, burn-in=20 games/season)..." -ForegroundColor Cyan
$best=$null
foreach($K in 0.03,0.04,0.05,0.06,0.08,0.10,0.12){
  $r24=Run-Model $s2024 $K 2.5 $null 20
  $r25=Run-Model $s2025 $K 2.5 $r24.R 20
  $all=@($r24.preds)+@($r25.preds)
  $st=Stats $all
  "{0,5:N2}  ->  RMSE {1,6:N2}   MAE {2,6:N2}   SU {3,5:P1}   bias {4,6:N2}   (n={5})" -f $K,$st.rmse,$st.mae,$st.su,$st.bias,$st.n
  if(-not $best -or $st.rmse -lt $best.rmse){ $best=$st + @{K=$K} }
}

Write-Host "`n=== BEST CONFIG ===" -ForegroundColor Green
"K={0:N2}   RMSE(sigma)={1:N2}   MAE={2:N2}   StraightUp={3:P1}   bias={4:N2}   n={5}" -f `
  $best.K,$best.rmse,$best.mae,$best.su,$best.bias,$best.n

# empirical home-court: average home margin across both seasons
$allg=@($s2024)+@($s2025)
$hca=($allg | Measure-Object margin -Average).Average
"Empirical home-court advantage (avg home margin): {0:N2} pts" -f $hca

# ---- threshold grounding: spread edge -> cover prob (uses sigma) ----
$sigma=$best.rmse
function Phi($z){ $t=1/(1+0.2316419*[math]::Abs($z)); $d=0.3989423*[math]::Exp(-$z*$z/2)
  $p=$d*$t*(0.3193815+$t*(-0.3565638+$t*(1.781478+$t*(-1.821256+$t*1.330274)))); if($z -gt 0){1-$p}else{$p} }
Write-Host "`nSpread-edge -> model cover probability (sigma=$([math]::Round($sigma,1))):" -ForegroundColor Cyan
"  breakeven at -110 = 52.4%"
foreach($edge in 1,1.5,2,2.5,3,4,5){
  $p=1-(Phi(-$edge/$sigma))
  "  {0,4:N1} pts of edge  ->  cover {1,5:P1}   (ROI@-110 {2,6:P1})" -f $edge,$p,(($p*(100/110))-(1-$p))
}

# calibration slope (regress actual on pred)
$mp=($best.n); $sx=0.0;$sy=0.0;$sxx=0.0;$sxy=0.0
$allpreds=@((Run-Model $s2024 $best.K 2.5 $null 20).preds)+@((Run-Model $s2025 $best.K 2.5 (Run-Model $s2024 $best.K 2.5 $null 20).R 20).preds)
foreach($p in $allpreds){ $sx+=$p.pred;$sy+=$p.actual;$sxx+=$p.pred*$p.pred;$sxy+=$p.pred*$p.actual }
$n=$allpreds.Count; $slope=($n*$sxy-$sx*$sy)/($n*$sxx-$sx*$sx)
"`nCalibration slope (actual vs predicted margin): {0:N3}  (1.0 = perfectly calibrated)" -f $slope
Write-Host "`nDone." -ForegroundColor Green
