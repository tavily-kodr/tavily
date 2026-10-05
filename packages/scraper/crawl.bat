@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
    echo Usage:   crawl.bat ^<start-url^> [--pages=50] [--depth=3]
    echo Example: crawl.bat https://docs.python.org --pages=20 --depth=2
    exit /b 1
)

if not exist "go-scraper.exe" (
    call build.bat
)

go-scraper.exe crawl %*
