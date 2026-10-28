@echo off
chcp 65001 >nul
title HuChuan Server
cd /d "%~dp0server"
node index.js
pause
