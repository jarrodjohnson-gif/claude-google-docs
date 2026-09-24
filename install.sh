#!/bin/bash
# Doc Writer installer (macOS). Safe to re-run: a second run updates the
# script and redeploys it at the same web address.
#
# Before running, the person must have (see README / the setup doc):
#   1. turned on "Google Apps Script API" at https://script.google.com/home/usersettings
#   2. Node.js and python3 installed
# During the run they approve two Google prompts:
#   - clasp sign-in (a browser page -> Allow)
#   - the script's own permissions (run `authorize` in the editor -> Allow)
set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"
CFG="${DOC_WRITER_HOME:-$HOME/.config/doc-writer}"
TOOL="$CFG/clasp-tool"
PROJ="$CFG/project"
SKILL="${DOC_WRITER_SKILL_DIR:-$HOME/.claude/skills/google-doc-writer}"
mkdir -p "$CFG" "$PROJ" && chmod 700 "$CFG"

step() { printf '\n== %s\n' "$*"; }

step "1/6 checking tools"
command -v node >/dev/null || { echo "Node.js is missing: install it from https://nodejs.org (or: brew install node)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is missing"; exit 1; }
node --version; python3 --version

step "2/6 clasp (Google's official Apps Script CLI), installed privately in $TOOL"
if [ ! -x "$TOOL/node_modules/.bin/clasp" ]; then
  mkdir -p "$TOOL"
  (cd "$TOOL" && printf '{"name":"clasp-tool","private":true}\n' > package.json && npm install --silent @google/clasp@3.4.1)
fi
CLASP="$TOOL/node_modules/.bin/clasp"
"$CLASP" --version

step "3/6 Google sign-in for clasp"
if [ ! -f "$HOME/.clasprc.json" ]; then
  echo "A Google sign-in link follows. Open it ON THIS MAC, choose your account, click Allow."
  "$CLASP" login
fi
"$CLASP" show-authorized-user || true

step "4/6 the Doc Writer script in your Google account"
if [ ! -f "$PROJ/.clasp.json" ]; then
  (cd "$PROJ" && "$CLASP" create-script --type standalone --title "${DOC_WRITER_TITLE:-Doc Writer}" --rootDir .)
fi
[ -s "$CFG/token" ] || (openssl rand -hex 16 > "$CFG/token")
chmod 600 "$CFG/token"
TOKEN="$(cat "$CFG/token")"
sed "s/REPLACE_WITH_THE_TOKEN_FROM_.appsscript-token/$TOKEN/" "$PKG/Code.gs" > "$PROJ/Code.js"
grep -q "$TOKEN" "$PROJ/Code.js" || { echo "token placeholder not found in Code.gs"; exit 1; }
cp "$PKG/appsscript.json" "$PROJ/appsscript.json"
(cd "$PROJ" && "$CLASP" push --force)

step "5/6 deploy as a web app"
if [ -s "$CFG/deployment" ]; then
  DEP="$(cat "$CFG/deployment")"
  (cd "$PROJ" && "$CLASP" create-deployment --deploymentId "$DEP" --description "Doc Writer update $(date '+%Y-%m-%d')")
else
  OUT="$(cd "$PROJ" && "$CLASP" create-deployment --description "Doc Writer")"
  echo "$OUT"
  DEP="$(echo "$OUT" | grep -oE 'AKfy[A-Za-z0-9_-]+' | head -1)"
  [ -n "$DEP" ] || { echo "could not read the deployment id"; exit 1; }
  echo "$DEP" > "$CFG/deployment"; chmod 600 "$CFG/deployment"
fi
echo "https://script.google.com/macros/s/$DEP/exec" > "$CFG/url"
chmod 600 "$CFG/url"

step "6/6 Claude skill"
mkdir -p "$SKILL"
cp "$PKG/gdoc.py" "$PKG/gdoc_mcp.py" "$PKG/SKILL.md" "$SKILL/"
rm -f "$SKILL/.server-version"

SCRIPT_ID="$(python3 -c "import json;print(json.load(open('$PROJ/.clasp.json'))['scriptId'])")"
cat <<EOF

Installed. ONE manual step is left - grant the script its permissions:
  1. Open https://script.google.com/d/$SCRIPT_ID/edit
  2. In the toolbar, pick the function "authorize", click Run
  3. Review permissions -> your account -> (Advanced -> Go to Doc Writer) -> Allow
  4. The log should end with "Web fetch for images: HTTP 200"
Then test:  python3 "$SKILL/gdoc.py" info <any Google Doc link you can edit>
Optional, for regular Claude desktop chats:  bash "$PKG/install_connector.sh"
EOF
