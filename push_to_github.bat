@echo off
setlocal
cd /d "%~dp0"

echo.
echo Target repo: https://github.com/cxdleon/ipad.git
echo Remote and branch are already configured. No input needed.
echo A GitHub sign-in window may open. Complete the sign-in and wait here.
echo.

git config http.schannelCheckRevoke false
git branch -M main
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Finish the GitHub sign-in, then run this file again.
  echo If it keeps failing, use the ZIP upload method instead.
  pause
  exit /b 1
)

echo.
echo PUSH OK - GitHub Actions starts automatically on this push.
echo.
echo Open: https://github.com/cxdleon/ipad/actions
echo Wait for the green check, then open the run and download
echo the artifact named "ipados13-test-ipa" - that is your unsigned IPA.
echo.
echo Then sign it with 3uTools Apple ID, or install directly on a
echo jailbroken iPad with AppSync Unified.
echo.
pause
