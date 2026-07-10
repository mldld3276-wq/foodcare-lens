@echo off
chcp 65001 >nul
title 푸드케어 렌즈
echo.
echo  🥗 푸드케어 렌즈 서버를 시작합니다...
echo  브라우저가 자동으로 열립니다. 이 검은 창은 끄지 마세요!
echo  (끝내려면 이 창을 닫으면 됩니다)
echo.
start "" http://localhost:8123
cd /d "%~dp0"
python -m http.server 8123
