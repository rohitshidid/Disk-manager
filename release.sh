#!/usr/bin/env bash
#
# Cut a release.
#
# Releasing is one act: changing the version in package.json. This script does
# that safely — checks the tree is clean and the tests pass, asks what kind of
# bump, commits and pushes — and then GitHub Actions takes over: it notices the
# new version has no tag, builds the DMG on a clean macOS runner, tags the
# commit and publishes the release.
#
# Nothing is tagged locally. That is deliberate: one mechanism, in one place,
# so a release can never half-happen because a tag went up without a build, or
# a build ran against a commit nobody tagged.
#
#   ./release.sh                 ask what to bump
#   ./release.sh patch|minor|major   skip the question
#   ./release.sh --dry-run       show what would happen and stop
#
set -euo pipefail

cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$OFF" "$BOLD" "$*" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

BUMP=""
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --dry-run|-n)      DRY_RUN=true ;;
    -h|--help)         sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                 die "unknown argument: $arg (expected patch, minor, major or --dry-run)" ;;
  esac
done

# ---------------------------------------------------------------- preflight

step "Checking the working tree"

command -v git >/dev/null || die "git is not installed."
command -v node >/dev/null || die "node is not installed."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "you are on '$BRANCH'. Releases are cut from main."
ok "on main"

# An unclean tree would get swept into the release commit, which is how a
# half-finished experiment ends up inside a 121 MB download.
if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/    /'
  die "the working tree has uncommitted changes. Commit or stash them first."
fi
ok "working tree is clean"

git fetch --quiet origin main
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse @{u} 2>/dev/null || echo "")"
BASE="$(git merge-base @ @{u} 2>/dev/null || echo "")"
if [ -z "$REMOTE" ]; then
  die "main is not tracking a remote branch."
elif [ "$LOCAL" = "$REMOTE" ]; then
  ok "up to date with origin/main"
elif [ "$LOCAL" = "$BASE" ]; then
  die "origin/main has commits you do not. Run 'git pull' first."
elif [ "$REMOTE" = "$BASE" ]; then
  ok "you have $(git rev-list --count @{u}..@) unpushed commit(s) — they will go out with this release"
else
  die "main and origin/main have diverged. Sort that out before releasing."
fi

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  ok "gh is authenticated (the run can be watched)"
  HAVE_GH=true
else
  warn "gh is not installed or not logged in — you will have to watch the build in the browser"
  HAVE_GH=false
fi

# ------------------------------------------------------------------- tests

step "Running the tests"
if $DRY_RUN; then
  warn "skipped for --dry-run"
else
  npm test --silent || die "tests failed. Nothing has been changed."
  ok "all tests passed"
fi

# ----------------------------------------------------------------- version

CURRENT="$(node -p "require('./package.json').version")"

next_version() {
  node -e "
    const [a,b,c] = require('./package.json').version.split('.').map(Number);
    const bump = process.argv[1];
    console.log(bump === 'major' ? [a+1,0,0].join('.')
              : bump === 'minor' ? [a,b+1,0].join('.')
              :                    [a,b,c+1].join('.'));
  " "$1"
}

if [ -z "$BUMP" ]; then
  step "What kind of release is this?"
  say "  current version: ${BOLD}$CURRENT${OFF}"
  say ""
  say "    ${BOLD}1${OFF}) patch  → $(next_version patch)   ${DIM}fixes, no behaviour anyone has to know about${OFF}"
  say "    ${BOLD}2${OFF}) minor  → $(next_version minor)   ${DIM}new features, still backwards compatible${OFF}"
  say "    ${BOLD}3${OFF}) major  → $(next_version major)   ${DIM}something people relied on has changed${OFF}"
  say ""
  printf '  choose [1/2/3, or q to quit]: '
  read -r choice
  case "$choice" in
    1|patch) BUMP=patch ;;
    2|minor) BUMP=minor ;;
    3|major) BUMP=major ;;
    q|Q|"")  say "  nothing changed."; exit 0 ;;
    *)       die "'$choice' is not one of the options." ;;
  esac
fi

NEW="$(next_version "$BUMP")"

# The workflow releases a version that has no tag. If this one already has one,
# the push would be silently ignored -- better to say so now than to leave
# somebody watching an Actions tab where nothing is going to happen.
if git rev-parse "v$NEW" >/dev/null 2>&1 || git ls-remote --tags --exit-code origin "v$NEW" >/dev/null 2>&1; then
  die "v$NEW is already tagged. Pick a different bump, or delete that tag."
fi

step "Releasing $CURRENT → $NEW  ($BUMP)"

if $DRY_RUN; then
  say ""
  say "  ${DIM}--dry-run: stopping here. This would have:${OFF}"
  say "  ${DIM}  · set package.json to $NEW${OFF}"
  say "  ${DIM}  · committed 'release: v$NEW'${OFF}"
  say "  ${DIM}  · pushed to origin/main${OFF}"
  say "  ${DIM}  · let CI build, tag v$NEW and publish the DMG${OFF}"
  say ""
  exit 0
fi

# --------------------------------------------------------------- do the work

npm version "$BUMP" --no-git-tag-version >/dev/null
ok "package.json and package-lock.json set to $NEW"

git add package.json package-lock.json
git commit --quiet -m "release: v$NEW"
ok "committed"

git push --quiet origin main
ok "pushed to origin/main"

# ------------------------------------------------------------------- watch

REPO_URL="$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')"

step "GitHub Actions is building the DMG"
say "  ${DIM}It tags v$NEW, builds on a clean macOS runner, and publishes.${OFF}"
say "  ${DIM}Usually about four minutes. Closing this terminal will not stop it.${OFF}"
say ""

if $HAVE_GH; then
  # The run takes a moment to appear after the push.
  sleep 8
  RUN_ID="$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")"
  if [ -n "$RUN_ID" ]; then
    gh run watch "$RUN_ID" --exit-status && BUILD_OK=true || BUILD_OK=false
    if $BUILD_OK; then
      say ""
      ok "${GREEN}v$NEW is published.${OFF}"
      say ""
      say "  download   $REPO_URL/releases/latest/download/DiskManager-arm64.dmg"
      say "  release    $REPO_URL/releases/tag/v$NEW"
      say "  website    https://rohitshidid.github.io/Disk-manager/"
      say ""
      say "  ${DIM}The website's Download button points at 'latest', so it is already${OFF}"
      say "  ${DIM}serving this build. Nothing else to do.${OFF}"
      say ""
    else
      say ""
      die "the build failed. See what went wrong with:

    gh run view $RUN_ID --log-failed

  package.json is already at $NEW and the commit is pushed, so once you have
  fixed the problem, push the fix — CI will notice v$NEW still has no tag and
  build it again. There is nothing to roll back."
    fi
  else
    warn "could not find the run; watch it at $REPO_URL/actions"
  fi
else
  say "  watch it at  $REPO_URL/actions"
  say ""
fi
