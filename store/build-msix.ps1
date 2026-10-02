# Baut das Microsoft-Store-Paket (MSIX) aus einer mit `--features store` gebauten Exe.
# Das Paket bleibt unsigniert – der Store signiert es beim Einreichen selbst. Zum lokalen Testen siehe store/README.md.
#
# Aufruf:
#   cargo build --release --features store --target-dir target-store
#   powershell -File store/build-msix.ps1 -Exe target-store/release/glass-browser.exe -Build 1
# Identität und Herausgeber kommen aus dem Partner Center (App → Produktidentität). Ohne Angabe gibt es Testwerte,
# mit denen sich das Paket lokal installieren, aber nicht einreichen lässt.
param(
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [ValidateRange(1, 65535)] [int] $Build,
    [string] $IdentityName = $env:STORE_IDENTITY_NAME,
    [string] $Publisher = $env:STORE_PUBLISHER,
    [string] $PublisherName = $env:STORE_PUBLISHER_NAME,
    [string] $Out = "WinterBrowser_$Build.msix"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $IdentityName) { $IdentityName = 'WinterBrowser.Dev' }
if (-not $Publisher) { $Publisher = 'CN=WinterBrowserDev' }
if (-not $PublisherName) { $PublisherName = 'Winter Browser (Test)' }
# Die Store-Version muss mit jeder Einreichung steigen; die letzte Stelle muss 0 sein.
$version = "1.0.$Build.0"

# makeappx und makepri aus dem neuesten installierten Windows SDK
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\makeappx.exe" |
    Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $sdk) { throw 'Windows SDK (makeappx.exe) nicht gefunden' }
$makeappx = $sdk.FullName
$makepri = Join-Path $sdk.DirectoryName 'makepri.exe'

# Ausgabe nur bei Fehlern zeigen
function Invoke-Tool($tool) {
    $log = & $tool @args 2>&1
    if ($LASTEXITCODE) { $log | Write-Host; throw "$(Split-Path $tool -Leaf) $($args[0]) fehlgeschlagen ($LASTEXITCODE)" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) "winter-msix-$Build-$PID"
$stage = Join-Path $work 'package'
New-Item -ItemType Directory -Force (Join-Path $stage 'Assets') | Out-Null
try {
    Copy-Item $Exe (Join-Path $stage 'Browser.exe')
    Copy-Item (Join-Path $root 'LICENSE') $stage
    $licenses = Join-Path $root 'THIRD_PARTY_LICENSES.html'
    if (Test-Path $licenses) { Copy-Item $licenses $stage }
    Copy-Item (Join-Path $PSScriptRoot 'Assets\*.png') (Join-Path $stage 'Assets') -Exclude 'StoreListing*'

    $escape = { param($s) [Security.SecurityElement]::Escape($s) }
    $manifest = (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'AppxManifest.xml')).
        Replace('__IDENTITY_NAME__', (& $escape $IdentityName)).
        Replace('__PUBLISHER_NAME__', (& $escape $PublisherName)).
        Replace('__PUBLISHER__', (& $escape $Publisher)).
        Replace('__VERSION__', $version)
    [IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

    # resources.pri: wählt aus den scale-/targetsize-Varianten der Logos die passende
    $config = Join-Path $work 'priconfig.xml'
    Invoke-Tool $makepri createconfig /cf $config /dq de-DE_en-US /pv 10.0.0 /o
    Invoke-Tool $makepri new /pr $stage /cf $config /mn (Join-Path $stage 'AppxManifest.xml') /of (Join-Path $stage 'resources.pri') /o

    Invoke-Tool $makeappx pack /d $stage /p $Out /o
    Write-Host "MSIX erstellt: $Out (Version $version, $IdentityName)"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
