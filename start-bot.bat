@echo off
setlocal
chcp 65001 >nul
title Bot ROBIN InverseBond
cd /d "%~dp0"

echo ========================================
echo   Bot de rachat ROBIN - InverseBond
echo ========================================
echo.

REM --- Garde anti double instance (2 bots = conflit de nonce) ---
tasklist /fi "imagename eq node.exe" 2>nul | find /i "node.exe" >nul
if not errorlevel 1 (
  echo [!] ATTENTION: un processus node.exe tourne deja.
  echo     Lancer un 2e bot provoque un conflit de nonce.
  echo     Verifie qu'aucune autre fenetre du bot n'est ouverte.
  echo.
  choice /c ON /n /m "Continuer quand meme ? [O]ui / [N]on: "
  if errorlevel 2 goto :fin
  echo.
)

REM --- Verif .env ---
if not exist ".env" (
  echo [!] Fichier .env introuvable.
  echo     Copie .env.example vers .env puis renseigne PRIVATE_KEY.
  goto :fin
)

REM --- Dependances (installe si absentes) ---
if not exist "node_modules" (
  echo Installation des dependances...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [!] Echec de npm install.
    goto :fin
  )
  echo.
)

echo Demarrage du bot... (Ctrl+C pour arreter)
echo.
call npm start

:fin
echo.
echo ----------------------------------------
echo Le bot s'est arrete. Fenetre laissee ouverte pour lire les logs.
pause >nul
endlocal
