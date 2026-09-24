# Doc Writer

Lets Claude edit your Google Docs directly, without typing into them through a browser. It can add text
anywhere, find and replace, work with tables, insert people, date and file chips, handle comments, fill
templates, add images, change styles and more.

## Install

Tell Claude Code:

> Install the Doc Writer from https://github.com/jarrodjohnson-gif/doc-writer

Claude follows [INSTALL.md](INSTALL.md) and does the work. You'll turn on one Google setting and click
**Allow** on two Google prompts. It takes about 20 minutes. You need a Mac, Node.js and python3.

## How it works

- **`Code.gs` + `appsscript.json`** are a Google Apps Script web app that runs as **you**, in your own
  Google account, so it can edit any doc you can edit. It needs no Cloud project and no admin approval.
  Each install gets its own private token.
- **`gdoc.py`** is the command-line helper Claude calls. Run `python3 gdoc.py -h` for every command.
- **`SKILL.md`** teaches Claude Code when and how to use it.
- **`gdoc_mcp.py`** is an optional connector for regular Claude desktop chats (`install_connector.sh`).
- **`install.sh`** installs or updates everything using clasp, Google's official Apps Script CLI. It is
  safe to re-run.

## What it can't do

These are Google API limits: suggestion mode, comments pinned to a phrase, inserting a table of
contents, page numbers, and pre-ticked checkboxes. It also doesn't work from claude.ai in a browser or
the phone app. It needs Claude running on your Mac.
