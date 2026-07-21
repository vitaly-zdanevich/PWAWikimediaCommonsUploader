#!/usr/bin/env bash
set -euo pipefail

apt_root="/layers/fagiani_apt/apt"
library_paths=()

for root in "$apt_root/lib/x86_64-linux-gnu" "$apt_root/usr/lib/x86_64-linux-gnu"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r directory; do
    library_paths+=("$directory")
  done < <(find "$root" -maxdepth 2 -type d -print)
done

if ((${#library_paths[@]})); then
  apt_library_path="$(IFS=:; printf '%s' "${library_paths[*]}")"
  export LD_LIBRARY_PATH="$apt_library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

exec ./target/release/commons-format-converter
