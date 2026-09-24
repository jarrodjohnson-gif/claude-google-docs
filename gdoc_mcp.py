#!/usr/bin/env python3
"""Local MCP connector for the Claude desktop app: exposes gdoc.py as tools.

Stdio, newline-delimited JSON-RPC, stdlib only. Each tool call runs gdoc.py in a
subprocess, so the connector and the CLI can never disagree about behaviour.
"""
import json, os, subprocess, sys

GDOC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gdoc.py")

FORMAT = ("Markdown accepted: # to ###### headings, one paragraph per line, '- ' bullets, '1. ' numbered, indent 2 spaces to nest, '- [ ] ' checklist, **bold**, *italic*, "
          "`code`, [text](url), tables (| a | b | with a |---|---| separator row, matching pipe counts), "
          "'> [!NOTE] text' / '> [!WARNING] text' / '> [!KEY] text' callouts (blank line between them), "
          "'> ' quotes, fenced code, --- rules, ~~strike~~, ==highlight==, @[person@email] person chip, "
          "@date(2026-09-30) or @date(2026-09-30 14:00) date chip, @file(https://docs.google.com/...) file chip, "
          "[^footnote text] footnote, a line [[pagebreak]], a line ![alt|width](https://image-or-drive-link) image. "
          "Not supported: nested inline formatting.")

DOC = {"type": "string", "description": "Google Docs link (docs.google.com/document/d/...) or bare document ID"}
HEADING = {"type": "string", "description": "Exact text of an existing heading - get it from gdoc_info"}
MD = {"type": "string", "description": FORMAT}

def tool(name, desc, props, req):
    return {"name": name, "description": desc,
            "inputSchema": {"type": "object", "properties": props, "required": req}}


S = lambda d: {"type": "string", "description": d}
I = lambda d: {"type": "integer", "description": d}
B = lambda d: {"type": "boolean", "description": d}
TSEL = {"table_index": I("0-based table number, from gdoc_info"),
        "table_header": S("text of a header cell that identifies the table, e.g. 'Status'"),
        "table_heading": S("use the first table under this heading")}

