@echo off
title FinTech by DK - Validate Both Books Read Only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Validate-Local-Two-Way-Sync.ps1"
if errorlevel 1 (
  echo.
  echo VALIDATION FAILED. No accounting data was changed.
  pause
)
