$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Error "npm.cmd was not found. Please install Node.js and try again."
}

$devUrl = "http://localhost:1430"

function Test-OpusDevServer {
  try {
    $response = Invoke-WebRequest -Uri $devUrl -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500 -and $response.Content -match "<title>OPUS</title>")
  } catch {
    return $false
  }
}

$startedVite = $false
$viteJob = $null

if (-not (Test-OpusDevServer)) {
  $viteJob = Start-Job -ScriptBlock {
    param($root, $npmPath)
    Set-Location -LiteralPath $root
    & $npmPath run dev
  } -ArgumentList $PSScriptRoot, $npm.Source
  $startedVite = $true

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-OpusDevServer) {
      $ready = $true
      break
    }
    if ($viteJob.State -ne "Running") {
      Receive-Job $viteJob
      throw "Vite dev server stopped before OPUS became available on $devUrl."
    }
  }

  if (-not $ready) {
    Receive-Job $viteJob -ErrorAction SilentlyContinue
    throw "Vite dev server did not start on $devUrl."
  }
}

try {
  & $npm.Source run tauri dev -- --no-dev-server
} finally {
  if ($startedVite -and $viteJob) {
    Stop-Job $viteJob -ErrorAction SilentlyContinue
    Remove-Job $viteJob -Force -ErrorAction SilentlyContinue
  }
}