TOOLS = [
    tool("gdoc_info", "Read-only. Numbered map of the doc: headings, paragraphs, list items, tables (with "
         "header cells) and all tabs. Call first - it gives exact heading text, table numbers and tab ids.",
         {"doc": DOC}, ["doc"]),
    tool("gdoc_markdown", "Read-only. The whole doc (or linked tab) as markdown.", {"doc": DOC}, ["doc"]),
    tool("gdoc_read_section", "Read-only. Plain text of one heading's section.",
         {"doc": DOC, "heading": HEADING}, ["doc", "heading"]),
    tool("gdoc_append", "Adds markdown at the very END of the doc. Nothing else changes.",
         {"doc": DOC, "markdown": MD}, ["doc", "markdown"]),
    tool("gdoc_insert", "Inserts markdown inside the doc without deleting anything: at the end/start of a "
         "heading's section, or right after/before a paragraph matched by its exact text. The right tool "
         "for 'add this to the Bugs section'.",
         {"doc": DOC, "markdown": MD, "heading": HEADING,
          "where": {"type": "string", "enum": ["end", "start", "before"],
                    "description": "with heading: end of section (default), just under the heading, or before it"},
          "after_text": S("insert after the paragraph with exactly this text"),
          "before_text": S("insert before the paragraph with exactly this text"),
          "contains": B("match after_text/before_text as a substring")}, ["doc", "markdown"]),
    tool("gdoc_replace_section", "Removes a heading and everything under it (including sub-sections) and "
         "writes the markdown in its place. The markdown must begin with the heading line itself. Comments "
         "inside the section are lost. Prefer gdoc_insert or gdoc_find_replace for small changes.",
         {"doc": DOC, "heading": HEADING, "markdown": MD}, ["doc", "heading", "markdown"]),
    tool("gdoc_find_replace", "Find and replace text, keeping the surrounding formatting. Literal and "
         "case-sensitive by default. Use for typos, status words, renames, or fixing a line. An empty "
         "replacement deletes the text. Refuses (changing nothing) if the count differs from expect.",
         {"doc": DOC, "find": S("text to find"), "replace": S("replacement text"),
          "regex": B("treat find as an RE2 regex"), "ignore_case": B("case-insensitive"),
          "heading": S("only inside this heading's section"),
          "expect": I("required number of matches - set it to guard against over-replacing"),
          "all": B("allow more than 50 replacements")}, ["doc", "find", "replace"]),
    tool("gdoc_delete", "Deletes a heading's whole section, or paragraphs/list items by exact text. Several "
         "matches need all=true. Returns what was removed.",
         {"doc": DOC, "heading": S("delete this heading and its section"),
          "text": S("delete the paragraph(s) with exactly this text"),
          "contains": B("match text as a substring"), "all": B("delete every match")}, ["doc"]),
    tool("gdoc_table", "Reads or edits an existing table. op: read | append_row | insert_row | update_cell | "
         "delete_row. Rows are 0-based and row 0 is the header. Find a row by number or by the text in its "
         "first cell (match_row); name columns by header text or number. New rows copy the look of the row "
         "next to them.",
         dict(TSEL, **{"doc": DOC,
          "op": {"type": "string", "enum": ["read", "append_row", "insert_row", "update_cell", "delete_row",
                                            "color", "add_column", "delete_column", "merge", "unmerge", "widths"]},
          "match": S("color: cell text to match"), "color": S("color: '#hex' or 'none'"),
          "whole_row": B("color: shade the whole row"), "contains": B("color: substring match"),
          "header": S("add_column: header text"), "value": S("add_column: value for every body cell"),
          "after": S("add_column: insert after this column"), "before": S("add_column: insert before this column"),
          "rows": I("merge/unmerge: rows spanned"), "cols": I("merge/unmerge: columns spanned"),
          "widths": {"type": "object", "description": "widths: {column name or number: points}"},
          "cells": {"type": "array", "items": {"type": "string"}, "description": "cell texts for a new row (markdown ok)"},
          "at": I("insert_row: row position (1 = first row under the header)"),
          "row": I("row number"), "match_row": S("find the row whose match_col cell has exactly this text"),
          "match_col": S("column for match_row (header text or number, default first column)"),
          "col": S("update_cell: column header text or number"), "text": S("update_cell: new cell text")}),
         ["doc", "op"]),
    tool("gdoc_doc_style", "Changes the doc's own named styles so every heading/body paragraph changes at once. "
         "preset='clean' (bold Arial headings) or styles={h1..h6|normal|title: {bold, italic, size, font, color, spaceAbove, spaceBelow}}.",
         {"doc": DOC, "preset": {"type": "string", "enum": ["clean"]}, "styles": {"type": "object"}}, ["doc"]),
    tool("gdoc_page", "Page setup: margins (points, all four or per side), landscape true/false, background '#hex'/'none', size letter|a4|legal.",
         {"doc": DOC, "margins": {"type": "number"}, "landscape": B("landscape (false = portrait)"),
          "background": S("'#hex' or 'none'"), "size": {"type": "string", "enum": ["letter", "a4", "legal"]}}, ["doc"]),
    tool("gdoc_link_heading", "Turns text into a link that jumps to a heading in the same doc/tab.",
         {"doc": DOC, "find": S("text to turn into the link"), "to": S("exact heading text"),
          "expect": I("required match count")}, ["doc", "find", "to"]),
    tool("gdoc_delete_tab", "Deletes a tab (and its child tabs). Destructive: confirm_title must repeat the tab's exact title. "
         "Ask the user before calling.",
         {"doc": DOC, "tab_id": S("from gdoc_tabs list"), "confirm_title": S("exact title of the tab")},
         ["doc", "tab_id", "confirm_title"]),
    tool("gdoc_style", "Restyles EXISTING text found by find (all matches, or the whole line with line=true): "
         "bold/italic/underline/strike true|false, color '#hex' or 'none', highlight 'yes' (yellow) / '#hex' / 'none', "
         "size, font, link url or 'none'. E.g. strike through a fixed bug, highlight open leads.",
         {"doc": DOC, "find": S("text to find"), "line": B("style the whole line/list item containing each match"),
          "bold": B("bold on/off"), "italic": B("italic on/off"), "underline": B("underline on/off"),
          "strike": B("strikethrough on/off"), "color": S("text colour #hex or 'none'"),
          "highlight": S("'yes', '#hex', or 'none'"), "size": {"type": "number"}, "font": S("font family"),
          "link": S("url or 'none'"), "heading": S("only inside this section"),
          "expect": I("required match count"), "regex": B("RE2 regex"), "ignore_case": B("case-insensitive"),
          "all": B("allow more than 50")}, ["doc", "find"]),
    tool("gdoc_mention", "Turns existing text into a smart chip: a person chip (email) or a date chip (date "
         "YYYY-MM-DD). E.g. replace 'Sam' with their person chip. For NEW text use @[email] / @date(...) in markdown.",
         {"doc": DOC, "find": S("exact text to turn into the chip"), "email": S("person's email"),
          "date": S("YYYY-MM-DD"), "expect": I("required match count"), "heading": S("only inside this section"),
          "all": B("allow more than 50")}, ["doc", "find"]),
    tool("gdoc_header_footer", "Sets the document's header or footer text (empty text clears it).",
         {"doc": DOC, "which": {"type": "string", "enum": ["header", "footer"]}, "text": S("plain text")},
         ["doc", "which"]),
    tool("gdoc_tabs", "Lists, adds or renames document tabs. op=list | add (title, emoji, parent) | rename (tab_id, title, emoji).",
         {"doc": DOC, "op": {"type": "string", "enum": ["list", "add", "rename"]}, "title": S("tab title"),
          "tab_id": S("for rename, e.g. t.abc123"), "emoji": S("single emoji icon"), "parent": S("parent tab id")},
         ["doc", "op"]),
    tool("gdoc_copy", "Copies a doc (e.g. a template) under a new title and returns the new doc's link. "
         "Follow with gdoc_fill on the copy.",
         {"doc": DOC, "title": S("title for the copy"), "folder": S("optional Drive folder id")}, ["doc", "title"]),
    tool("gdoc_fill", "Fills {{placeholder}} fields in a doc's body, header and footer. Reports placeholders "
         "not found and ones still unfilled.",
         {"doc": DOC, "values": {"type": "object", "description": "{\"address\": \"123 Main St\", ...}"}},
         ["doc", "values"]),
    tool("gdoc_copy_section", "Copies a heading's section from another doc into this one, formatting intact, "
         "at the end/start of a heading here or after/before a paragraph.",
         {"doc": DOC, "from_doc": S("source doc link"), "from_heading": S("heading in the source doc"),
          "heading": S("target heading here"), "where": {"type": "string", "enum": ["end", "start", "before"]},
          "after_text": S("insert after this paragraph"), "before_text": S("insert before this paragraph")},
         ["doc", "from_doc", "from_heading"]),
    tool("gdoc_batch", "Runs several edits in one request, in order, stopping at the first failure. ops is a list "
         "of webhook payloads, e.g. {\"mode\": \"replaceText\", \"find\": \"a\", \"replace\": \"b\"}, "
         "{\"mode\": \"style\", ...}, {\"mode\": \"table\", \"op\": \"updateCell\", ...}, "
         "{\"mode\": \"insert\", \"heading\": ..., \"markdown\": ...}.",
         {"doc": DOC, "ops": {"type": "array", "items": {"type": "object"}}}, ["doc", "ops"]),
    tool("gdoc_comments", "Doc comments. op=list (optionally open_only) | add (text; attaches to the whole doc, "
         "not to a phrase) | reply (comment_id, text) | resolve (comment_id, optional text).",
         {"doc": DOC, "op": {"type": "string", "enum": ["list", "add", "reply", "resolve"]},
          "text": S("comment or reply text"), "comment_id": S("from op=list"), "open_only": B("list only unresolved")},
         ["doc", "op"]),
]

