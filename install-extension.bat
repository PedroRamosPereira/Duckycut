@echo off
:: ============================================================
::  Duckycut CEP Extension Installer
::  Instala a extensao no Adobe Premiere Pro via symlink + registry
:: ============================================================

setlocal EnableDelayedExpansion

:: --- Configuracao ---
set "EXTENSION_ID=com.duckycut.panel"
set "EXTENSION_DIR=%~dp0"

:: Remove trailing backslash
if "%EXTENSION_DIR:~-1%"=="\" set "EXTENSION_DIR=%EXTENSION_DIR:~0,-1%"

:: --- Detectar versoes CSXS instaladas (9, 10, 11, 12) ---
set "INSTALLED=0"

echo.
echo  ============================================
echo     Duckycut - Instalador de Extensao CEP
echo  ============================================
echo.

:: --- Habilitar PlayerDebugMode para todas as versoes CSXS ---
echo [1/3] Habilitando modo debug para extensoes unsigned...
echo.

for %%V in (9 10 11 12) do (
    reg add "HKCU\SOFTWARE\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo       CSXS.%%V  - PlayerDebugMode = 1  [OK]
    )
)

echo.

:: --- Determinar pasta CEP extensions ---
set "CEP_DIR=%APPDATA%\Adobe\CEP\extensions"
set "TARGET_DIR=%CEP_DIR%\%EXTENSION_ID%"

echo [2/3] Criando symlink da extensao...
echo.
echo       Origem:  %EXTENSION_DIR%
echo       Destino: %TARGET_DIR%
echo.

:: Criar pasta CEP se nao existir
if not exist "%CEP_DIR%" (
    mkdir "%CEP_DIR%"
    echo       Pasta CEP criada: %CEP_DIR%
)

:: Remover symlink/pasta anterior se existir
if exist "%TARGET_DIR%" (
    :: Checar se eh junction/symlink
    fsutil reparsepoint query "%TARGET_DIR%" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        rmdir "%TARGET_DIR%" >nul 2>&1
        echo       Symlink anterior removido.
    ) else (
        echo       AVISO: Pasta existente em %TARGET_DIR%
        echo       Removendo pasta existente...
        rmdir /s /q "%TARGET_DIR%" >nul 2>&1
    )
)

:: Criar junction (symlink de diretorio, nao precisa de admin)
mklink /J "%TARGET_DIR%" "%EXTENSION_DIR%" >nul 2>&1

if !ERRORLEVEL! equ 0 (
    echo       Symlink criado com sucesso!  [OK]
    set "INSTALLED=1"
) else (
    echo       ERRO: Falha ao criar symlink.
    echo       Tente executar como Administrador.
    goto :error
)

echo.

:: --- Verificar FFmpeg ---
echo [3/3] Verificando dependencias...
echo.

where ffmpeg >nul 2>&1
if !ERRORLEVEL! equ 0 (
    for /f "tokens=*" %%i in ('ffmpeg -version 2^>^&1 ^| findstr /i "ffmpeg version"') do (
        echo       FFmpeg: %%i  [OK]
    )
) else (
    echo       FFmpeg: NAO ENCONTRADO  [!!]
    echo.
    echo       O FFmpeg eh necessario para deteccao de silencio.
    echo       Baixe em: https://ffmpeg.org/download.html
    echo       E adicione ao PATH do sistema.
)

echo.
echo  ============================================
echo     Instalacao concluida!
echo  ============================================
echo.
echo  Proximos passos:
echo    1. Reinicie o Adobe Premiere Pro
echo    2. Va em: Janela ^> Extensoes ^> Duckycut
echo.
echo  Pressione qualquer tecla para sair...
pause >nul
exit /b 0

:error
echo.
echo  Instalacao falhou. Verifique as mensagens acima.
echo.
pause
exit /b 1
