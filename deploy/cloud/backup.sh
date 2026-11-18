#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/switchyard-cloud/current
backup_dir="/srv/switchyard-cloud/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_dir"
/opt/switchyard-node/bin/node --import tsx server/cloud/admin.ts backup "$backup_dir/gateway.sqlite3"
cp -a /srv/switchyard-cloud/credentials "$backup_dir/credentials"
printf '%s\n' 'Switchyard gateway schema 1; restore the database and credentials together.' > "$backup_dir/README"
