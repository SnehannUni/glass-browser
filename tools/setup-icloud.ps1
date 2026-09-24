param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\GlassBrowser')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $InstallDir 'icloud'
$extension = Join-Path $repo 'target\icloud-research\extension\background.js'
if (-not (Test-Path -LiteralPath $extension)) {
    $downloadDir = Join-Path $repo 'target\icloud-research'
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $crx = Join-Path $downloadDir 'extension.crx'
    Invoke-WebRequest 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=153.0.0.0&acceptformat=crx3&x=id%3Dpejdijmoenmkgeppbflobdenhhabjlaj%26uc' -OutFile $crx
    $bytes = [IO.File]::ReadAllBytes($crx)
    if ([Text.Encoding]::ASCII.GetString($bytes,0,4) -ne 'Cr24' -or [BitConverter]::ToUInt32($bytes,4) -ne 3) { throw 'Ungültiges Apple-Erweiterungspaket.' }
    $offset = 12 + [BitConverter]::ToUInt32($bytes,8)
    if ($offset -ge $bytes.Length) { throw 'Ungültiger CRX-Header.' }
    $zip = Join-Path $downloadDir 'extension.zip'
    [IO.File]::WriteAllBytes($zip, $bytes[$offset..($bytes.Length-1)])
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $downloadDir 'extension') -Force
}
$source = [IO.File]::ReadAllText($extension)
$end = $source.IndexOf('const ContextState=')
if ($end -lt 0 -or -not $source.Contains('SecretSession.prototype=')) { throw 'Nicht unterstützte Apple-Erweiterung.' }
$protocol = $source.Substring(0, $end) + ';globalThis.Session=SecretSession;'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $target 'node.exe')
Copy-Item -LiteralPath (Join-Path $repo 'src\icloud\bridge.mjs') -Destination (Join-Path $target 'bridge.mjs')
Copy-Item -LiteralPath (Join-Path $repo 'src\icloud\account-cache.mjs') -Destination (Join-Path $target 'account-cache.mjs')
Copy-Item -LiteralPath (Join-Path $repo 'src\icloud\read-code.ps1') -Destination (Join-Path $target 'read-code.ps1')
[IO.File]::WriteAllText((Join-Path $target 'protocol.js'), $protocol, [Text.UTF8Encoding]::new($false))
'Lokale iCloud-Anbindung eingerichtet.'
