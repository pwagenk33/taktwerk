#!/usr/bin/env bash
# Release: Version in allen package.json setzen, CHANGELOG «Unveröffentlicht» datieren, Commit und Git-Tag.
# Aufruf: scripts/release.sh 1.1.0
set -euo pipefail
v="${1:-}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Aufruf: scripts/release.sh <major.minor.patch>"; exit 1; }
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo "Arbeitsverzeichnis ist nicht sauber. Zuerst committen."; exit 1; }
grep -q "^## Unveröffentlicht" CHANGELOG.md || { echo "CHANGELOG.md braucht einen Abschnitt «## Unveröffentlicht»."; exit 1; }
today="$(date +%Y-%m-%d)"
for f in package.json web/package.json server/package.json packages/domain/package.json; do
  node -e "const fs=require('fs');const p='$f';const j=JSON.parse(fs.readFileSync(p));j.version='$v';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
done
# Unveröffentlicht → neue Version mit Datum, darüber ein frischer leerer Abschnitt
perl -0pi -e "s/^## Unveröffentlicht\n/## Unveröffentlicht\n\n## $v – $today\n/m" CHANGELOG.md
npm run typecheck >/dev/null
git add package.json web/package.json server/package.json packages/domain/package.json CHANGELOG.md
git commit -q -m "Release $v"
git tag -a "v$v" -m "Version $v"
echo "Version $v getaggt. Veröffentlichen mit: git push && git push --tags"
