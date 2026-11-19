#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/switchyard-cloud/current
backup_dir="/srv/switchyard-cloud/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_dir"
/opt/switchyard-node/bin/node --import tsx server/cloud/admin.ts backup "$backup_dir/gateway.sqlite3"
cp -a /srv/switchyard-cloud/credentials "$backup_dir/credentials"
if [ -d /srv/switchyard-cloud/data/user-credentials ]; then
  cp -a /srv/switchyard-cloud/data/user-credentials "$backup_dir/user-credentials"
fi
printf '%s\n' 'Switchyard gateway schema 3. Restore gateway.sqlite3 to data/, credentials to /srv/switchyard-cloud/credentials, and user-credentials to data/user-credentials. Restore these together with the corresponding Junction backup. Service provisioning credentials are in /etc and must be backed up separately.' > "$backup_dir/README"
