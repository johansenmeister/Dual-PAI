#!/usr/bin/env bash
# pai-setup.sh — Gitea set up for PAI (guide/gitea.md, Part 2).
#
# Usage, from the PAI folder:
#   bash guide/gitea/pai-setup.sh <user>@<host> --gitea-user <you> --org <org> --access tight|full
#   [--address <address>] [--repo pai]
#
# <user>@<host> is the Docker host running the "gitea" container (deploy.sh).
# --access tight: PAI keeps a token that can only write issues; a wider token is
#   used for the setup, and you delete it afterwards in Gitea's web page.
# --access full: PAI keeps one token with every scope (your account is Gitea's
#   administrator, so that is the whole server).
# Creates the organisation and a private repository (both may exist already),
# adds this machine's SSH key to your Gitea account, and writes GITEA_API_URL and
# GITEA_TOKEN to ~/.opencode/.env (PAI_ENV overrides). No token is ever shown.
# The last line is REPO=<the repository's SSH address>.
set -euo pipefail

TARGET="" ADDR="" GUSER="" ORG="" ACCESS="" REPO=pai
while [ $# -gt 0 ]; do
  case $1 in
    --address) ADDR=$2; shift 2 ;;
    --gitea-user) GUSER=$2; shift 2 ;;
    --org) ORG=$2; shift 2 ;;
    --access) ACCESS=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    *) TARGET=$1; shift ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

case $TARGET in *@*) ;; *) die "give the Docker host as <user>@<host> (see --help)" ;; esac
[ -n "$GUSER" ] || die "missing --gitea-user (your Gitea account)"
[ -n "$ORG" ] || die "missing --org"
case $ACCESS in tight | full) ;; *) die "--access must be tight or full" ;; esac
for n in "$GUSER" "$ORG" "$REPO"; do case $n in *[!A-Za-z0-9_.-]* | "") die "names may only have letters, digits, '.', '_' and '-': $n" ;; esac; done
[ -n "$ADDR" ] || ADDR=${TARGET#*@}
ENVF=${PAI_ENV:-$HOME/.opencode/.env}
KEY=$(ls ~/.ssh/id_ed25519.pub ~/.ssh/id_ecdsa.pub ~/.ssh/id_rsa.pub 2>/dev/null | head -1 || true)
[ -n "$KEY" ] || die "this machine has no SSH key. Make one: ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N \"\""
[ -f "$ENVF" ] || { touch "$ENVF" && chmod 600 "$ENVF"; }
U="http://$ADDR:3000"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "$TARGET")

gitea() { "${SSH[@]}" "docker exec -u git gitea gitea $*"; }
# set_env <token>: GITEA_API_URL and GITEA_TOKEN into the env file, nothing on screen.
set_env() {
  sed -i '/^GITEA_TOKEN=/d; /^GITEA_API_URL=/d' "$ENVF"
  printf 'GITEA_API_URL=%s\nGITEA_TOKEN=%s\n' "$U" "$1" >>"$ENVF"
}

say "Checking Gitea and the account"
curl -fsS "$U/api/v1/version" >/dev/null || die "Gitea does not answer on $U"
gitea admin user list 2>/dev/null | awk 'NR > 1 {print $2}' | grep -qx "$GUSER" ||
  die "Gitea has no user $GUSER. Create it first (deploy.sh prints the command)."
ok "$GUSER on $U"

stamp=$(date +%Y%m%d-%H%M%S)
if [ "$ACCESS" = full ]; then
  say "Making PAI's token: every scope"
  set_env "$(gitea admin user generate-access-token --username "$GUSER" --token-name "pai-$stamp" --scopes all --raw)"
  ST=$(sed -n 's/^GITEA_TOKEN=//p' "$ENVF")
else
  say "Making a token for the setup (organisation, repository, key)"
  ST=$(gitea admin user generate-access-token --username "$GUSER" --token-name "pai-setup-$stamp" \
    --scopes write:organization,write:user,write:repository --raw)
fi
[ -n "$ST" ] || die "Gitea did not make the token"
api() { curl -sS -K <(printf 'header = "Authorization: token %s"\n' "$ST") -H 'Content-Type: application/json' "$@"; }

say "The organisation, the repository and the key"
code=$(jq -n --arg o "$ORG" '{username: $o, visibility: "private"}' | api -o /dev/null -w '%{http_code}' -d @- "$U/api/v1/orgs")
case $code in 201) ok "organisation $ORG (private)" ;; 422) ok "organisation $ORG exists" ;; *) die "creating the organisation failed (HTTP $code)" ;; esac
code=$(jq -n --arg r "$REPO" '{name: $r, private: true, default_branch: "main"}' | api -o /dev/null -w '%{http_code}' -d @- "$U/api/v1/orgs/$ORG/repos")
case $code in 201) ok "repository $ORG/$REPO (private)" ;; 409) ok "repository $ORG/$REPO exists" ;; *) die "creating the repository failed (HTTP $code)" ;; esac
[ "$(api "$U/api/v1/repos/$ORG/$REPO" | jq -r .private)" = true ] || die "$ORG/$REPO is not private. Make it private in Gitea before going on."
code=$(jq -n --arg k "$(cat "$KEY")" --arg t "pai@$(hostname)" '{title: $t, key: $k}' | api -o /dev/null -w '%{http_code}' -d @- "$U/api/v1/user/keys")
case $code in 201) ok "this machine's key ($KEY)" ;; 422) ok "this machine's key is already there" ;; *) die "adding the key failed (HTTP $code)" ;; esac

if [ "$ACCESS" = tight ]; then
  say "Making PAI's token: issues only"
  set_env "$(gitea admin user generate-access-token --username "$GUSER" --token-name "pai-issues-$stamp" --scopes write:issue --raw)"
fi
unset ST
ok "GITEA_API_URL and GITEA_TOKEN are in $ENVF"

if [ "$ACCESS" = tight ]; then
  cat <<EOF

You do this: on $U, log in, Settings, Applications, and delete the token
pai-setup-$stamp. Gitea deletes a token only with your password.
EOF
fi
echo "REPO=ssh://git@$ADDR:2222/$ORG/$REPO.git"
