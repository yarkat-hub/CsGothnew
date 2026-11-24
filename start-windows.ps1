$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location $PSScriptRoot
function Say($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Yellow }
$cfg = Join-Path $PSScriptRoot 'csgoth-local.txt'

Say 'Проверяю Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Node.js не найден, устанавливаю (подтверди окна, если появятся)...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Write-Host ''
    Write-Host 'Готово. Закрой это окно и запусти start.bat ещё раз.' -ForegroundColor Green
  } else {
    Write-Host 'Установи Node.js вручную: открой nodejs.org, скачай версию LTS, установи, потом запусти start.bat ещё раз.' -ForegroundColor Green
  }
  exit
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  Say 'Устанавливаю игру (1-3 минуты)'
  npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить игру (npm install). Пришли мне текст ошибки.' }
}

$s = @{}
if (Test-Path $cfg) {
  Get-Content $cfg | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $s[$Matches[1]] = $Matches[2] } }
}
if (-not $s.BOT_TOKEN) {
  Say 'Первая настройка (дальше она запоминается)'
  $sec = Read-Host 'Вставь токен бота из BotFather и нажми Enter' -AsSecureString
  $s.BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  $s.ADMIN_TG_IDS = (Read-Host 'Твой Telegram ID (только цифры, его покажет бот @userinfobot)').Trim()
  $short = (Read-Host 'Короткое имя приложения (просто нажми Enter, будет play)').Trim()
  if (-not $short) { $short = 'play' }
  $s.APP_SHORT = $short
  try { $me = Invoke-RestMethod "https://api.telegram.org/bot$($s.BOT_TOKEN)/getMe" } catch { throw 'Токен не подошёл. Проверь его в BotFather и запусти снова.' }
  $s.BOT_USER = $me.result.username
  ($s.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) | Set-Content $cfg -Encoding UTF8
}

$cf = Join-Path $PSScriptRoot 'cloudflared.exe'
if (-not (Test-Path $cf)) {
  Say 'Скачиваю программу-тоннель cloudflared (около 30 МБ)'
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf
}

Say 'Проверяю связь с Telegram'
try { Invoke-WebRequest 'https://api.telegram.org' -UseBasicParsing -TimeoutSec 8 | Out-Null; $tgok = $true } catch { $tgok = [bool]$_.Exception.Response }
if ($tgok) { Write-Host 'Связь с Telegram есть.' -ForegroundColor Green }
else { Write-Host 'ВНИМАНИЕ: компьютер не достаёт до Telegram. Включи VPN на всём компьютере и запусти start.bat заново, иначе кнопка «Играть» и оплата Stars работать не будут.' -ForegroundColor Red }

Say 'Открываю тоннель, это занимает до минуты'
$log = Join-Path $env:TEMP 'csgoth-tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
$tun = Start-Process $cf -ArgumentList 'tunnel','--url','http://localhost:3000','--no-autoupdate','--protocol','http2' -RedirectStandardError $log -RedirectStandardOutput (Join-Path $env:TEMP 'csgoth-tunnel.out') -PassThru -WindowStyle Hidden
$url = $null
for ($i = 0; $i -lt 45 -and -not $url; $i++) {
  Start-Sleep 1
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Value }
}
if (-not $url) { Stop-Process $tun -Force -ErrorAction SilentlyContinue; throw 'Не удалось получить адрес тоннеля. Проверь интернет и запусти ещё раз.' }
Write-Host 'Жду, пока тоннель соединится с Cloudflare...'
$reg = $false
for ($i = 0; $i -lt 40 -and -not $reg; $i++) {
  if (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet -ErrorAction SilentlyContinue) { $reg = $true } else { Start-Sleep 1 }
}
if ($reg) { Write-Host 'Тоннель соединился.' -ForegroundColor Green }
else { Write-Host 'ВНИМАНИЕ: тоннель не соединился с Cloudflare. Включи VPN или смени его сервер и запусти start.bat заново.' -ForegroundColor Red }

$env:BOT_TOKEN = $s.BOT_TOKEN
$env:ADMIN_TG_IDS = $s.ADMIN_TG_IDS
$env:MINIAPP_LINK = "https://t.me/$($s.BOT_USER)/$($s.APP_SHORT)"
$env:PUBLIC_URL = $url
$env:DEMO_PAYMENTS = '1'
$env:PORT = '3000'
$env:DB_FILE = Join-Path $PSScriptRoot 'csgoth.db'
Set-Clipboard $url

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Green
Write-Host " АДРЕС ИГРЫ (уже скопирован): $url" -ForegroundColor Green
Write-Host '=====================================================' -ForegroundColor Green
Write-Host ''
Write-Host 'Что сделать в Telegram:'
Write-Host ' Открой своего бота и нажми кнопку «Играть» слева от строки сообщения'
Write-Host ' (или отправь боту /start и нажми «Играть»). Менять что-то в BotFather не нужно,'
Write-Host ' кнопка сама получает новый адрес при каждом запуске.'
Write-Host ''
Write-Host "Ссылки-приглашения для рефералов ($($env:MINIAPP_LINK)) заработают после /newapp в BotFather"
Write-Host 'с этим адресом, но при смене адреса его придётся обновлять там.'
Write-Host 'Оплата Telegram Stars работает сразу, пока это окно открыто.'
Write-Host 'Не закрывай это окно, пока играешь. Остановить игру: Ctrl+C или закрыть окно.' -ForegroundColor Yellow
Write-Host ''
try { node server.js } finally { Stop-Process $tun -Force -ErrorAction SilentlyContinue }
