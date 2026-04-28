# Build a self-contained Python + comic-text-detector + manga-ocr + mokuro + CUDA torch runtime.
#
# Default output (dev mode):   src-tauri/resources/ai-runtime/
# Production install location: %LOCALAPPDATA%/PsDesign/ai-runtime/
# Total size: about 5 GB
# Time:        10-30 minutes depending on network
#
# Dev usage (from project root):
#     pwsh src-tauri/scripts/install-ai-models.ps1
#
# Production usage (called by app, with explicit target):
#     pwsh install-ai-models.ps1 -RuntimeDir "C:\Users\<user>\AppData\Local\PsDesign\ai-runtime"
#
# Re-run is idempotent: existing runtime is reused unless -Force is passed.

param(
    [switch]$Force,
    [string]$RuntimeDir
)

$ErrorActionPreference = "Stop"

# PowerShell <-> Python のstdout を UTF-8 で揃え、
# "Pipe to stdout was broken" / OSError [Errno 22] を防ぐ。
# Tauri が piped stdio で起動した PowerShell から native exe (python.exe) を
# 呼ぶ際の cp932 / UTF-8 mismatch が原因の典型的な問題。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Pip の env: progress bar 抑制 + 進捗 retry 有効化
$env:PIP_PROGRESS_BAR = "off"
$env:PIP_NO_INPUT = "1"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"

$PythonVersion = "3.13.1"

if (-not $RuntimeDir) {
    $RepoRoot   = (Resolve-Path "$PSScriptRoot/../..").Path
    $RuntimeDir = Join-Path $RepoRoot "src-tauri/resources/ai-runtime"
}

$PythonExe = Join-Path $RuntimeDir "python.exe"

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

Write-Step "Target runtime directory: $RuntimeDir"

if ($Force -and (Test-Path $RuntimeDir)) {
    Write-Step "Force: removing existing runtime"
    Remove-Item -Recurse -Force $RuntimeDir
}

# ---------------------------------------------------------------------------
# Phase 1. Python embeddable
# ---------------------------------------------------------------------------
if (-not (Test-Path $PythonExe)) {
    Write-Step "Phase 1. Downloading Python $PythonVersion embeddable"
    $zipPath = Join-Path $env:TEMP "python-embed-$PythonVersion.zip"
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zipPath

    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $RuntimeDir -Force
    Remove-Item $zipPath

    # Enable site-packages so pip-installed modules are found.
    $pthFiles = Get-ChildItem -Path $RuntimeDir -Filter "python*._pth"
    foreach ($pth in $pthFiles) {
        $content = Get-Content $pth.FullName
        $content = $content -replace "^#import site", "import site"
        Set-Content -Path $pth.FullName -Value $content -Encoding ASCII
    }
} else {
    Write-Step "Phase 1. Python already present, skipping"
}

# ---------------------------------------------------------------------------
# Phase 2. pip
# ---------------------------------------------------------------------------
$pipScript = Join-Path $RuntimeDir "Scripts/pip.exe"
if (-not (Test-Path $pipScript)) {
    Write-Step "Phase 2. Installing pip"
    $getPip = Join-Path $env:TEMP "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    & $PythonExe $getPip
    Remove-Item $getPip
} else {
    Write-Step "Phase 2. pip already present, skipping"
}

# pip 起動の共通オプション。
# -u: Python unbuffered stdout (PowerShell <-> Tauri pipe stall を防ぐ)
# -q: quiet (大量出力で pipe バッファが詰まる事故を回避)
$PipBaseArgs = @("-u", "-m", "pip", "install", "-q", "--no-warn-script-location")

function Invoke-Pip {
    param([Parameter(Mandatory)][string]$PhaseLabel, [Parameter(Mandatory)][string[]]$Args)
    & $PythonExe @Args
    if ($LASTEXITCODE -ne 0) {
        throw "${PhaseLabel}: pip が失敗しました (exit $LASTEXITCODE)"
    }
}

# ---------------------------------------------------------------------------
# Phase 3. Build prerequisites (needed for sdist deps like yattag)
# ---------------------------------------------------------------------------
Write-Step "Phase 3. Build prerequisites"
Invoke-Pip -PhaseLabel "Phase 3" -Args (@("-u", "-m", "pip", "install", "-q", "--no-warn-script-location", "--upgrade", "pip", "setuptools", "wheel"))

# ---------------------------------------------------------------------------
# Phase 4a. comic-text-detector (吹き出し領域検出 AI モデル)
# ---------------------------------------------------------------------------
# 注: comic-text-detector は単体パッケージとしては PyPI に存在しないため、
# mokuro の依存を経由してインストールされる。ここでは進捗ログ用のフェーズ
# 区切りとして mokuro 本体に含まれるテキスト検出ライブラリ群を先行インストールする。
# pip のキャッシュがあるので mokuro 本体インストール時に再ダウンロードは発生しない。
Write-Step "Phase 4a. Installing comic-text-detector (吹き出し検出モデル)"
Invoke-Pip -PhaseLabel "Phase 4a" -Args ($PipBaseArgs + @(
    "shapely", "scipy", "scikit-image", "opencv-python-headless", "pyclipper",
    "transformers", "natsort", "numpy", "Pillow"
))

# ---------------------------------------------------------------------------
# Phase 4b. manga-ocr (日本語 OCR モデル)
# ---------------------------------------------------------------------------
Write-Step "Phase 4b. Installing manga-ocr (日本語OCRモデル)"
Invoke-Pip -PhaseLabel "Phase 4b" -Args ($PipBaseArgs + @("manga-ocr"))

# ---------------------------------------------------------------------------
# Phase 4c. mokuro (上記 2 モデルを束ねるオーケストレータ)
# ---------------------------------------------------------------------------
Write-Step "Phase 4c. Installing mokuro (オーケストレータ)"
Invoke-Pip -PhaseLabel "Phase 4c" -Args ($PipBaseArgs + @("mokuro"))

# ---------------------------------------------------------------------------
# Phase 5. Replace torch with CUDA 12.8 build
# ---------------------------------------------------------------------------
Write-Step "Phase 5. Switching torch to CUDA 12.8 build"
& $PythonExe -u -m pip uninstall -y -q torch torchvision
# uninstall の exit code は torch 未インストール時に 0 になるので throw しない
Invoke-Pip -PhaseLabel "Phase 5" -Args ($PipBaseArgs + @(
    "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu128"
))

# ---------------------------------------------------------------------------
# Phase 6. Verify
# ---------------------------------------------------------------------------
Write-Step "Phase 6. Verifying runtime"
& $PythonExe -u -c "import torch, mokuro, manga_ocr; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
$mokuroExe = Join-Path $RuntimeDir "Scripts/mokuro.exe"
if (-not (Test-Path $mokuroExe)) {
    throw "mokuro.exe not found at $mokuroExe"
}

# ---------------------------------------------------------------------------
# 7. Report size
# ---------------------------------------------------------------------------
$size = (Get-ChildItem $RuntimeDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host "Runtime ready at: $RuntimeDir" -ForegroundColor Green
Write-Host ("Size: {0:N2} GB" -f ($size / 1GB)) -ForegroundColor Green
