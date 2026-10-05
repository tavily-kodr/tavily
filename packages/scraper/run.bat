@echo off
setlocal
cd /d "%~dp0"

if not exist "go-scraper.exe" (
    call build.bat
)

if "%~1"=="" (
    echo.
    echo ==================================================
    echo       Firecrawl-Speed Go Scraper
    echo ==================================================
    echo.
    echo Simple Commands:
    echo   .\scrape.bat ^<url^>       - Scrape web pages to Markdown/JSON
    echo   .\crawl.bat  ^<url^>       - BFS Crawl entire website
    echo   .\run.bat sitemap ^<url^>  - Scrape all sitemap URLs
    echo   .\run.bat discover ^<url^> - Preview sitemap URLs (dry run)
    echo.
    echo Direct executable:
    echo   .\go-scraper.exe scrape https://example.com
    echo   .\go-scraper.exe crawl https://docs.python.org
    echo.
    exit /b 0
)

go-scraper.exe %*
