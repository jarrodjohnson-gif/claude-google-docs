#!/usr/bin/env python3
"""Edit any Google Doc through your own Doc Writer Apps Script web app.

<doc> is a Google Docs link (a ?tab=t.xxx in it targets that tab) or a bare ID.
Markdown comes as trailing words, --file f.md, or stdin.

Read-only
  info     <doc>                          headings, lists, tables with element numbers; all tabs
  markdown <doc>                          the whole tab as markdown
  read     <doc> --heading H              one section's text
  check    [md]                           what the markdown would render, writes nothing
  table    <doc> read [table selector]    a table's cells

Write
  append   <doc> [md]                     at the end of the doc
  insert   <doc> [md] (--heading H [--where end|start|before] | --after T | --before T)
  replace  <doc> --heading H [md]         swap a whole section (md must start with its heading)
  find-replace <doc> --find X --with Y [--regex] [--ignore-case] [--heading H] [--expect N] [--all]
  delete   <doc> (--heading H | --text T [--contains] [--all])
  table    <doc> append-row  --cells A B C            [table selector]
  table    <doc> insert-row  --at N --cells A B C     [table selector]
  table    <doc> update-cell (--row N | --match-row X [--match-col C]) --col C --text T
  table    <doc> delete-row  (--row N | --match-row X [--match-col C])
             table selector: --table-index N | --table-header "Status" | --table-heading H

v3
  style    <doc> --find X [--line] [--bold on|off] [--strike on] [--highlight yes|#hex|none] [--color #hex]
                 [--underline on] [--size N] [--font F] [--link URL|none] [--expect N] [--heading H]
  mention  <doc> --find "Sam" --email sam@x.com      (or --date 2026-09-30) - text becomes a chip
  header / footer <doc> [text]                            set (no text = clear)
  tabs     <doc> list | add --title T [--emoji E] | rename --tab-id t.x --title T
  copy     <template-doc> --title "New name"              then: fill <new-doc> --set key=value ...
  copy-section <doc> --from <other-doc> --from-heading H (--heading H2 | --after T)
  upload   <file> [--folder <Drive folder link>] [--name N]   save a local file into Drive
  batch    <doc> --file ops.json                          [{"mode": "replaceText", ...}, ...]
  comments <doc> [--open] | comment <doc> text | reply <doc> --comment-id ID text | resolve <doc> --comment-id ID
v4
  table    <doc> color --match done --col Status --color "#dcfce7" [--whole-row] [--contains]
  table    <doc> add-column --header Due [--after Status] [--value TBD] | delete-column --col Due
  table    <doc> merge --row 1 --col 0 --rows 1 --cols 2 | unmerge ... | widths --width Lead=60 --width Issue=220
  doc-style <doc> --preset clean | --style "h2:bold=true,size=16,font=Arial"
  page     <doc> [--margins 54] [--landscape|--portrait] [--background #hex|none] [--size letter|a4|legal]
  link-heading <doc> --find "see Bugs" --to "Bugs"
  delete-tab <doc> --tab-id t.x --confirm-title "Exact tab title"
  Inline in any markdown: ~~strike~~  ==highlight==  @[person@x.com]  @date(2026-09-30)  @date(2026-09-30 14:00)
                          @file(https://docs.google.com/...)  [^footnote text]
  A line ![alt](https://...png) or ![alt|300](drive file link) inserts an image (PNG/JPEG/GIF; |300 = max width pt).
  A line with just [[pagebreak]] inserts a page break.

There is deliberately no command that clears a document.
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request, uuid

def _settings():
    """Web app address and token: ~/.config/doc-writer/{url,token} (what the installer
    writes; override the folder with DOC_WRITER_HOME)."""
    home = os.path.expanduser(os.environ.get("DOC_WRITER_HOME", "~/.config/doc-writer"))
    if os.path.exists(os.path.join(home, "url")):
        return [open(os.path.join(home, n)).read().strip() for n in ("url", "token")]
    sys.exit("Doc Writer is not set up: no ~/.config/doc-writer/url - run the installer (install.sh)")


URL, TOKEN = _settings()
VCACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".server-version")
V2_ONLY = {"markdown", "insert", "find-replace", "delete", "table"}
V3_ONLY = {"style", "mention", "header", "footer", "tabs", "copy", "fill", "copy-section", "batch",
           "comments", "comment", "reply", "resolve"}
NO_DOC = {"check", "upload"}
V4_ONLY = {"doc-style", "page", "link-heading", "delete-tab"}
V4_TABLE = {"color", "add-column", "delete-column", "merge", "unmerge", "widths"}


class Refused(Exception):
    pass


def parse_doc(s):
    m = re.search(r"/document/d/([A-Za-z0-9_-]{20,})", s) or re.fullmatch(r"([A-Za-z0-9_-]{20,})", s)
    if not m:
        raise Refused(f"not a Google Docs link or ID: {s}")
    tab = re.search(r"[?&#]tab=(t\.[A-Za-z0-9_-]+)", s)
    return m.group(1), tab.group(1) if tab else None


def server_version():
    try:
        v, at = open(VCACHE).read().split()
        if time.time() - float(at) < 600:
            return int(v)
    except (OSError, ValueError):
        pass
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"{URL}?token={TOKEN}", timeout=60) as r:
                raw = r.read().decode()
            if raw.lstrip().startswith("<"):
                raise Refused("the web app answered with a Google page instead of data - its permissions are not granted "
                              "yet: open the script, run the function `authorize`, click Allow (see the setup doc)")
            out = json.loads(raw)
            if out.get("ok"):
                v = int(out.get("version", 1))
                open(VCACHE, "w").write(f"{v} {time.time()}")
                return v
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise Refused("the web app refused access (HTTP %d) - its permissions are not granted yet: open the "
                              "script, run the function `authorize`, click Allow (see the setup doc)" % e.code)
        except (urllib.error.URLError, ValueError, TimeoutError):
            pass
        time.sleep(2 ** attempt)
    raise Refused("could not reach the webhook to check its version")


def post(payload, write=False, v=1):
    """POST with retries. A retry is only sent when it cannot double a write:
    either the server said it did nothing ('bad token', 'busy'), or it is v2,
    which remembers opId and answers a repeat with the first result."""
    payload["token"] = TOKEN
    if write and v >= 2:
        payload["opId"] = uuid.uuid4().hex
    body = json.dumps(payload).encode()
    last = None
    for attempt in range(4):
        if attempt:
            time.sleep(2 ** attempt)
        try:
            req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read().decode()
            if raw.lstrip().startswith("<"):
                raise Refused("the web app answered with a Google page instead of data - its permissions are not granted "
                              "yet: open the script, run the function `authorize`, click Allow (see the setup doc)")
            out = json.loads(raw)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = f"{type(e).__name__}: {e}"
            if write and v < 2:
                raise Refused(f"{last} - the write may or may not have happened; check the doc before retrying")
            continue
        err = str(out.get("error", ""))
        if not out.get("ok") and (err == "bad token" or err.startswith("busy")):
            last = err
            continue
        return out
    raise Refused(f"gave up after 4 attempts: {last}")


def need(out):
    if not out.get("ok"):
        raise Refused("webhook refused: " + json.dumps({k: v for k, v in out.items() if k != "stack"})[:800])
    return out


def text_arg(a, required=True):
    if getattr(a, "file", None):
        return open(os.path.expanduser(a.file)).read()
    if getattr(a, "md", None):
        return " ".join(a.md)
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        if data.strip():
            return data
    if required:
        raise Refused("no text: pass it as words, with --file, or on stdin")
    return ""


def table_sel(a):
    if a.table_index is not None:
        return {"index": a.table_index}
    if a.table_header:
        return {"header": a.table_header}
    if a.table_heading:
        return {"heading": a.table_heading}
    return None


def col(c):
    return int(c) if c is not None and re.fullmatch(r"\d+", c) else c


def show_outline(out):
    print(f"{out['doc']}  -  {out['children']} elements" + ("  (truncated)" if out.get("truncated") else ""))
    if len(out.get("tabs", [])) > 1:
        print("tabs: " + ", ".join(f"{'  ' * t['depth']}{t['title']} ({t['id']})" for t in out["tabs"]))
    for it in out["items"]:
        ty = it["type"]
        if ty == "table":
            print(f"[{it['i']}] table {it['table']}: {it['rows']}x{it['cols']}  | " + " | ".join(it["header"]) + " |")
        elif ty == "li":
            print(f"[{it['i']}] {'  ' * it['level']}- {it['text']}")
        elif ty.startswith("h") or ty in ("title", "subtitle"):
            print(f"[{it['i']}] {ty.upper()}: {it['text']}")
        elif ty == "p" and not it["text"]:
            continue
        else:
            print(f"[{it['i']}] {ty}: {it.get('text', '')}")


def run(a):
    if a.cmd == "upload":
        import base64, mimetypes
        v = server_version()
        if v < 4:
            raise Refused("upload needs the updated Apps Script")
        data = open(os.path.expanduser(a.path), "rb").read()
        p = {"mode": "upload", "name": a.name or os.path.basename(a.path), "base64": base64.b64encode(data).decode(),
             "mimeType": mimetypes.guess_type(a.path)[0] or "application/octet-stream"}
        if a.folder:
            p["folderId"] = re.sub(r".*/folders/([A-Za-z0-9_-]+).*", r"\1", a.folder)
        out = need(post(p, write=True, v=v))
        print(f"uploaded {out['size']} bytes: {out['url']}")
        return
    if a.cmd == "check":
        print(json.dumps(need(post({"mode": "selftest", "markdown": text_arg(a), "style": "plain"})), indent=2))
        return

    doc, tab = parse_doc(a.doc)
    v = server_version()
    if (a.cmd in V2_ONLY and v < 2) or (a.cmd in V3_ONLY and v < 3) or (a.cmd in V4_ONLY and v < 4) or \
            (a.cmd == "table" and a.op in V4_TABLE and v < 4):
        raise Refused(f"'{a.cmd}' needs the updated Apps Script (the deployed one is v{v}) - redeploy it first")
    if tab and tab != "t.0" and v < 2:
        raise Refused(f"this link targets tab {tab}; the deployed script (v{v}) can only edit the first tab")
    base = {"docId": doc, "style": "plain"}
    if tab and v >= 2:
        base["tabId"] = tab

    def call(payload, write=False):
        return need(post(dict(base, **payload), write=write, v=v))

    if a.cmd == "info":
        if v >= 2:
            show_outline(call({"mode": "outline"}))
        else:
            inv = call({"mode": "inventory", "allNames": []})["inventory"]
            print(f"elements: {inv['children']}")
            for h in inv["headings"]:
                print(f"  {h}")

    elif a.cmd == "markdown":
        # Built here from the outline: Docs' own getAs('text/markdown') fails on
        # real documents despite being documented (seen 2026-09-23).
        out = call({"mode": "outline", "limit": 100000})
        lines, counters = [], {}
        for it in out["items"]:
            ty = it["type"]
            if ty != "li":
                counters = {}
            if ty.startswith("h") and ty[1:].isdigit():
                lines += ["", "#" * int(ty[1:]) + " " + it["text"]]
            elif ty in ("title", "subtitle"):
                lines += ["", ("# " if ty == "title" else "") + it["text"]]
            elif ty == "li":
                lvl = it["level"]
                counters = {k: v for k, v in counters.items() if k <= lvl}
                counters[lvl] = counters.get(lvl, 0) + 1
                glyph = it.get("glyph") or ""
                mark = f"{counters[lvl]}." if glyph in ("NUMBER", "LATIN_LOWER", "LATIN_UPPER", "ROMAN_LOWER",
                                                        "ROMAN_UPPER") else ("- [ ]" if glyph in ("", "null") else "-")
                lines.append("  " * lvl + mark + " " + it["text"])
            elif ty == "table":
                grid = call({"mode": "table", "op": "read", "table": {"index": it["table"]}})["grid"]
                lines.append("")
                for n, row in enumerate(grid):
                    lines.append("| " + " | ".join(c.replace("\n", " ").replace("|", "\\|") for c in row) + " |")
                    if n == 0:
                        lines.append("|" + "---|" * len(row))
                lines.append("")
            elif ty == "rule":
                lines.append("---")
            elif it.get("text"):
                lines.append(it["text"])
        print("\n".join(lines).strip())
        if out.get("truncated"):
            print("\n[truncated]")

    elif a.cmd == "read":
        print(call({"mode": "read", "heading": a.heading, "allNames": []})["text"])

    elif a.cmd == "append":
        md = text_arg(a)
        out = call({"mode": "rebuild", "append": True, "markdown": md, "allNames": []}, write=True)
        print(f"appended {out['blocks']} block(s) at the end of the doc")

    elif a.cmd == "insert":
        md = text_arg(a)
        p = {"mode": "insert", "markdown": md}
        if a.heading:
            p.update(heading=a.heading, where=a.where)
        elif a.after is not None:
            p["afterText"] = a.after
        elif a.before is not None:
            p["beforeText"] = a.before
        else:
            raise Refused("insert needs --heading, --after or --before (use append for the end of the doc)")
        if a.contains:
            p["contains"] = True
        if a.nth is not None:
            p["nth"] = a.nth
        out = call(p, write=True)
        print(f"inserted {out['blocks']} block(s) at element {out['at']}")
        print_styling(out)

    elif a.cmd == "replace":
        md = text_arg(a)
        out = call({"mode": "patch", "allNames": [], "items": [{"heading": a.heading, "markdown": md}]}, write=True)
        if out.get("notFound") or out.get("failed") or not out.get("patched"):
            raise Refused(f"nothing replaced: {json.dumps(out)[:600]}")
        new_heading = next((re.sub(r"^#{1,6}\s+", "", l).strip() for l in md.splitlines()
                            if re.match(r"^#{1,6}\s", l.strip())), a.heading)
        print(f"replaced section '{a.heading}'. It now reads:\n")
        print(call({"mode": "read", "heading": new_heading, "allNames": []})["text"])

    elif a.cmd == "find-replace":
        p = {"mode": "replaceText", "find": a.find, "replace": a.with_ if a.with_ is not None else "",
             "regex": a.regex, "matchCase": not a.ignore_case, "all": a.all}
        if a.heading:
            p["heading"] = a.heading
        if a.expect is not None:
            p["expect"] = a.expect
        out = call(p, write=True)
        print(f"replaced {out['count']} match(es). In:")
        for w in out.get("where", []):
            print(f"  - {w}")

    elif a.cmd == "delete":
        p = {"mode": "delete"}
        if a.heading:
            p["heading"] = a.heading
        elif a.text is not None:
            p.update(text=a.text, contains=a.contains, all=a.all)
        else:
            raise Refused("delete needs --heading or --text")
        out = call(p, write=True)
        print(f"deleted {out['deleted']} element(s):")
        for r in out.get("removed", []):
            print(f"  - {r}")

    elif a.cmd == "style":
        p = {"mode": "style", "find": a.find, "regex": a.regex, "matchCase": not a.ignore_case,
             "all": a.all, "line": a.line}
        for k in ("heading", "expect", "color", "highlight", "size", "font", "link"):
            if getattr(a, k) is not None:
                p[k] = getattr(a, k)
        for k in ("bold", "italic", "underline", "strike"):
            val = getattr(a, k)
            if val is not None:
                p[k] = val == "on"
        show(call(p, write=True))

    elif a.cmd == "mention":
        p = {"mode": "mention", "find": a.find, "all": a.all}
        if a.email: p["email"] = a.email
        if a.date: p["date"] = a.date
        if a.expect is not None: p["expect"] = a.expect
        if a.heading: p["heading"] = a.heading
        show(call(p, write=True))

    elif a.cmd in ("header", "footer"):
        show(call({"mode": "headerFooter", "which": a.cmd, "text": text_arg(a, required=False)}, write=True))

    elif a.cmd == "tabs":
        p = {"mode": "tabs", "op": a.op}
        for k, key in (("title", "title"), ("tab_id", "tabId"), ("parent", "parentTabId"), ("emoji", "emoji"), ("index", "index")):
            if getattr(a, k) is not None:
                p[key] = getattr(a, k)
        out = call(p, write=a.op != "list")
        if a.op == "list":
            for t in out["tabs"]:
                print(f"{'  ' * t['depth']}{t['title']}  ({t['id']})")
        else:
            show(out)

    elif a.cmd == "copy":
        out = call({"mode": "copy", "title": a.title, **({"folderId": a.folder} if a.folder else {})}, write=True)
        print(f"copied to: {out['title']}\n{out['url']}")

    elif a.cmd == "fill":
        values = {}
        if a.json:
            values.update(json.load(open(os.path.expanduser(a.json))))
        for kv in a.set or []:
            k, _, val = kv.partition("=")
            values[k] = val
        if not values:
            raise Refused("fill needs --set key=value (repeatable) or --json file")
        show(call({"mode": "fill", "values": values}, write=True))

    elif a.cmd == "copy-section":
        src, src_tab = parse_doc(a.from_doc)
        p = {"mode": "copySection", "fromDoc": src, "fromHeading": a.from_heading}
        if src_tab and src_tab != "t.0": p["fromTab"] = src_tab
        if a.heading: p.update(heading=a.heading, where=a.where)
        elif a.after is not None: p["afterText"] = a.after
        elif a.before is not None: p["beforeText"] = a.before
        show(call(p, write=True))

    elif a.cmd == "batch":
        ops = json.load(open(os.path.expanduser(a.file))) if a.file else json.load(sys.stdin)
        for o in ops:
            o.setdefault("style", "plain")
        show(call({"mode": "batch", "ops": ops}, write=True))

    elif a.cmd == "comments":
        out = call({"mode": "comments", "open": a.open})
        for c in out["comments"]:
            state = "resolved" if c["resolved"] else "open"
            on = f'  on "{c["on"]}"' if c.get("on") else ""
            print(f"[{c['id']}] {c['by']} ({state}){on}: {c['text']}")
            for r in c["replies"]:
                print(f"    - {r['by']}: {r['text']}" + (f"  [{r['action']}]" if r["action"] else ""))
        if not out["comments"]:
            print("no comments")

    elif a.cmd == "comment":
        show(call({"mode": "comment", "text": text_arg(a)}, write=True))

    elif a.cmd in ("reply", "resolve"):
        p = {"mode": "reply", "commentId": a.comment_id}
        t = text_arg(a, required=a.cmd == "reply")
        if t: p["text"] = t
        if a.cmd == "resolve": p["resolve"] = True
        show(call(p, write=True))

    elif a.cmd == "doc-style":
        p = {"mode": "docStyle"}
        if a.preset: p["preset"] = a.preset
        if a.style:
            st = {}
            for spec in a.style:   # h2:bold=true,size=16,font=Arial,color=#123456
                name, _, props = spec.partition(":")
                d = {}
                for kv in props.split(","):
                    k, _, val = kv.partition("=")
                    d[k] = (val.lower() == "true") if val.lower() in ("true", "false") else val
                st[name] = d
            p["styles"] = st
        show(call(p, write=True))

    elif a.cmd == "page":
        p = {"mode": "page"}
        m = {k: getattr(a, "margin_" + k) for k in ("top", "bottom", "left", "right") if getattr(a, "margin_" + k) is not None}
        if a.margins is not None: m = {k: a.margins for k in ("top", "bottom", "left", "right")}
        if m: p["margins"] = m
        if a.landscape: p["landscape"] = True
        if a.portrait: p["landscape"] = False
        if a.background: p["background"] = a.background
        if a.size: p["size"] = a.size
        show(call(p, write=True))

    elif a.cmd == "link-heading":
        p = {"mode": "linkHeading", "find": a.find, "to": a.to}
        if a.expect is not None: p["expect"] = a.expect
        show(call(p, write=True))

    elif a.cmd == "delete-tab":
        show(call({"mode": "deleteTab", "tabId": a.tab_id, "confirmTitle": a.confirm_title}, write=True))

    elif a.cmd == "table":
        ops = {"read": "read", "append-row": "appendRow", "insert-row": "insertRow",
               "update-cell": "updateCell", "delete-row": "deleteRow", "color": "color",
               "add-column": "addColumn", "delete-column": "deleteColumn", "merge": "merge",
               "unmerge": "unmerge", "widths": "widths"}
        p = {"mode": "table", "op": ops[a.op]}
        sel = table_sel(a)
        if sel:
            p["table"] = sel
        if a.cells is not None:
            p["cells"] = a.cells
        for k, val in (("at", a.at), ("row", a.row), ("matchRow", a.match_row), ("text", a.text)):
            if val is not None:
                p[k] = val
        if a.match_col is not None:
            p["matchCol"] = col(a.match_col)
        if a.col is not None:
            p["col"] = col(a.col)
        for k, key in (("match", "match"), ("color", "color"), ("header", "header"), ("value", "value"),
                       ("rows", "rows"), ("cols", "cols")):
            if getattr(a, k) is not None:
                p[key] = getattr(a, k)
        for k in ("after", "before"):
            if getattr(a, k) is not None:
                p[k] = col(getattr(a, k))
        if a.whole_row: p["row"] = True
        if a.contains: p["contains"] = True
        if a.width:
            p["widths"] = {kv.split("=")[0]: float(kv.split("=")[1]) for kv in a.width}
        out = call(p, write=a.op != "read")
        if a.op == "read":
            for row in out["grid"]:
                print("| " + " | ".join(c.replace("\n", " ") for c in row) + " |")
        else:
            print(json.dumps({k: val for k, val in out.items() if k not in ("ok", "version")}))


def show(out):
    print(json.dumps({k: val for k, val in out.items() if k not in ("ok", "version")}, indent=1))


def print_styling(out):
    st = out.get("styling") or {}
    if st.get("error"):
        print(f"note: content written, but polish (pinned headers / checkboxes) failed: {st['error']}")
    if st.get("note"):
        print(f"note: {st['note']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def cmd(name, doc=True, md=False):
        p = sub.add_parser(name)
        if doc:
            p.add_argument("doc")
        if md:
            p.add_argument("md", nargs="*")
            p.add_argument("--file")
        return p

    cmd("check", doc=False, md=True)
    cmd("info")
    cmd("markdown")
    cmd("read").add_argument("--heading", required=True)
    cmd("append", md=True)
    p = cmd("insert", md=True)
    p.add_argument("--heading"); p.add_argument("--where", default="end", choices=["end", "start", "before"])
    p.add_argument("--after"); p.add_argument("--before")
    p.add_argument("--contains", action="store_true"); p.add_argument("--nth", type=int)
    cmd("replace", md=True).add_argument("--heading", required=True)
    p = cmd("find-replace")
    p.add_argument("--find", required=True); p.add_argument("--with", dest="with_")
    p.add_argument("--regex", action="store_true"); p.add_argument("--ignore-case", action="store_true")
    p.add_argument("--heading"); p.add_argument("--expect", type=int); p.add_argument("--all", action="store_true")
    p = cmd("delete")
    p.add_argument("--heading"); p.add_argument("--text")
    p.add_argument("--contains", action="store_true"); p.add_argument("--all", action="store_true")
    p = cmd("table")
    p.add_argument("op", choices=["read", "append-row", "insert-row", "update-cell", "delete-row", "color",
                                  "add-column", "delete-column", "merge", "unmerge", "widths"])
    p.add_argument("--table-index", type=int); p.add_argument("--table-header"); p.add_argument("--table-heading")
    p.add_argument("--cells", nargs="*"); p.add_argument("--at", type=int)
    p.add_argument("--row", type=int); p.add_argument("--match-row"); p.add_argument("--match-col")
    p.add_argument("--col"); p.add_argument("--text")
    p.add_argument("--match"); p.add_argument("--color"); p.add_argument("--whole-row", action="store_true")
    p.add_argument("--contains", action="store_true"); p.add_argument("--header"); p.add_argument("--value")
    p.add_argument("--after"); p.add_argument("--before"); p.add_argument("--rows", type=int); p.add_argument("--cols", type=int)
    p.add_argument("--width", action="append", help="Column=points, repeatable")

    p = cmd("style")
    p.add_argument("--find", required=True); p.add_argument("--regex", action="store_true")
    p.add_argument("--ignore-case", action="store_true"); p.add_argument("--heading"); p.add_argument("--expect", type=int)
    p.add_argument("--all", action="store_true"); p.add_argument("--line", action="store_true", help="style the whole line")
    for k in ("bold", "italic", "underline", "strike"):
        p.add_argument("--" + k, choices=["on", "off"])
    p.add_argument("--color"); p.add_argument("--highlight", help="hex colour, 'yes' for yellow, or 'none'")
    p.add_argument("--size", type=float); p.add_argument("--font"); p.add_argument("--link", help="url or 'none'")
    p = cmd("mention")
    p.add_argument("--find", required=True); p.add_argument("--email"); p.add_argument("--date", help="YYYY-MM-DD")
    p.add_argument("--expect", type=int); p.add_argument("--heading"); p.add_argument("--all", action="store_true")
    cmd("header", md=True); cmd("footer", md=True)
    p = cmd("tabs")
    p.add_argument("op", choices=["list", "add", "rename"]); p.add_argument("--title"); p.add_argument("--tab-id")
    p.add_argument("--parent"); p.add_argument("--emoji"); p.add_argument("--index", type=int)
    p = cmd("copy"); p.add_argument("--title", required=True); p.add_argument("--folder")
    p = cmd("fill"); p.add_argument("--set", action="append", help="key=value"); p.add_argument("--json")
    p = cmd("copy-section")
    p.add_argument("--from", dest="from_doc", required=True); p.add_argument("--from-heading", required=True)
    p.add_argument("--heading"); p.add_argument("--where", default="end", choices=["end", "start", "before"])
    p.add_argument("--after"); p.add_argument("--before")
    cmd("batch").add_argument("--file")
    p = cmd("upload", doc=False); p.add_argument("path"); p.add_argument("--folder", help="Drive folder link or id"); p.add_argument("--name")
    p = cmd("doc-style"); p.add_argument("--preset", choices=["clean"])
    p.add_argument("--style", action="append", help="h2:bold=true,size=16,font=Arial,color=#hex,spaceAbove=12")
    p = cmd("page")
    for k in ("top", "bottom", "left", "right"):
        p.add_argument("--margin-" + k, type=float)
    p.add_argument("--margins", type=float, help="all four, points")
    p.add_argument("--landscape", action="store_true"); p.add_argument("--portrait", action="store_true")
    p.add_argument("--background"); p.add_argument("--size", choices=["letter", "a4", "legal"])
    p = cmd("link-heading"); p.add_argument("--find", required=True); p.add_argument("--to", required=True)
    p.add_argument("--expect", type=int)
    p = cmd("delete-tab"); p.add_argument("--tab-id", required=True); p.add_argument("--confirm-title", required=True)
    cmd("comments").add_argument("--open", action="store_true", help="only unresolved")
    cmd("comment", md=True)
    p = cmd("reply", md=True); p.add_argument("--comment-id", required=True)
    p = cmd("resolve", md=True); p.add_argument("--comment-id", required=True)

    a = ap.parse_args()
    try:
        run(a)
    except Refused as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
