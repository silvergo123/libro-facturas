@echo off
chcp 65001 >nul
title Respaldos Libro Facturas (cada 6 horas)
:b
node "%~dp0respaldo.mjs" "C:\Users\pc\OneDrive\LibroFacturas-respaldos"
timeout /t 21600 /nobreak >nul
goto b
