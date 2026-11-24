#!/usr/bin/env bash
# Установщик CsGoth для Ubuntu 24.04. Запуск на сервере: bash install.sh
# Повторный запуск обновляет игру, настройки и база не трогаются.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запусти от root: sudo bash install.sh"; exit 1; }
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "Внимание: скрипт проверен на Ubuntu 24.04, у тебя ${PRETTY_NAME:-другая система}."
SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/csgoth; DATA=/var/lib/csgoth; ENVF=/etc/csgoth.env
say(){ printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
ask(){ local v; read -r -p "$1 " v; echo "$v"; }

say "1/6 Ставлю нужные программы (это 2-4 минуты)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw caddy build-essential python3
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if [ ! -f "$ENVF" ]; then
  say "2/6 Несколько вопросов"
  DOMAIN=$(ask "Твой домен без https (например csgoth.ru):")
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%/}
  read -r -s -p "Токен бота из BotFather (при вводе не виден): " TOKEN; echo
  ADMIN=$(ask "Твой Telegram ID (только цифры, его покажет @userinfobot):")
  SHORT=$(ask "Короткое имя приложения из BotFather (просто Enter = play):"); SHORT=${SHORT:-play}
  [[ "$ADMIN" =~ ^[0-9]+$ ]] || { echo "Telegram ID должен состоять только из цифр. Запусти установщик снова."; exit 1; }
  BOT=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.ok?j.result.username:""' 2>/dev/null || true)
  [ -n "$BOT" ] || { echo "Токен не подошёл. Проверь его в BotFather и запусти установщик снова."; exit 1; }
  echo "Бот найден: @$BOT"
  IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)
  DIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  if [ -n "$IP" ] && [ "$IP" != "${DIP:-}" ]; then
    echo "Домен $DOMAIN сейчас указывает на '${DIP:-никуда}', а IP твоего сервера $IP."
    echo "Добавь у регистратора запись A: имя @, значение $IP (если домен через Cloudflare, выключи оранжевое облако), подожди 15-30 минут и запусти снова."
    exit 1
  fi
  umask 077
  cat > "$ENVF" <<ENVEOF
BOT_TOKEN=$TOKEN
ADMIN_TG_IDS=$ADMIN
MINIAPP_LINK=https://t.me/$BOT/$SHORT
PUBLIC_URL=https://$DOMAIN
DB_FILE=$DATA/csgoth.db
PORT=3000
COOKIE_SECURE=1
DEMO_PAYMENTS=1
ENVEOF
  umask 022
  echo "$DOMAIN" > /etc/csgoth.domain
fi
DOMAIN=$(cat /etc/csgoth.domain)

say "3/6 Копирую игру"
id csgoth >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin csgoth
mkdir -p "$APP" "$DATA" /var/backups/csgoth
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/public" "$APP"/
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$APP"/
(cd "$APP" && npm install --omit=dev --no-audit --no-fund)
chown -R csgoth:csgoth "$APP" "$DATA" /var/backups/csgoth

say "4/6 Настраиваю автозапуск, https и защиту"
cat > /etc/systemd/system/csgoth.service <<'SVCEOF'
[Unit]
Description=CsGoth
After=network.target
[Service]
User=csgoth
WorkingDirectory=/opt/csgoth
EnvironmentFile=/etc/csgoth.env
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
SVCEOF
cat > /etc/caddy/Caddyfile <<CADDYEOF
$DOMAIN {
	encode gzip
	reverse_proxy localhost:3000
}
CADDYEOF
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

say "5/6 Ежедневная копия базы (папка /var/backups/csgoth, хранится 14 копий)"
cat > /usr/local/bin/csgoth-backup <<'BKEOF'
#!/usr/bin/env bash
cd /opt/csgoth || exit 1
runuser -u csgoth -- node -e "const d=require('better-sqlite3')('/var/lib/csgoth/csgoth.db');d.backup('/var/backups/csgoth/csgoth-'+new Date().toISOString().slice(0,10)+'.db').then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})"
ls -1t /var/backups/csgoth/csgoth-*.db 2>/dev/null | tail -n +15 | xargs -r rm
BKEOF
chmod +x /usr/local/bin/csgoth-backup
echo '0 4 * * * root /usr/local/bin/csgoth-backup' > /etc/cron.d/csgoth-backup

say "6/6 Запускаю"
systemctl daemon-reload
systemctl enable csgoth >/dev/null 2>&1
systemctl restart csgoth
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 4
curl -fsS http://localhost:3000/api/config >/dev/null || { echo "Игра не запустилась. Пришли мне результат команды: journalctl -u csgoth -n 30 --no-pager"; exit 1; }
OK=0; for i in $(seq 1 20); do curl -fsS "https://$DOMAIN/api/config" >/dev/null 2>&1 && { OK=1; break; }; sleep 3; done
LINK=$(grep '^MINIAPP_LINK=' "$ENVF" | cut -d= -f2-)
echo
if [ "$OK" = 1 ]; then echo "ГОТОВО. Игра работает на https://$DOMAIN"; else echo "Игра запущена, но https пока не ответил (сертификат ещё выдаётся). Подожди пару минут и открой https://$DOMAIN в браузере."; fi
cat <<DONEEOF

Что дальше:
1. В Telegram открой @BotFather, отправь /newapp, выбери своего бота, придумай название и описание,
   загрузи любую картинку 640x360, а когда спросит адрес (URL), напиши: https://$DOMAIN
   Короткое имя приложения: то, что ты указал при установке (по умолчанию play).
2. Открой в Telegram ссылку $LINK и проверь игру.

Полезные команды:
  journalctl -u csgoth -f        смотреть, что пишет игра
  systemctl restart csgoth       перезапустить после смены настроек
  nano $ENVF       настройки (токен, Platega и другое)
Сейчас включено тестовое пополнение без денег (DEMO_PAYMENTS=1). Перед настоящим запуском удали эту строку в настройках и перезапусти игру.
DONEEOF
