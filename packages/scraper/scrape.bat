@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
    echo Usage:   scrape.bat ^<url^> [url2...]
    echo Example: scrape.bat https://example.com
    exit /b 1
)

if not exist "go-scraper.exe" (
    call build.bat
)

go-scraper.exe scrape %*
