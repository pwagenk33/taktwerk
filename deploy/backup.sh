#!/usr/bin/env bash
# Nächtliches Backup der TrackInsight-Datenbank.
# Läuft als Endlosschleife im Container «backup» (siehe docker-compose.prod.yml):
#   - jede Nacht um BACKUP_TIME (Standard 02:30 Uhr Europe/Zurich)
#   - mariadb-dump --single-transaction  ->  /backups/trackinsight-JJJJ-MM-TT.sql.gz
#   - behält BACKUP_KEEP_DAYS (Standard 30) tägliche Dumps
#   - schreibt /backups/latest.json  {"finishedAt": ..., "file": ..., "bytes": ...}
#   - optional: Kopie in einen S3-Bucket mit rclone, wenn BACKUP_S3_BUCKET gesetzt ist
#
# Sofort ein Backup auslösen (ohne auf die Nacht zu warten):
#   docker compose -f deploy/docker-compose.prod.yml exec backup bash /backup.sh einmal
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_TIME="${BACKUP_TIME:-02:30}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-taktwerk}"
DB_USER="${DB_USER:-taktwerk}"
DB_PASSWORD="${MARIADB_PASSWORD:?MARIADB_PASSWORD fehlt in .env.prod}"
export TZ="${TZ:-Europe/Zurich}"

S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
S3_ACCESS_KEY="${BACKUP_S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${BACKUP_S3_SECRET_KEY:-}"
S3_REGION="${BACKUP_S3_REGION:-}"

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Prüft, ob die Off-Site-Kopie konfiguriert ist, und stellt rclone bereit.
s3_enabled() { [ -n "$S3_BUCKET" ]; }

ensure_rclone() {
  command -v rclone >/dev/null 2>&1 && return 0
  log "rclone wird installiert (einmalig pro Container-Start) ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null && apt-get install -y -qq rclone >/dev/null
  else
    log "FEHLER: rclone fehlt und apt-get ist nicht verfügbar; Off-Site-Kopie wird übersprungen."
    return 1
  fi
}

# rclone-Verbindung komplett über Umgebungsvariablen (keine Config-Datei nötig).
s3_env() {
  export RCLONE_CONFIG_S3_TYPE=s3
  export RCLONE_CONFIG_S3_PROVIDER=Other
  export RCLONE_CONFIG_S3_ENDPOINT="$S3_ENDPOINT"
  export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY"
  export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
  export RCLONE_CONFIG_S3_REGION="$S3_REGION"
  export RCLONE_CONFIG_S3_ACL=private
}

upload_offsite() {
  local file="$1"
  s3_enabled || return 0
  if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
    log "WARNUNG: BACKUP_S3_BUCKET gesetzt, aber ENDPOINT/ACCESS_KEY/SECRET_KEY fehlen; Off-Site-Kopie übersprungen."
    return 0
  fi
  ensure_rclone || return 0
  s3_env
  if rclone copyto "$file" "s3:${S3_BUCKET}/$(basename "$file")" --s3-no-check-bucket -q \
     && rclone copyto "$BACKUP_DIR/latest.json" "s3:${S3_BUCKET}/latest.json" --s3-no-check-bucket -q; then
    log "Off-Site-Kopie nach s3:${S3_BUCKET} abgeschlossen."
    # Im Bucket ebenfalls nur BACKUP_KEEP_DAYS Tage behalten.
    rclone delete "s3:${S3_BUCKET}" --include 'trackinsight-*.sql.gz' --min-age "${BACKUP_KEEP_DAYS}d" -q || true
  else
    log "FEHLER: Off-Site-Kopie fehlgeschlagen (lokales Backup ist vorhanden)."
  fi
}

run_backup() {
  local day file tmp bytes finished
  day="$(date '+%Y-%m-%d')"
  file="$BACKUP_DIR/trackinsight-${day}.sql.gz"
  tmp="${file}.tmp"
  mkdir -p "$BACKUP_DIR"
  log "Dump von ${DB_NAME}@${DB_HOST} nach $(basename "$file") ..."

  # Passwort nicht auf der Kommandozeile (wäre in `ps` sichtbar), sondern per Umgebungsvariable.
  if MYSQL_PWD="$DB_PASSWORD" mariadb-dump \
       --host="$DB_HOST" --user="$DB_USER" \
       --single-transaction --quick --routines --events --triggers \
       --default-character-set=utf8mb4 \
       "$DB_NAME" | gzip -6 > "$tmp"; then
    mv -f "$tmp" "$file"
  else
    rm -f "$tmp"
    log "FEHLER: mariadb-dump ist fehlgeschlagen; latest.json wird nicht aktualisiert."
    return 1
  fi

  bytes="$(stat -c %s "$file")"
  finished="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"finishedAt": "%s", "file": "%s", "bytes": %s}\n' "$finished" "$(basename "$file")" "$bytes" > "$BACKUP_DIR/latest.json.tmp"
  mv -f "$BACKUP_DIR/latest.json.tmp" "$BACKUP_DIR/latest.json"
  chmod 644 "$BACKUP_DIR/latest.json" "$file"
  log "Fertig: $(basename "$file") (${bytes} Bytes)."

  # Alte Dumps aufräumen: nur die letzten BACKUP_KEEP_DAYS Dateien behalten.
  ls -1t "$BACKUP_DIR"/trackinsight-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP_DAYS + 1))" | while read -r old; do
    log "Lösche altes Backup $(basename "$old")."
    rm -f "$old"
  done

  upload_offsite "$file"
}

# Sekunden bis zur nächsten Ausführung um BACKUP_TIME (lokale Zeit, Europe/Zurich).
seconds_until_next_run() {
  local now target
  now="$(date +%s)"
  target="$(date -d "today ${BACKUP_TIME}" +%s)"
  if [ "$target" -le "$now" ]; then
    target="$(date -d "tomorrow ${BACKUP_TIME}" +%s)"
  fi
  echo $((target - now))
}

if [ "${1:-}" = "einmal" ]; then
  run_backup
  exit $?
fi

log "Backup-Dienst gestartet. Täglich um ${BACKUP_TIME} (${TZ}), behalte ${BACKUP_KEEP_DAYS} Tage, Off-Site: $(s3_enabled && echo "ja (${S3_BUCKET})" || echo nein)."
mkdir -p "$BACKUP_DIR"
# Wenn noch gar kein Backup existiert (frische Installation), sofort eines erstellen.
if ! ls "$BACKUP_DIR"/trackinsight-*.sql.gz >/dev/null 2>&1; then
  log "Noch kein Backup vorhanden, erstelle das erste jetzt."
  run_backup || true
fi

while true; do
  wait="$(seconds_until_next_run)"
  log "Nächstes Backup in $((wait / 3600)) h $(((wait % 3600) / 60)) min."
  sleep "$wait"
  run_backup || true
  sleep 60   # verhindert eine zweite Ausführung in derselben Minute
done
