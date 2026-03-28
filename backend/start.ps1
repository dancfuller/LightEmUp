# LightEmUp - Backend Server Launcher
# Run this from the lightemup\backend directory

Write-Host "LightEmUp Backend" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

# Check Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "Python not found. Please install Python 3.11+." -ForegroundColor Red
    exit 1
}

# Create venv if needed
if (-not (Test-Path ".\venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}

# Activate venv
& ".\venv\Scripts\Activate.ps1"

# Install deps
Write-Host "Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt -q

# Launch
Write-Host ""
Write-Host "Starting server at http://localhost:8420" -ForegroundColor Green
Write-Host "API docs at http://localhost:8420/docs" -ForegroundColor Green
Write-Host ""
python main.py
