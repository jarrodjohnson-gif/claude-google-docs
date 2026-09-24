# Installing the Doc Writer - instructions for Claude

*For an AI agent (Claude Code or similar) installing the Doc Writer for its user on macOS.
Follow the steps in order. Stop and ask the user whenever a step needs them.*

## Rules

- Read `install.sh` and `README.md` in full before running anything. Never run a script you have not read.
- Never print, paste or log `~/.config/doc-writer/token` or `url`.
- **Granting Google permissions is the user's decision.** On any Google consent screen ("Allow",
  "Review permissions", "Go to ... (unsafe)"), let the user click, or click only after they say yes to
  that exact screen in chat.
- Ask before any destructive document action (deleting sections or tabs, sharing docs).

## Steps

1. **Get the code.**
   `git clone https://github.com/jarrodjohnson-gif/doc-writer ~/.config/doc-writer/src`
   (If it already exists: `git -C ~/.config/doc-writer/src pull`.)

2. **Check tools.** `node --version` (18 or newer) and `python3 --version`. If Node is missing, ask the
   user to install it from https://nodejs.org, or with their approval run `brew install node`.

3. **Turn on the Apps Script API** (one toggle, needed once).
   - Ask the user to open https://script.google.com/home/usersettings and switch
     **Google Apps Script API** to **On**.
   - *With Claude in Chrome:* offer to do it. With a yes, open that page in their Chrome, take a
     screenshot, click the toggle, and screenshot again to confirm it reads **On**.

4. **Run the installer in the background:** `bash ~/.config/doc-writer/src/install.sh`, and read its
   output as it goes.
   - At step 3/6 it prints a Google sign-in link for **clasp** (Google's official Apps Script tool).
     It must be opened **on this Mac**, because it redirects to `localhost`.
   - Give the link to the user. *With Claude in Chrome:* open it in their Chrome and let them choose
     the account and click **Allow**.
   - Wait for **You are logged in as ...**.
   - If the page says **Access blocked** or **admin_policy_enforced**, stop and report: their
     organisation blocks clasp.

5. **Grant the script its permissions.** When the installer finishes it prints
   `https://script.google.com/d/<id>/edit`.
   - The user opens it (reloading it if it was already open), picks **authorize** in the function
     dropdown next to **Run**, clicks **Run**, then **Review permissions**, their account, and **Allow**.
     If Google says the app is unverified: **Advanced > Go to Doc Writer**. It is their own script.
   - *With Claude in Chrome:* open the link, select **authorize**, and click **Run** for them; the
     consent clicks follow the rule above.
   - The execution log should end with **Web fetch for images: HTTP 200**.

6. **Verify.** Ask for a doc link the user can edit, then run
   `python3 ~/.claude/skills/google-doc-writer/gdoc.py info <link>`. It prints the doc's headings.
   - **refused access (HTTP 403)** means step 5 is not done yet.
   - With the user's OK, append a test line, read it back, and delete it:
     `gdoc.py append <link> "Doc Writer test"`, then `gdoc.py delete <link> --text "Doc Writer test"`.

7. **Optional: regular Claude desktop chats.** Run `bash ~/.config/doc-writer/src/install_connector.sh`.
   It waits for the user to quit the Claude desktop app (Cmd+Q) and reopens it. If you are running
   inside the desktop app, warn the user first: quitting ends this session.

8. **Tell the user what works now:**
   - Claude Code and Cowork use the skill automatically.
   - Desktop chats use the connector, if step 7 was done.
   - claude.ai in a browser or the phone app cannot use it.
   - Try: "add a line saying hello to <doc link>".

## Updating

`git -C ~/.config/doc-writer/src pull && bash ~/.config/doc-writer/src/install.sh`

This redeploys at the same web address. If the update adds a Google permission, the user reloads the
script tab and runs **authorize** once more.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `refused access (HTTP 403)` | permissions not granted: step 5 |
| Access blocked / admin policy at sign-in | the organisation blocks clasp; stop |
| No consent popup when running authorize | the editor tab was stale: reload it and run again |
| `needs the updated Apps Script` | re-run install.sh |
| `webhook refused: bad token`, once | a transient Google hiccup; the helper retries |
| A chip shows as plain text | that chip type failed; the rest of the edit still applied |
