@echo off
setlocal
cd /d "%~dp0"

set REPO_NAME=dsh-desktop
set REPO_DESC=DSH desktop (Electron) built on official dsh-web: wallpapers, mascot widgets, full session sync with the web UI, always launches the latest dsh, customizable.

echo ==============================================
echo   DSH Desktop - Publish to GitHub
echo ==============================================
echo.

rem Proxy for China network (Clash default port 7890; edit if needed)
set "HTTPS_PROXY=http://127.0.0.1:7890"
set "HTTP_PROXY=http://127.0.0.1:7890"

rem 1) locate GitHub CLI
set "PATH=%PATH%;%ProgramFiles%\GitHub CLI;%LOCALAPPDATA%\Programs\GitHub CLI;%LOCALAPPDATA%\Microsoft\WinGet\Links"
where gh >nul 2>nul
if errorlevel 1 (
  echo [ERROR] GitHub CLI not found. Install it with: winget install --id GitHub.cli
  echo or download from https://cli.github.com/ then run this script again.
  pause
  exit /b 1
)

rem 2) login
gh auth status >nul 2>nul
if errorlevel 1 (
  echo [Login] Follow the prompts and authorize in your browser...
  gh auth login
  if errorlevel 1 (
    echo.
    echo [Login failed] Usually caused by network. Make sure Clash is running
    echo with proxy port 7890, or edit the HTTPS_PROXY lines above, then retry.
    pause
    exit /b 1
  )
)
gh auth setup-git >nul 2>nul

rem 3) init repository FIRST, then set identity (needs a repo to work)
if not exist .git (
  git init
  git branch -M main
)
git config user.name >nul 2>nul
if errorlevel 1 (
  echo.
  echo [One-time setup] Enter your git identity:
  set /p GITNAME=Nickname:
  set /p GITMAIL=Email:
  git config user.name "%GITNAME%"
  git config user.email "%GITMAIL%"
)

rem 4) commit
git add .
git commit -m "feat: DSH desktop initial release" >nul 2>nul

rem 5) get username
for /f "delims=" %%u in ('gh api user --jq .login') do set GH_USER=%%u

rem 6) create repo and push (or update)
gh repo view %GH_USER%/%REPO_NAME% >nul 2>nul
if errorlevel 1 (
  echo [Creating repository] %REPO_NAME%
  gh repo create %REPO_NAME% --public --description "%REPO_DESC%" --source . --push
) else (
  echo [Repository exists] Pushing updates...
  git remote remove origin >nul 2>nul
  git remote add origin https://github.com/%GH_USER%/%REPO_NAME%.git
  git push -u origin main
)

echo.
echo ==============================================
echo   Done! Repository: https://github.com/%GH_USER%/%REPO_NAME%
echo   First push is about 116MB, please wait.
echo ==============================================
pause