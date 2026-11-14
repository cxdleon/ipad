@echo off
setlocal
cd /d "%~dp0"

echo.
echo Push this local repo to your EMPTY GitHub repository.
echo Create one first at https://github.com/new (do NOT add README/license/.gitignore).
echo.
set /p REPO=GitHub repo URL (https://github.com/USER/REPO.git): 
if "%REPO%"=="" (
  echo Cancelled.
  pause
  exit /b 1
)

git remote remove origin >nul 2>&1
git remote add origin %REPO%
if errorlevel 1 (
  echo Failed to set remote.
  pause
  exit /b 1
)

git branch -M main
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check the URL and your GitHub login.
  pause
  exit /b 1
)

echo.
echo OK. Next steps:
echo   1. Open your repo on GitHub
echo   2. Actions ^> "iPadOS 13 Minimal Test IPA" ^> Run workflow
echo   3. Download the "ipados13-test-ipa" artifact
echo   4. Sign it with i4 / 3uTools Apple ID, or install on jailbroken iPad with AppSync
echo.
pause
