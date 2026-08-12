#!/usr/bin/env bash
# Download an official Comiket hall map into maps/.
#
#   tools/fetch_map.sh                 # C108
#   tools/fetch_map.sh C109 C109Map_all_B4.pdf
set -euo pipefail

EVENT="${1:-C108}"
FILE="${2:-${EVENT}Map_all_B4.pdf}"
URL="https://www.comiket.co.jp/info-a/${EVENT}/${FILE}"

cd "$(dirname "$0")/.."
mkdir -p maps

echo "fetching $URL"
curl --fail --location --progress-bar --output "maps/$FILE" "$URL"

printf 'saved maps/%s (%s bytes)\n' "$FILE" "$(stat -c%s "maps/$FILE" 2>/dev/null || stat -f%z "maps/$FILE")"
printf 'sha256: %s\n' "$(sha256sum "maps/$FILE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "maps/$FILE" | cut -d' ' -f1)"
