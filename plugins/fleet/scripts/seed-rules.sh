#!/bin/sh
# Copies the shipped default rules into the plugin's data directory the first
# time a session starts, so the working file lives outside the versioned
# plugin cache and survives updates. An existing file is left untouched.
#
# Usage: seed-rules.sh <plugin-root> <data-dir>

set -eu

usage='usage: seed-rules.sh <plugin-root> <data-dir>'
plugin_root=${1:?$usage}
data_dir=${2:?$usage}
target="$data_dir/fleet.json"

[ -f "$target" ] && exit 0

mkdir -p "$data_dir"
cp "$plugin_root/fleet.default.json" "$target"
echo "fleet: rules seeded at $target from the plugin default. Edit that file to change the policy; plugin updates leave it alone."
