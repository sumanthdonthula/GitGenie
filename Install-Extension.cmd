@echo off
setlocal
where code.cmd >nul 2>nul
if errorlevel 1 (
    echo VS Code's command-line tool was not found on PATH.
    echo In VS Code, use Extensions: Install from VSIX and select:
    echo %~dp0artifacts\git-genie-0.3.1.vsix
    pause
    exit /b 1
)
call code.cmd --install-extension "%~dp0artifacts\git-genie-0.3.1.vsix" --force
if errorlevel 1 (
    echo Installation did not complete. See the message above.
    pause
    exit /b 1
)
echo Git Genie is installed. Click the lamp in VS Code's Activity Bar.
echo If it is not visible yet, run Developer: Reload Window in VS Code.
pause
