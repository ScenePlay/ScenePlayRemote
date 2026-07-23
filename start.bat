@echo off
rem Start ScenePlay Remote (installed by install.bat).
rem Honors HOST/PORT from .env; runs without the dev auto-reloader.
cd /d "%~dp0"
if not exist .env (echo No .env found - run install.bat first. & pause & exit /b 1)
if not exist .venv\Scripts\python.exe (echo No .venv found - run install.bat first. & pause & exit /b 1)
.venv\Scripts\python -c "import config, uvicorn; uvicorn.run('main:app', host=config.HOST, port=config.PORT)"
pause
