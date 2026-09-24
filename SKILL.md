---
name: google-doc-writer
description: Edit an existing Google Doc - add text anywhere (end of doc, inside a section, after a paragraph), find and replace, delete lines or sections, add/edit/delete table rows and cells, numbered/nested/checkbox lists, any tab - through the user's own Doc Writer Apps Script. Use whenever the user gives a docs.google.com/document link (or doc ID) and asks to add, append, write, put, log, insert, update or replace something in it, e.g. "add this bug to my QA log", "add a line called testing to this doc", "rewrite the Change log section", "mark lead 1234 Done in the table", "fix the typo in line X". Prefer this over typing into the doc with Chrome. Not for creating brand-new docs (use the Google Drive connector).
---

# Google Doc writer

Stock Claude connectors cannot edit an existing Google Doc. The Doc Writer is an Apps Script web app in the
user's own Google account that edits any Doc they can edit. It takes markdown in one HTTP POST, so the doc
never passes through your context - cheap and fast.

## Run it

```bash
python3 ~/.claude/skills/google-doc-writer/gdoc.py <command> <doc-link-or-id> ...
```

A `?tab=t.xxx` in the link targets that tab. `python3 gdoc.py -h` prints every flag.

| Command | Does | Writes? |
|---|---|---|
| `info <doc>` | numbered map: headings, paragraphs, list items, tables (with header cells), all tabs | no |
| `markdown <doc>` | the whole tab as markdown | no |
| `read <doc> --heading "H"` | one section's text | no |
| `check "md"` | what the markdown would render | no |
| `table <doc> read [--table-index N]` | a table's cells | no |
| `append <doc> "md"` | adds at the very end | yes |
| `insert <doc> "md" --heading "H" [--where end/start/before]` | adds inside a section, deletes nothing | yes |
| `insert <doc> "md" --after "exact paragraph text"` (or `--before`) | adds next to a paragraph | yes |
| `find-replace <doc> --find X --with Y [--expect N] [--heading H]` | fixes text in place, keeps formatting | yes |
| `delete <doc> --text "exact text"` / `--heading "H"` | removes paragraphs / a section | yes |
| `table <doc> append-row --cells A B C` | new row, styled like the last one | yes |
| `table <doc> update-cell --match-row "Lead 1234" --col Status --text Done` | edits one cell | yes |
| `table <doc> insert-row --at N --cells ...` / `delete-row --match-row X` | row edits | yes |
| `replace <doc> --heading "H" --file f.md` | swaps a whole section | yes |

Table selectors: `--table-index N` (from `info`), `--table-header Status`, `--table-heading "Bugs"`.
Flag values that start with `-` go as `--find=- item`.

### v3 / v4 commands

| Command | Does |
|---|---|
| `style <doc> --find X [--line] --strike on / --highlight yes / --color #hex / --bold on ...` | restyle existing text |
| `mention <doc> --find "Sam" --email sam@example.com` (or `--date YYYY-MM-DD`) | turn text into a person/date chip |
| `table <doc> color --match done --col Status --color "#dcfce7" [--whole-row]` | shade cells/rows |
| `table <doc> add-column --header Due --after Status [--value TBD]` / `delete-column --col Due` | columns |
| `table <doc> widths --width Lead=60` / `merge --row 1 --col 0 --cols 2` / `unmerge ...` | layout |
| `doc-style <doc> --preset clean` / `--style "h2:bold=true,size=16"` | the doc's own heading/body styles |
| `page <doc> --margins 54 / --landscape / --size a4 / --background #hex` | page setup |
| `link-heading <doc> --find "see Bugs" --to "Bugs"` | internal link to a heading |
| `header` / `footer <doc> "text"` | set (empty = clear) |
| `tabs <doc> list / add --title T --emoji E / rename --tab-id t.x --title T` | tabs |
| `delete-tab <doc> --tab-id t.x --confirm-title "Exact title"` | ASK the user first |
| `comments <doc> [--open]` / `comment <doc> "text"` / `reply` / `resolve --comment-id ID` | comments (added ones attach to the whole doc) |
| `copy <template> --title "New"` then `fill <new> --set key=value` | templates with {{key}} placeholders |
| `copy-section <doc> --from <other> --from-heading H --heading Here` | copy a section, formatting intact |
| `batch <doc> --file ops.json` | several webhook payloads in one request |
| `upload <file> --folder <Drive folder link>` | save a local file (PDF, zip, image) into Drive |

Inline markdown extras: `~~strike~~`, `==highlight==`, `@[email]` person chip, `@date(2026-09-30)` or
`@date(2026-09-30 14:00)` date chip, `@file(https://docs.google.com/...)` file chip, `[^text]` footnote,
a line `[[pagebreak]]`, a line `![alt](https://...)` image from the web or a Drive file link
(`![alt|300](...)` caps the width at 300 pt; PNG/JPEG/GIF only). Several tables share a header name? Use `--table-heading "Section"` or `--table-index N`.

## Procedure

1. `info` first - it shows exact heading text, table numbers and tabs.
2. Pick the **smallest** edit: `find-replace` for a word or line, `insert` to add inside a
   section, `table` for rows/cells. `replace` rewrites a section and loses its comments - last resort.
3. Guard risky edits: `find-replace --expect 1`, `delete --text` (refuses on several matches
   unless `--all`).
4. Read back what you changed (`read`, `table read`, or `info`) and tell the user where it landed.

## Rules

- There is no clear command. The webhook refuses a non-append `rebuild` on any doc unless sent
  `confirmClear: true` - never send it.
- Commands other than info/read/check/append/replace need Apps Script v2. On v1, gdoc.py refuses
  them before sending anything (v1 treated unknown modes as "clear the doc"). If you see
  "needs the updated Apps Script", tell the user it needs redeploying.
- Retries are automatic and safe: v2 remembers each write's id, so a retry can't write twice.
- Checklists (`- [ ]`) are created unticked; the API cannot tick a box.
- Suggestion mode and comments anchored to a phrase are NOT possible (Google preview program only).
- Never print, echo or paste the token (`.appsscript-token`) or webhook URL.
- A doc the user cannot edit fails with a permission error - say so, don't retry.

## Markdown it accepts

Headings `#` `##` `###`, paragraphs, `- ` bullets, `**bold**`, `*italic*`, `` `code` ``,
`[text](url)`, tables (`| a | b |` with matching pipe counts), `> [!NOTE]` / `> [!WARNING]` /
`> [!KEY]` callouts (blank line between them), `> ` quotes, fenced code, `---` rules,
`![alt](data:image/png;base64,...)` images (data URIs only).

Plain docs also get: `#` to `######` headings, one paragraph per line, `1. ` numbered lists,
2-space indent to nest, `- [ ] ` checklists. Not supported: table of contents,
nested inline formatting (`**bold `code`**`).

## Files

- Settings: `~/.config/doc-writer/url` and `token` (written by install.sh)
- Script project: `~/.config/doc-writer/project/` (update with `install.sh` again - it redeploys in place)
- Desktop connector: `gdoc_mcp.py` in this folder, registered as `google-doc-writer` in
  `~/Library/Application Support/Claude/claude_desktop_config.json` by `install_connector.sh`.
