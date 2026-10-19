#!/usr/bin/env bash
# Stellt ein Datenbank-Backup wieder her.
#   bash deploy/restore.sh                                  -> zeigt die vorhandenen Backups
#   bash deploy/restore.sh trackinsight-2026-10-18.sql.gz   -> stellt dieses Backup wieder her
#   bash deploy/restore.sh /pfad/zu/eigenem-dump.sql.gz     -> Datei von ausserhalb des Volumes
#
# Ablauf: App stoppen -> Datenbank leeren und Dump einspielen -> App starten (führt Migrationen aus).
# ACHTUNG: Alle aktuellen Daten in der Datenbank werden durch den Stand des Backups ersetzt.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/docker-compose.prod.yml)
ENV_FILE="deploy/.env.prod"
DB_NAME="taktwerk"

if [ ! -f "$ENV_FILE" ]; then
  echo "FEHLER: $ENV_FILE nicht gefunden. Bitte im Projektordner ausführen." >&2
  exit 1
fi

# Root-Passwort aus .env.prod lesen (nur diese eine Zeile).
ROOT_PW="$(grep -E '^MARIADB_ROOT_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
if [ -z "$ROOT_PW" ]; then
  echo "FEHLER: MARIADB_ROOT_PASSWORD fehlt in $ENV_FILE." >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "Vorhandene Backups (neueste zuerst):"
  "${COMPOSE[@]}" exec -T backup bash -c 'ls -1t /backups/trackinsight-*.sql.gz 2>/dev/null | xargs -r -n1 basename; echo; cat /backups/latest.json 2>/dev/null || true'
  echo
  echo "Wiederherstellen mit:  bash deploy/restore.sh <Dateiname>"
  exit 0
fi

CHOICE="$1"
if [ -f "$CHOICE" ]; then
  # Lokale Datei (ausserhalb des Volumes): in den Container kopieren.
  MODE="local"
  SRC="$CHOICE"
else
  MODE="volume"
  SRC="/backups/$(basename "$CHOICE")"
  if ! "${COMPOSE[@]}" exec -T backup test -f "$SRC"; then
    echo "FEHLER: Backup $SRC nicht gefunden. Ohne Argument aufrufen, um die Liste zu sehen." >&2
    exit 1
  fi
fi

echo "=================================================================="
echo "  WIEDERHERSTELLUNG der Datenbank «$DB_NAME»"
echo "  Quelle: $CHOICE"
echo
echo "  Alle aktuellen Daten werden durch den Stand dieses Backups ERSETZT."
echo "  Die App ist während der Wiederherstellung nicht erreichbar."
echo "=================================================================="
read -r -p "Wirklich fortfahren? Tippen Sie JA in Grossbuchstaben: " ANSWER
if [ "$ANSWER" != "JA" ]; then
  echo "Abgebrochen. Es wurde nichts verändert."
  exit 0
fi

echo "[1/5] Sicherheitskopie des aktuellen Stands erstellen ..."
"${COMPOSE[@]}" exec -T backup bash -c 'bash /backup.sh einmal' || {
  echo "WARNUNG: Sicherheitskopie fehlgeschlagen. Trotzdem fortfahren? (JA/nein)"
  read -r ANSWER2
  [ "$ANSWER2" = "JA" ] || { echo "Abgebrochen."; exit 1; }
}

echo "[2/5] App stoppen ..."
"${COMPOSE[@]}" stop app

echo "[3/5] Datenbank leeren ..."
"${COMPOSE[@]}" exec -T -e MYSQL_PWD="$ROOT_PW" db mariadb -uroot -e \
  "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON \`$DB_NAME\`.* TO 'taktwerk'@'%'; FLUSH PRIVILEGES;"

echo "[4/5] Backup einspielen (kann einige Minuten dauern) ..."
if [ "$MODE" = "local" ]; then
  gunzip -c "$SRC" | "${COMPOSE[@]}" exec -T -e MYSQL_PWD="$ROOT_PW" db mariadb -uroot --default-character-set=utf8mb4 "$DB_NAME"
else
  "${COMPOSE[@]}" exec -T backup bash -c "gunzip -c '$SRC'" | "${COMPOSE[@]}" exec -T -e MYSQL_PWD="$ROOT_PW" db mariadb -uroot --default-character-set=utf8mb4 "$DB_NAME"
fi

echo "[5/5] App starten (Migrationen laufen automatisch) ..."
"${COMPOSE[@]}" up -d app

echo
echo "Fertig. Prüfen Sie die App im Browser und mit:"
echo "  docker compose -f deploy/docker-compose.prod.yml logs --tail 50 app"
