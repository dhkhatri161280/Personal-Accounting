@echo off
title FinTech by DK - Repair Local Sync Credentials
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Repair-Local-Sync-Credentials.ps1"
if errorlevel 1 (
  echo.
  echo REPAIR FAILED. No accounting data was changed.
  pause
)
