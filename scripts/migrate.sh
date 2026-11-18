#!/usr/bin/env bash
# Run from Git Bash, Linux or WSL with access to the Linux Docker daemon.
set -euo pipefail
export MSYS_NO_PATHCONV=1
umask 077
die() { echo "$*" >&2; exit 1; }
[[ $# == 2 && ( $1 == backup || $1 == restore ) ]] || die 'Usage: bash scripts/migrate.sh backup|restore DIRECTORY'
action=$1
case $2 in /*) directory=$2 ;; *) directory=$PWD/$2 ;; esac
cd "$(dirname "$0")/.."
project=${COMPOSE_PROJECT_NAME:-qq-superagent}
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 'Invalid Compose project name'
state=${project}_state
image=qq-superagent-harness:local
compose=(docker compose -p "$project")
helper=(docker run --rm --network none --read-only --user 0:0)
docker image inspect "$image" >/dev/null || die 'Build the Compose images first.'
if command -v sha256sum >/dev/null; then sha=(sha256sum); else sha=(shasum -a 256); fi

if [[ $action == backup ]]; then
  [[ ! -e $directory ]] || die "Choose a new backup directory: $directory"
  docker volume inspect "$state" >/dev/null || die "Missing $state. Check COMPOSE_PROJECT_NAME."
  volumes=("$state")
  names=$(docker volume ls --format '{{.Name}}')
  while IFS= read -r name; do
    [[ $name =~ ^${project}-group-[a-f0-9]{32}-work$ ]] && volumes+=("$name")
  done <<< "$names"
  # A live SQLite file and its WAL must be copied at the same point in time.
  for volume in "${volumes[@]}"; do
    writers=$(docker ps -q --filter "volume=$volume")
    [[ -z $writers ]] || die "Stop the old deployment and its group workers first: $volume is mounted by a running container."
  done
  revision=$(git rev-parse HEAD)
  mkdir -p -- "$directory"
  cd "$directory"
  for volume in "${volumes[@]}"; do
    echo "Backing up $volume"
    "${helper[@]}" --mount "type=volume,src=$volume,dst=/data,readonly" --entrypoint tar "$image" -czpf - -C /data . > "$volume.tar.gz"
    "${sha[@]}" "$volume.tar.gz" >> SHA256SUMS.partial
  done
  printf '%s\n' "$revision" > REVISION
  mv SHA256SUMS.partial SHA256SUMS
  echo "Saved ${#volumes[@]} volume(s) to $directory"
  exit
fi

[[ -f $directory/SHA256SUMS && -f $directory/REVISION ]] || die 'Incomplete backup: missing checksum manifest or revision.'
revision=$(< "$directory/REVISION")
[[ $(git rev-parse HEAD) == "$revision" ]] || die "Restore using the original revision first: git checkout $revision"
volumes=()
seen_state=false
while read -r digest filename extra; do
  [[ $digest =~ ^[[:xdigit:]]{64}$ && -z $extra ]] || die 'Invalid checksum manifest'
  # GNU sha256sum on Windows marks binary files with an asterisk.
  filename=${filename#\*}
  volume=${filename%.tar.gz}
  [[ $filename == "$volume.tar.gz" ]] || die 'Invalid archive name'
  if [[ $volume == "$state" ]]; then seen_state=true
  elif [[ ! $volume =~ ^${project}-group-[a-f0-9]{32}-work$ ]]; then die "Unexpected volume or project: $filename"; fi
  for prior in "${volumes[@]}"; do [[ $prior != "$volume" ]] || die "Duplicate archive: $volume"; done
  volumes+=("$volume")
done < "$directory/SHA256SUMS"
[[ $seen_state == true ]] || die "Backup does not contain $state"
(cd "$directory" && "${sha[@]}" -c SHA256SUMS)
existing=$(docker volume ls --format '{{.Name}}')
for volume in "${volumes[@]}"; do
  if grep -Fxq -- "$volume" <<< "$existing"; then
    writers=$(docker ps -q --filter "volume=$volume")
    [[ -z $writers ]] || die "Destination is in use: $volume"
    entries=$("${helper[@]}" --mount "type=volume,src=$volume,dst=/data,readonly" --entrypoint ls "$image" -A /data)
    [[ -z $entries ]] || die "Destination must be empty: $volume"
  fi
done
# Let Compose create its own state volume and labels without starting QQ.
"${compose[@]}" create --no-build --no-recreate app
for volume in "${volumes[@]}"; do
  docker volume create "$volume" >/dev/null
  echo "Restoring $volume"
  "${helper[@]}" -i --mount "type=volume,src=$volume,dst=/data" --entrypoint tar "$image" --numeric-owner -xzpf - -C /data < "$directory/$volume.tar.gz"
done
echo "Restore complete. Start with: docker compose -p $project up -d"
