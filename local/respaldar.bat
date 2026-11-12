@echo off
chcp 65001 >nul
REM Cambie la ruta por la carpeta de Google Drive para escritorio donde quiere los respaldos:
set CARPETA_DRIVE=C:\Users\pc\OneDrive\LibroFacturas-respaldos
cd /d "%~dp0"
node respaldo.mjs "%CARPETA_DRIVE%"
