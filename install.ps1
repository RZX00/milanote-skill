# milanote skill installer (Windows)
# Usage:  irm https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "https://codeload.github.com/RZX00/milanote-skill/tar.gz/refs/heads/main"
$tmp = Join-Path $env:TEMP ("milanote-skill-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

Write-Host "Downloading milanote-skill..."
$archive = Join-Path $tmp "src.tgz"
Invoke-WebRequest -Uri $repo -OutFile $archive
tar -xzf $archive -C $tmp
$src = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like "milanote-skill-*" } | Select-Object -First 1
if (-not $src) { throw "milanote-skill: archive did not contain the repository." }

$skillTargets = @(
  (Join-Path $env:USERPROFILE ".cursor\skills\milanote"),
  (Join-Path $env:USERPROFILE ".claude\skills\milanote"),
  (Join-Path $env:USERPROFILE ".codex\skills\milanote"),
  (Join-Path $env:USERPROFILE ".agents\skills\milanote")
)

Write-Host "Installing the milanote skill..."
foreach ($dir in $skillTargets) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Path (Split-Path $dir) -Force | Out-Null
  Copy-Item -Recurse (Join-Path $src.FullName "skills\milanote") $dir
  Write-Host "  skill -> $dir"
}

Write-Host "Installing the OpenCLI adapter..."
$cli = Join-Path $env:USERPROFILE ".opencli\clis\milanote"
$site = Join-Path $env:USERPROFILE ".opencli\sites\milanote"
if (Test-Path $cli) { Remove-Item -Recurse -Force $cli }
New-Item -ItemType Directory -Path (Split-Path $cli) -Force | Out-Null
Copy-Item -Recurse (Join-Path $src.FullName "opencli\clis\milanote") $cli
New-Item -ItemType Directory -Path $site -Force | Out-Null
Copy-Item (Join-Path $src.FullName "opencli\sites\milanote\notes.md") (Join-Path $site "notes.md")
Write-Host "  adapter -> $cli"

Remove-Item -Recurse -Force $tmp
Write-Host "Done. Install OpenCLI if you have not, sign in to Milanote in Chrome, then run: opencli milanote whoami -f yaml"
