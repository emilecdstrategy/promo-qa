param(
  [Parameter(Mandatory = $true)]
  [string]$Store,

  [Parameter(Mandatory = $true)]
  [string]$ThemeId,

  [string]$ThemeAccessPassword
)

$ErrorActionPreference = "Stop"

$storeSlug = ($Store -replace "\.myshopify\.com$", "")
$storeHost = "$storeSlug.myshopify.com"
$outDir = Join-Path "themes" $storeSlug $ThemeId

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "Pulling templates/index.json"
Write-Host "  Store:  $storeHost"
Write-Host "  Theme:  $ThemeId"
Write-Host "  Output: $outDir"

$pullArgs = @(
  "theme", "pull",
  "--store", $storeHost,
  "--theme", $ThemeId,
  "--only", "templates/index.json",
  "--path", $outDir
)

if ($ThemeAccessPassword) {
  $pullArgs += @("--password", $ThemeAccessPassword)
}

& shopify @pullArgs

Write-Host "Done: $outDir/templates/index.json"
