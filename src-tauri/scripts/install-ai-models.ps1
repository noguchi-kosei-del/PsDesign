# Build a self-contained Python + 画像スキャンエンジン + CUDA torch runtime.
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
    [string]$RuntimeDir,
    [string]$SharedOcrRoot = "G:\共有ドライブ\ソニーからのデータ受領\編集企画_AT業務推進\DTP制作部\OCR"
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
Write-Step "Shared OCR source: $SharedOcrRoot"

function Copy-DirectoryFromShared {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    if (-not (Test-Path $Source)) {
        return $false
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    robocopy $Source $Destination /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -gt 7) {
        throw "共有OCRフォルダからのコピーに失敗しました (robocopy exit $code): $Source -> $Destination"
    }
    return $true
}

function Copy-FileFromShared {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    if (-not (Test-Path $Source)) {
        return $false
    }
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -Path $Source -Destination $Destination -Force
    return $true
}

function Restore-SharedOcrPackages {
    if (-not (Test-Path $SharedOcrRoot)) {
        Write-Host "Shared OCR source not found; package install will use pip sources." -ForegroundColor Yellow
        return
    }

    Write-Step "Restoring OCR packages from shared OCR source"
    $sitePackages = Join-Path $RuntimeDir "Lib/site-packages"
    Copy-DirectoryFromShared `
        -Source (Join-Path $SharedOcrRoot "manga_ocr/package/manga_ocr") `
        -Destination (Join-Path $sitePackages "manga_ocr") | Out-Null
    Copy-DirectoryFromShared `
        -Source (Join-Path $SharedOcrRoot "manga_ocr/package/manga_ocr-0.1.14.dist-info") `
        -Destination (Join-Path $sitePackages "manga_ocr-0.1.14.dist-info") | Out-Null
    Copy-FileFromShared `
        -Source (Join-Path $SharedOcrRoot "manga_ocr/Scripts/manga_ocr.exe") `
        -Destination (Join-Path $RuntimeDir "Scripts/manga_ocr.exe") | Out-Null
    Copy-DirectoryFromShared `
        -Source (Join-Path $SharedOcrRoot "comic_text_detector/package/comic_text_detector") `
        -Destination (Join-Path $sitePackages "comic_text_detector") | Out-Null
}

function Restore-SharedOcrModelCache {
    if (-not (Test-Path $SharedOcrRoot)) {
        Write-Host "Shared OCR source not found; model cache will use online download if needed." -ForegroundColor Yellow
        return $false
    }

    Write-Step "Restoring OCR model cache from shared OCR source"
    $restored = $false
    $userHomeDir = $env:USERPROFILE
    if (-not $userHomeDir) {
        $userHomeDir = [Environment]::GetFolderPath("UserProfile")
    }
    $hfModelSource = Join-Path $SharedOcrRoot "manga_ocr/models/models--kha-white--manga-ocr-base"
    $hfModelDest = Join-Path $userHomeDir ".cache/huggingface/hub/models--kha-white--manga-ocr-base"
    if (Copy-DirectoryFromShared -Source $hfModelSource -Destination $hfModelDest) {
        $restored = $true
    }

    $detectorSource = Join-Path $SharedOcrRoot "comic_text_detector/models/comictextdetector.pt"
    $detectorDest = Join-Path $userHomeDir ".cache/manga-ocr/comictextdetector.pt"
    if (Copy-FileFromShared -Source $detectorSource -Destination $detectorDest) {
        $restored = $true
    }

    return $restored
}

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
# Phase 4a. 画像スキャンエンジン (吹き出し検出)
# ---------------------------------------------------------------------------
# 注: 吹き出し検出モデル本体は単体パッケージとして PyPI に存在しないため、
# オーケストレータの依存を経由してインストールされる。ここでは進捗ログ用のフェーズ
# 区切りとして検出に必要なライブラリ群を先行インストールする。
# pip のキャッシュがあるので本体インストール時に再ダウンロードは発生しない。
Write-Step "Phase 4a. 画像スキャンエンジン (吹き出し検出) をインストール中"
Invoke-Pip -PhaseLabel "Phase 4a" -Args ($PipBaseArgs + @(
    "shapely", "scipy", "scikit-image", "opencv-python-headless", "pyclipper",
    "transformers", "natsort", "numpy", "Pillow"
))

# ---------------------------------------------------------------------------
# Phase 4b. 画像スキャンエンジン (テキスト抽出)
# ---------------------------------------------------------------------------
Write-Step "Phase 4b. 画像スキャンエンジン (テキスト抽出) をインストール中"
Invoke-Pip -PhaseLabel "Phase 4b" -Args ($PipBaseArgs + @("manga-ocr"))

# ---------------------------------------------------------------------------
# Phase 4c. オーケストレータ
# ---------------------------------------------------------------------------
Write-Step "Phase 4c. オーケストレータをインストール中"
Invoke-Pip -PhaseLabel "Phase 4c" -Args ($PipBaseArgs + @("mokuro"))

# 共有ドライブに保管した OCR エンジンを優先して復元する。
# pip は依存ライブラリの解決に使い、manga-ocr / comic-text-detector 本体と
# モデルキャッシュは社内共有フォルダの内容を正とする。
Restore-SharedOcrPackages

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
# pkg_resources is deprecated 警告を抑制 (画像スキャンエンジンの依存が古い API を使っている)
$env:PYTHONWARNINGS = "ignore::UserWarning"
& $PythonExe -u -c "import torch, mokuro, manga_ocr; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
Remove-Item Env:PYTHONWARNINGS -ErrorAction SilentlyContinue
$mokuroExe = Join-Path $RuntimeDir "Scripts/mokuro.exe"
if (-not (Test-Path $mokuroExe)) {
    throw "mokuro.exe not found at $mokuroExe"
}

# ---------------------------------------------------------------------------
# Phase 6b. 画像スキャンエンジンの重みファイルを事前ダウンロード
# ---------------------------------------------------------------------------
# 画像スキャンエンジンの重みファイルは共有ドライブを優先ソースにする。
# 共有ドライブが使えない / キャッシュが不足している場合のみ、従来どおり
# from_pretrained() がオンライン取得を試みる。
Write-Step "Phase 6b. 画像スキャンエンジンの重みファイルを準備中"
$restoredOcrCache = Restore-SharedOcrModelCache
$env:PYTHONWARNINGS = "ignore::UserWarning"
if ($restoredOcrCache) {
    $env:HF_HUB_OFFLINE = "1"
    $env:TRANSFORMERS_OFFLINE = "1"
}
& $PythonExe -u -c "from manga_ocr import MangaOcr; MangaOcr()"
Remove-Item Env:PYTHONWARNINGS -ErrorAction SilentlyContinue
Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
Remove-Item Env:TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
    throw "Phase 6b: AIモデルの準備に失敗しました (exit $LASTEXITCODE). 共有OCRフォルダまたはネット接続を確認して再実行してください。"
}

# ---------------------------------------------------------------------------
# 7. Report size
# ---------------------------------------------------------------------------
$size = (Get-ChildItem $RuntimeDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host "Runtime ready at: $RuntimeDir" -ForegroundColor Green
Write-Host ("Size: {0:N2} GB" -f ($size / 1GB)) -ForegroundColor Green
