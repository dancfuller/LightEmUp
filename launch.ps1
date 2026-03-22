# LightEmUp Launcher
# Starts the backend server (if not running) and opens the browser.
# Designed to be called from launch.vbs for a no-console-window experience.

$backendDir = Join-Path $PSScriptRoot "backend"
$serverUrl  = "http://localhost:8420"

# Check if server is already running
$running = $false
try {
    $resp = Invoke-WebRequest -Uri "$serverUrl/api/config" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $running = $true }
} catch {
    $running = $false
}

if (-not $running) {
    # Start the server as a hidden background process
    $venvPython = Join-Path $backendDir "venv\Scripts\python.exe"
    if (-not (Test-Path $venvPython)) {
        # First run: create venv and install deps
        Push-Location $backendDir
        python -m venv venv
        & $venvPython -m pip install -r requirements.txt -q
        Pop-Location
    }
    $mainPy = Join-Path $backendDir "main.py"
    Start-Process -FilePath $venvPython -ArgumentList $mainPy -WorkingDirectory $backendDir -WindowStyle Hidden

    # Wait for server to come up (up to 10 seconds)
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri "$serverUrl/api/config" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { break }
        } catch {}
    }
}

# Open browser
Start-Process $serverUrl
