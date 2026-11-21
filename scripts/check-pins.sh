#!/usr/bin/env bash
# Checks the two pins before anything deploys. Run from the install's root, after both
# checkouts: `cognitio-tooling` must be exactly at a release tag vX.Y.Z, and the
# `serverless-registry` HEAD must be an ancestor of origin/aggrega. Prints both pins and
# exits 0, or names the fault on stderr and exits 1.
set -euo pipefail

fail() {
  printf 'check-pins: %s\n' "$*" >&2
  exit 1
}

tooling=cognitio-tooling
registry=serverless-registry

# A checkout's own top level must be the directory: git walks up, so a directory inside the
# install's repository would otherwise pass for one. A change to a tracked file is refused
# too, since the deploy bundles the working files.
for dir in "$tooling" "$registry"; do
  [[ -d $dir ]] || fail "$dir is not a git checkout (no such directory)"
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || fail "$dir is not a git checkout"
  [[ $top == "$(cd "$dir" && pwd -P)" ]] || fail "$dir is not a git checkout (its repository is $top)"
  [[ -z $(git -C "$dir" status --porcelain --untracked-files=no) ]] ||
    fail "$dir has changes to tracked files; deploy a clean checkout"
done

# Every tag on the commit is judged: one matching tag is enough.
tag=
while IFS= read -r candidate; do
  if [[ $candidate =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    tag=$candidate
    break
  fi
done < <(git -C "$tooling" tag --points-at HEAD)
[[ -n $tag ]] || fail "$tooling is not exactly at a release tag vX.Y.Z (fetch its tags, and pin the tagged commit)"

head=$(git -C "$registry" rev-parse HEAD)
git -C "$registry" rev-parse --verify --quiet refs/remotes/origin/aggrega >/dev/null ||
  fail "$registry has no origin/aggrega (fetch the aggrega branch)"
git -C "$registry" merge-base --is-ancestor "$head" refs/remotes/origin/aggrega ||
  fail "$registry $head is not an ancestor of origin/aggrega"

printf 'cognitio-tooling %s\n' "$tag"
printf 'serverless-registry %s\n' "$head"
