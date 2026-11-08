[CmdletBinding()]
param(
    [string]$Repo,
    [switch]$StartOnLogin,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\GitGenie'
$pythonCommand = Get-Command python.exe -ErrorAction Stop
$pythonExe = $pythonCommand.Source
$pythonwExe = Join-Path (Split-Path -Parent $pythonExe) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonwExe)) {
    throw 'pythonw.exe was not found beside Python. Install Python 3.10+ for Windows, including Tkinter.'
}
& $pythonExe -c 'import sys, tkinter; assert sys.version_info >= (3, 10); root = tkinter.Tk(); root.withdraw(); root.destroy()'
if ($LASTEXITCODE -ne 0) { throw 'Python or Tkinter check failed.' }
Get-Command git.exe -ErrorAction Stop | Out-Null

# Validate before touching the installation or shortcuts.
$repoArgument = ''
if ($Repo) {
    $repoPath = (Resolve-Path -LiteralPath $Repo).Path
    & git.exe -C $repoPath rev-parse --show-toplevel | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The supplied folder is not a Git working tree.' }
    $repoArgument = ' --repo "' + $repoPath + '"'
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
# Copy only application sources; leave repositories and tests in the workspace.
$packageDir = Join-Path $installDir 'gitgenie'
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourceDir 'gitgenie') -Filter '*.py' -File |
    Copy-Item -Destination $packageDir -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'README.md') -Destination $installDir -Force

$shell = New-Object -ComObject WScript.Shell
$arguments = '-m gitgenie' + $repoArgument
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Git Genie.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Git Genie.lnk')
)
if ($StartOnLogin) {
    $shortcutPaths += Join-Path ([Environment]::GetFolderPath('Startup')) 'Git Genie.lnk'
}
foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $pythonwExe
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $installDir
    $shortcut.Description = 'Git Genie — local Git awareness beside VS Code'
    $shortcut.Save()
}
Write-Host "Installed Git Genie to $installDir"
Write-Host 'Desktop and Start menu shortcuts created. Remote fetching is off.'
if (-not $NoLaunch) {
    # This is the visible desktop app the user is installing, not a helper console.
    Start-Process -FilePath $pythonwExe -WorkingDirectory $installDir -ArgumentList $arguments
}
