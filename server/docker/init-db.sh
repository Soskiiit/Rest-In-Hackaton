#!/bin/sh
# Executed once, on an empty project volume; never changes another cluster.
set -eu
psql --username "$POSTGRES_USER" --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE hackaton LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE hackaton OWNER hackaton;
CREATE DATABASE hackaton_test OWNER hackaton;
REVOKE ALL ON DATABASE hackaton FROM PUBLIC;
REVOKE ALL ON DATABASE hackaton_test FROM PUBLIC;
SQL
