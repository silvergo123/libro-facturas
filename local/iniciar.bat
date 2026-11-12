@echo off
chcp 65001 >nul
REM ====== CONFIGURACION (edite solo estas lineas) ======
set ADMIN_TOKEN=CAMBIE-ESTO-por-una-clave-larga-suya
REM Si luego quiere el registro por foto con IA, quite REM y ponga su clave:
REM set ANTHROPIC_API_KEY=sk-ant-...
REM =====================================================

set PORT=3000
set DB_PATH=%~dp0..\datos\libro.db
if not exist "%~dp0..\datos" mkdir "%~dp0..\datos"

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if not "%NODEMAJOR%"=="22" if not "%NODEMAJOR%"=="24" (
  echo.
  echo ERROR: tiene Node.js version %NODEMAJOR%. Esta app necesita Node 22 LTS ^(o 24^).
  echo Desinstale Node, instale la version 22 LTS desde nodejs.org/en/download y borre la carpeta server\node_modules
  pause
  exit /b 1
)
cd /d "%~dp0..\server"
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
  if errorlevel 1 ( echo Fallo la instalacion. & pause & exit /b 1 )
)
echo.
echo Servidor en http://localhost:%PORT%   (NO cierre esta ventana)
echo Base de datos: %DB_PATH%
echo.
:otra_vez
node server.js
echo El servidor se detuvo. Reiniciando en 5 segundos... (cierre la ventana para salir)
timeout /t 5 >nul
goto otra_vez
