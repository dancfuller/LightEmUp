# Creates LightEmUp shortcuts on Desktop and Start Menu.
# Run once: powershell -ExecutionPolicy Bypass -File install-shortcut.ps1

$projectDir = $PSScriptRoot
$launchVbs  = Join-Path $projectDir "launch.vbs"
$iconIco    = Join-Path $projectDir "lightemup.ico"

# Use custom icon if present, otherwise fall back to a system lightbulb icon
if (Test-Path $iconIco) {
    $iconPath = $iconIco
} else {
    # Shell32.dll index 15 = a generic application icon; imageres.dll,101 = a brighter one
    $iconPath = "C:\Windows\System32\imageres.dll,101"
}

function New-Shortcut($lnkPath) {
    $ws  = New-Object -ComObject WScript.Shell
    $sc  = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath       = "wscript.exe"
    $sc.Arguments         = "`"$launchVbs`""
    $sc.WorkingDirectory  = $projectDir
    $sc.IconLocation      = $iconPath
    $sc.Description       = "Start LightEmUp smart-light controller"
    $sc.Save()
    Write-Host "Created: $lnkPath"
}

# Desktop shortcut
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "LightEmUp.lnk"
New-Shortcut $desktopLnk

# Start Menu shortcut
$startMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "LightEmUp"
if (-not (Test-Path $startMenuDir)) { New-Item -ItemType Directory -Path $startMenuDir | Out-Null }
$startMenuLnk = Join-Path $startMenuDir "LightEmUp.lnk"
New-Shortcut $startMenuLnk

Write-Host ""
Write-Host "Done! You should now see LightEmUp on your Desktop and in Start Menu." -ForegroundColor Green
Write-Host "To remove: delete the shortcuts and the '$startMenuDir' folder." -ForegroundColor Gray
