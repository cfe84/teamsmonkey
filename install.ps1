$ErrorActionPreference = "Stop"

$repo = "cfe84/teamsmonkey"
$installDir = if ($env:TEAMSMONKEY_INSTALL_DIR) {
  $env:TEAMSMONKEY_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Teamsmonkey"
}
$asset = "teamsmonkey-windows-amd64.zip"
$archive = Join-Path ([System.IO.Path]::GetTempPath()) "teamsmonkey.zip"
$downloadUrl = "https://github.com/$repo/releases/latest/download/$asset"

try {
  Write-Host "Downloading $asset..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archive
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Expand-Archive -Path $archive -DestinationPath $installDir -Force

  [Environment]::SetEnvironmentVariable(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--remote-debugging-port=9223",
    "User"
  )

  & (Join-Path $installDir "teamsmonkey.exe") --service-install
  if ($LASTEXITCODE -ne 0) {
    throw "Teamsmonkey service installation failed with exit code $LASTEXITCODE."
  }
  Write-Host "Teamsmonkey installed in $installDir"
  Write-Host "Fully quit and reopen Teams to apply the CDP setting."
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $archive
}
