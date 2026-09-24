#!/bin/bash
# Registers the Doc Writer as a local connector for regular Claude desktop-app chats.
# The desktop app rewrites its settings file while running, so this waits for you
# to quit it (Cmd+Q), makes the change, then reopens it.
set -euo pipefail
C="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
SKILL="${DOC_WRITER_SKILL_DIR:-$HOME/.claude/skills/google-doc-writer}"
[ -f "$SKILL/gdoc_mcp.py" ] || { echo "run install.sh first"; exit 1; }
PY="$(command -v python3)"
echo "Quit the Claude desktop app now (Cmd+Q). Waiting..."
while pgrep -xq Claude; do sleep 2; done
sleep 2
[ -f "$C" ] || echo '{}' > "$C"
cp -p "$C" "$C.bak-before-doc-writer"
"$PY" - "$C" "$PY" "$SKILL/gdoc_mcp.py" <<'PYEOF'
import json, sys
p, py, server = sys.argv[1:4]
d = json.load(open(p))
d.setdefault("mcpServers", {})["google-doc-writer"] = {"command": py, "args": [server]}
json.dump(d, open(p, "w"), indent=2)
print("registered google-doc-writer")
PYEOF
open -a Claude
echo "Done. In a new chat, ask Claude to add a line to a Google Doc you can edit."
