<#
  refresh.ps1  --  WNBA Spread Model data refresh
  -------------------------------------------------
  Pulls everything from ESPN's public API (the only source that allows
  programmatic access) and writes data/ratings.json, which the web app reads.

  For each team it computes, from real box-score totals:
    - Four Factors (offense): eFG%, TOV%, OREB%, FT-rate
    - Efficiency: ORtg, DRtg, Net (per 100 possessions)
    - Pace (estimated possessions / game)
  And from full-season game results it computes:
    - SRS power rating (opponent-adjusted points/game vs an average team)
  Current season is blended with last season's rating for early-season stability.

  Run:  powershell -ExecutionPolicy Bypass -File refresh.ps1
        powershell -ExecutionPolicy Bypass -File refresh.ps1 -Season 2026
#>
param(
  [int]$Season = 2026,        # current season
  [int]$PriorSeason = 2025,   # prior season used as a regression anchor
  [double]$PriorRegress = 0.75, # shrink prior-season SRS toward 0 (mean) by this factor
  [int]$BlendK = 8            # games of prior-weight: w_current = GP / (GP + K)
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

function Get-Json($url) {
  for ($i=0; $i -lt 3; $i++) {
    try { return Invoke-RestMethod -Uri $url -TimeoutSec 60 }
    catch { Start-Sleep -Milliseconds 800 }
  }
  throw "Failed to fetch $url"
}

Write-Host "Fetching team list..." -ForegroundColor Cyan
$teamsRaw = Get-Json "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams"
$teams = @{}
foreach ($t in $teamsRaw.sports[0].leagues[0].teams.team) {
  $logo = $null
  if ($t.logos) { $logo = $t.logos[0].href }
  $teams[$t.abbreviation] = [ordered]@{
    id        = [int]$t.id
    abbr      = $t.abbreviation
    name      = $t.displayName
    short     = $t.shortDisplayName
    color     = "#" + $t.color
    alt       = "#" + $t.alternateColor
    logo      = $logo
  }
}
Write-Host ("  {0} teams" -f $teams.Count)

# ---- Per-team box stats / Four Factors for a season ----
function Get-TeamFactors($teamId, $season) {
  $url = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/seasons/$season/types/2/teams/$teamId/statistics"
  try { $r = Get-Json $url } catch { return $null }
  $o=@{}; $d=@{}; $g=@{}
  foreach ($cat in $r.splits.categories) {
    foreach ($s in $cat.stats) {
      switch ($cat.name) {
        'offensive' { $o[$s.name] = [double]$s.value }
        'defensive' { $d[$s.name] = [double]$s.value }
        'general'   { $g[$s.name] = [double]$s.value }
      }
    }
  }
  $gp = [double]$g['gamesPlayed']
  if ($gp -le 0) { return $null }
  $fga = $o['fieldGoalsAttempted']; $fgm = $o['fieldGoalsMade']; $tpm = $o['threePointFieldGoalsMade']
  $fta = $o['freeThrowsAttempted'];  $oreb = $o['offensiveRebounds']
  $tov = $o['turnovers']; $pts = $o['points']; $poss = $o['estimatedPossessions']
  $pa  = $o['avgPointsAllowed'] * $gp
  if (-not $poss -or $poss -le 0) { $poss = $fga + 0.44*$fta - $oreb + $tov }

  $efg  = if ($fga -gt 0) { ($fgm + 0.5*$tpm) / $fga } else { 0 }
  $tovp = if ($poss -gt 0) { $tov / $poss } else { 0 }
  $ftr  = if ($fga -gt 0) { $fta / $fga } else { 0 }
  $orebp = if ($o.ContainsKey('offensiveReboundPct')) { $o['offensiveReboundPct'] } else { 0 }
  $ortg = if ($poss -gt 0) { 100 * $pts / $poss } else { 0 }
  $drtg = if ($poss -gt 0) { 100 * $pa  / $poss } else { 0 }   # opp poss ~= own poss (shared per game)

  return [ordered]@{
    gp     = [int]$gp
    pace   = [math]::Round($poss / $gp, 1)
    ppg    = [math]::Round($pts / $gp, 1)
    papg   = [math]::Round($pa / $gp, 1)
    efg    = [math]::Round($efg, 4)
    tovPct = [math]::Round($tovp, 4)
    orebPct= [math]::Round($orebp, 4)
    ftRate = [math]::Round($ftr, 4)
    ortg   = [math]::Round($ortg, 1)
    drtg   = [math]::Round($drtg, 1)
    netRtg = [math]::Round($ortg - $drtg, 1)
  }
}

# ---- SRS (opponent-adjusted margin) from full-season results ----
function Get-SRS($season) {
  $url = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=$($season)0501-$($season)1031&limit=1000"
  $r = Get-Json $url
  $games = @()
  foreach ($e in $r.events) {
    if ($e.status.type.state -ne 'post') { continue }
    if ($e.season.type -lt 2) { continue }   # skip preseason
    $c = $e.competitions[0]
    $h=$null;$a=$null
    foreach ($t in $c.competitors) {
      if ($t.homeAway -eq 'home') { $h=$t } else { $a=$t }
    }
    if (-not $h -or -not $a) { continue }
    $games += [pscustomobject]@{
      home=$h.team.abbreviation; away=$a.team.abbreviation
      hs=[int]$h.score; as=[int]$a.score
    }
  }
  # iterative SRS:  rating_i = mean_margin_i + mean_opp_rating_i
  $abbrs = ($games | ForEach-Object { $_.home; $_.away } | Sort-Object -Unique)
  $marginSum=@{}; $oppList=@{}; $gp=@{}
  foreach ($ab in $abbrs){ $marginSum[$ab]=0.0; $oppList[$ab]=@(); $gp[$ab]=0 }
  foreach ($g in $games) {
    $m = $g.hs - $g.as
    $marginSum[$g.home]+=$m; $gp[$g.home]++; $oppList[$g.home]+=$g.away
    $marginSum[$g.away]+=(-$m); $gp[$g.away]++; $oppList[$g.away]+=$g.home
  }
  $rating=@{}; foreach ($ab in $abbrs){ $rating[$ab] = if($gp[$ab]){$marginSum[$ab]/$gp[$ab]}else{0} }
  for ($it=0; $it -lt 50; $it++) {
    $new=@{}
    foreach ($ab in $abbrs) {
      $avgMargin = if($gp[$ab]){$marginSum[$ab]/$gp[$ab]}else{0}
      $oppAvg=0.0; foreach($op in $oppList[$ab]){ $oppAvg += $rating[$op] }
      if ($oppList[$ab].Count){ $oppAvg /= $oppList[$ab].Count }
      $new[$ab] = $avgMargin + $oppAvg
    }
    # re-center to mean 0
    $mean = ($new.Values | Measure-Object -Average).Average
    foreach ($ab in $abbrs){ $new[$ab] -= $mean }
    $rating = $new
  }
  $out=@{}; foreach($ab in $abbrs){ $out[$ab] = [math]::Round($rating[$ab],2) }
  return @{ srs=$out; gp=$gp; nGames=$games.Count }
}

Write-Host "Computing SRS power ratings..." -ForegroundColor Cyan
$srsCur = Get-SRS $Season
$srsPri = Get-SRS $PriorSeason
Write-Host ("  {0}: {1} games | {2}: {3} games" -f $Season,$srsCur.nGames,$PriorSeason,$srsPri.nGames)

Write-Host "Fetching team Four Factors / efficiency..." -ForegroundColor Cyan
$out = [ordered]@{}
foreach ($abbr in ($teams.Keys | Sort-Object)) {
  $tm = $teams[$abbr]
  $f = Get-TeamFactors $tm.id $Season
  $srs2026 = if ($srsCur.srs.ContainsKey($abbr)) { $srsCur.srs[$abbr] } else { 0 }
  $gpCur = if ($f) { $f.gp } else { 0 }
  $prior = if ($srsPri.srs.ContainsKey($abbr)) { [math]::Round($srsPri.srs[$abbr]*$PriorRegress,2) } else { 0 }
  $w = if (($gpCur + $BlendK) -gt 0) { [double]$gpCur / ($gpCur + $BlendK) } else { 0 }
  $power = [math]::Round($w*$srs2026 + (1-$w)*$prior, 2)

  $rec = [ordered]@{
    abbr=$tm.abbr; name=$tm.name; short=$tm.short
    color=$tm.color; alt=$tm.alt; logo=$tm.logo
    power=$power; srs=$srs2026; priorSrs=$prior; blendW=[math]::Round($w,2)
  }
  if ($f) { foreach ($k in $f.Keys){ $rec[$k]=$f[$k] } }
  $out[$abbr]=$rec
  Write-Host ("  {0,-4} power={1,6}  srs={2,6}  net/100={3,6}  pace={4}" -f $abbr,$power,$srs2026,$(if($f){$f.netRtg}else{'NA'}),$(if($f){$f.pace}else{'NA'}))
}

# league average pace for context
$paces = $out.Values | Where-Object { $_.pace } | ForEach-Object { $_.pace }
$lgPace = if ($paces) { [math]::Round(($paces | Measure-Object -Average).Average,1) } else { 0 }

$payload = [ordered]@{
  asOf       = (Get-Date).ToString("yyyy-MM-dd")
  season     = $Season
  priorSeason= $PriorSeason
  leaguePace = $lgPace
  homeCourt  = 2.0    # WNBA home-court advantage in points (empirical 2024-25 backtest)
  marginSD   = 12.6   # RMSE of model line vs actual margin (2024-25 backtest); used for fair-odds
  teams      = $out
}
$jsonPath = Join-Path $dataDir 'ratings.json'
$payload | ConvertTo-Json -Depth 8 | Out-File -FilePath $jsonPath -Encoding utf8
Write-Host ("`nWrote {0}  (asOf {1}, leaguePace {2})" -f $jsonPath,$payload.asOf,$lgPace) -ForegroundColor Green
