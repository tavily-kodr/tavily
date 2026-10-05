@echo off
setlocal
cd /d "%~dp0"

echo [INFO] Building go-scraper.exe...

where go >nul 2>&1
if %errorlevel% neq 0 (
    if exist "C:\Program Files\Go\bin\go.exe" (
        set "GO_EXE=C:\Program Files\Go\bin\go.exe"
    ) else (
        echo [ERROR] Go compiler not found!
        exit /b 1
    )
) else (
    set "GO_EXE=go"
)

"%GO_EXE%" build -o go-scraper.exe ./cmd/scraper
if %errorlevel% equ 0 (
    echo [SUCCESS] go-scraper.exe is ready!
) else (
    echo [ERROR] Build failed!
)