INSTRUCTIONS = ("Edits existing Google Docs as you, through your own Doc Writer Apps Script. Use it whenever "
                "the user wants something added to or changed in a Google Doc they link. Prefer it over "
                "typing into the doc in a browser. Links with ?tab= target that tab. Call gdoc_info first to see "
                "the structure; prefer the smallest edit (find_replace, insert, table) over replacing sections. "
                "It cannot clear a doc. Tell the user where the change landed.")


def run(args, stdin=None):
    # input="" rather than None: gdoc.py must never inherit this server's own
    # stdin, which is the JSON-RPC channel.
    p = subprocess.run([sys.executable, GDOC] + args, input=stdin if stdin is not None else "",
                       capture_output=True, text=True, timeout=300)
    out = (p.stdout + p.stderr).strip()
    return out or "(no output)", p.returncode != 0


def call(name, a):
    d = a["doc"]
    if name == "gdoc_info":
        return run(["info", d])
    if name == "gdoc_markdown":
        return run(["markdown", d])
    if name == "gdoc_read_section":
        return run(["read", d, "--heading=" + a["heading"]])
    if name == "gdoc_append":
        return run(["append", d], a["markdown"])
    if name == "gdoc_replace_section":
        return run(["replace", d, "--heading=" + a["heading"]], a["markdown"])
    if name == "gdoc_insert":
        args = ["insert", d]
        if a.get("heading"):
            args += ["--heading=" + a["heading"], "--where=" + a.get("where", "end")]
        elif a.get("after_text") is not None:
            args += ["--after=" + a["after_text"]]
        elif a.get("before_text") is not None:
            args += ["--before=" + a["before_text"]]
        if a.get("contains"):
            args.append("--contains")
        return run(args, a["markdown"])
    if name == "gdoc_find_replace":
        args = ["find-replace", d, "--find=" + a["find"], "--with=" + a.get("replace", "")]
        args += [f for f, k in (("--regex", "regex"), ("--ignore-case", "ignore_case"), ("--all", "all")) if a.get(k)]
        if a.get("heading"):
            args += ["--heading=" + a["heading"]]
        if a.get("expect") is not None:
            args.append("--expect=" + str(a["expect"]))
        return run(args)
    if name == "gdoc_delete":
        args = ["delete", d]
        if a.get("heading"):
            args += ["--heading=" + a["heading"]]
        elif a.get("text") is not None:
            args += ["--text=" + a["text"]]
        args += [f for f, k in (("--contains", "contains"), ("--all", "all")) if a.get(k)]
        return run(args)
    if name == "gdoc_table":
        args = ["table", d, a["op"].replace("_", "-")]
        for k, flag in (("table_index", "--table-index"), ("table_header", "--table-header"),
                        ("table_heading", "--table-heading"), ("at", "--at"), ("row", "--row"),
                        ("match_row", "--match-row"), ("match_col", "--match-col"), ("col", "--col"),
                        ("text", "--text"), ("match", "--match"), ("color", "--color"), ("header", "--header"),
                        ("value", "--value"), ("after", "--after"), ("before", "--before"), ("rows", "--rows"),
                        ("cols", "--cols")):
            if a.get(k) is not None:
                args.append(flag + "=" + str(a[k]))
        if a.get("whole_row"):
            args.append("--whole-row")
        if a.get("contains"):
            args.append("--contains")
        for k, v in (a.get("widths") or {}).items():
            args.append("--width=" + str(k) + "=" + str(v))
        if a.get("cells") is not None:
            args += ["--cells"] + [str(c) for c in a["cells"]]
        return run(args)
    if name == "gdoc_doc_style":
        args = ["doc-style", d]
        if a.get("preset"):
            args.append("--preset=" + a["preset"])
        for nm, st in (a.get("styles") or {}).items():
            args.append("--style=" + nm + ":" + ",".join(k + "=" + str(v).lower() if isinstance(v, bool) else k + "=" + str(v)
                                                         for k, v in st.items()))
        return run(args)
    if name == "gdoc_page":
        args = ["page", d]
        if a.get("margins") is not None:
            args.append("--margins=" + str(a["margins"]))
        if a.get("landscape") is True:
            args.append("--landscape")
        elif a.get("landscape") is False:
            args.append("--portrait")
        for k in ("background", "size"):
            if a.get(k):
                args.append("--" + k + "=" + a[k])
        return run(args)
    if name == "gdoc_link_heading":
        args = ["link-heading", d, "--find=" + a["find"], "--to=" + a["to"]]
        if a.get("expect") is not None:
            args.append("--expect=" + str(a["expect"]))
        return run(args)
    if name == "gdoc_delete_tab":
        return run(["delete-tab", d, "--tab-id=" + a["tab_id"], "--confirm-title=" + a["confirm_title"]])
    if name == "gdoc_style":
        args = ["style", d, "--find=" + a["find"]]
        for k in ("bold", "italic", "underline", "strike"):
            if a.get(k) is not None:
                args.append("--" + k + "=" + ("on" if a[k] else "off"))
        for k in ("color", "highlight", "size", "font", "link", "heading", "expect"):
            if a.get(k) is not None:
                args.append("--" + k + "=" + str(a[k]))
        args += [f for f, k in (("--line", "line"), ("--regex", "regex"), ("--ignore-case", "ignore_case"), ("--all", "all")) if a.get(k)]
        return run(args)
    if name == "gdoc_mention":
        args = ["mention", d, "--find=" + a["find"]]
        for k in ("email", "date", "heading", "expect"):
            if a.get(k) is not None:
                args.append("--" + k + "=" + str(a[k]))
        if a.get("all"):
            args.append("--all")
        return run(args)
    if name == "gdoc_header_footer":
        return run([a["which"], d], a.get("text", ""))
    if name == "gdoc_tabs":
        args = ["tabs", d, a["op"]]
        for k, flag in (("title", "--title"), ("tab_id", "--tab-id"), ("emoji", "--emoji"), ("parent", "--parent")):
            if a.get(k):
                args.append(flag + "=" + a[k])
        return run(args)
    if name == "gdoc_copy":
        return run(["copy", d, "--title=" + a["title"]] + (["--folder=" + a["folder"]] if a.get("folder") else []))
    if name == "gdoc_fill":
        args = ["fill", d]
        for k, v in (a.get("values") or {}).items():
            args.append("--set=" + str(k) + "=" + str(v))
        return run(args)
    if name == "gdoc_copy_section":
        args = ["copy-section", d, "--from=" + a["from_doc"], "--from-heading=" + a["from_heading"]]
        if a.get("heading"):
            args += ["--heading=" + a["heading"], "--where=" + a.get("where", "end")]
        elif a.get("after_text") is not None:
            args.append("--after=" + a["after_text"])
        elif a.get("before_text") is not None:
            args.append("--before=" + a["before_text"])
        return run(args)
    if name == "gdoc_batch":
        return run(["batch", d], json.dumps(a.get("ops") or []))
    if name == "gdoc_comments":
        op = a["op"]
        if op == "list":
            return run(["comments", d] + (["--open"] if a.get("open_only") else []))
        if op == "add":
            return run(["comment", d], a.get("text", ""))
        return run([op, d, "--comment-id=" + a.get("comment_id", "")], a.get("text", ""))
    return f"unknown tool {name}", True


def reply(i, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": i}
    if error:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    try:
        m = json.loads(line)
    except ValueError:
        continue
    method, i = m.get("method"), m.get("id")
    if i is None:
        continue
    if method == "initialize":
        reply(i, {"protocolVersion": m.get("params", {}).get("protocolVersion", "2025-06-18"),
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "google-doc-writer", "version": "4.0"},
                  "instructions": INSTRUCTIONS})
    elif method == "tools/list":
        reply(i, {"tools": TOOLS})
    elif method == "tools/call":
        p = m.get("params", {})
        try:
            text, err = call(p.get("name"), p.get("arguments") or {})
        except Exception as e:
            text, err = f"{type(e).__name__}: {e}", True
        reply(i, {"content": [{"type": "text", "text": text}], "isError": err})
    elif method == "ping":
        reply(i, {})
    else:
        reply(i, error={"code": -32601, "message": f"method not found: {method}"})
