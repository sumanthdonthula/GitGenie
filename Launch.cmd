@echo off
setlocal
cd /d "%~dp0"
where pythonw.exe >nul 2>nul
if errorlevel 1 (
    echo Git Genie needs Python 3.10 or later with Tkinter and Git for Windows.
    echo Install Python with the Python launcher and add it to PATH, then try again.
    pause
    exit /b 1
)
start "Git Genie" pythonw.exe -m gitgenie %*
