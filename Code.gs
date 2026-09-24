/**
 * Doc Writer  -  Google Apps Script
 *
 * Lets Claude edit Google Docs through a web app that runs as you. It began as a
 * writer for one markdown spec (the 'pcr' house style below) and grew into a
 * general editor (style: 'plain'). Rebuilds or surgically patches a doc. Runs as
 * you, on your own session: no Cloud project, no OAuth client, nothing for an
 * admin to approve.
 *
 * MODES  (payload.mode)
 *   inventory  read-only. Reports which checks and headings it can address.
 *   (No PDF mode: exporting needs a Drive scope this script should not hold.
 *    Export the Doc as PDF from the client instead - same result, less access.)
 *   selftest   parse only. Proves a payload renders without touching the Doc.
 *   patch      replaces named checks or sections in place. Comments and manual
 *              edits everywhere else are untouched. This is the normal path.
 *   rebuild    clears the body and rewrites it. Destroys comments. Last resort.
 *
 * WHY IT WON'T BREAK THE DOC
 *   Parsing is pure  -  no document calls  -  so a malformed payload fails before
 *   anything is touched. `rebuild` parses the entire payload first and only
 *   clears the body once parsing has succeeded. `patch` parses each item before
 *   deleting the block it replaces, and never deletes a block it could not
 *   positively locate. Every text range is clamped to the element length and
 *   every table loop is bounded by the table's real dimensions, so an
 *   out-of-range index cannot occur.
 *
 * SETUP
 *   Doc  >  Extensions  >  Apps Script  >  paste over Code.gs  >  save
 *   Editor  >  Services  >  +  >  Google Docs API  >  Add   (one-time; powers
 *     the batchUpdate calls below - pinned headers, callout rails, row tint)
 *   Deploy  >  Manage deployments  >  edit  >  New version  >  Deploy
 */

// Prefer the script property; the literal is a fallback so an un-migrated
// deployment keeps working. Run setupToken() once in the editor to migrate,
// then the literal can be blanked.
var TOKEN_FALLBACK = "REPLACE_WITH_THE_TOKEN_FROM_.appsscript-token";

function getToken() {
  var v = PropertiesService.getScriptProperties().getProperty('WEBHOOK_TOKEN');
  return v || TOKEN_FALLBACK;
}

/**
 * Run once from the editor (select authorize, press Run) to grant the Drive
 * permission templates and comments need. A deploy alone never asks for it.
 */
function authorize() {
  var bound = null;
  try { bound = DocumentApp.getActiveDocument(); } catch (e) {}
  var id = bound ? bound.getId() : null;
  Logger.log('Drive access: ' + (id ? DriveApp.getFileById(id).getName() : DriveApp.getRootFolder().getName()));
  if (typeof Drive === 'undefined') Logger.log('Drive API service not added yet - Services > + > Drive API > Add');
  else if (id) Logger.log('Comments on this doc: ' + (Drive.Comments.list(id, { fields: 'comments(id)' }).comments || []).length);
  else Logger.log('Drive API service: ready');
  Logger.log('Web fetch for images: HTTP ' + UrlFetchApp.fetch('https://www.google.com/robots.txt', { muteHttpExceptions: true }).getResponseCode());
}

/** Run once from the editor, then clear TOKEN_FALLBACK above. */
function setupToken() {
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_TOKEN', TOKEN_FALLBACK);
  Logger.log('WEBHOOK_TOKEN stored in script properties');
}

// Marks are written as escapes, never as literal characters. Editors and
// clipboards mangle multi-byte glyphs; \uXXXX survives any transport.
var TICK = '\u2713';   // check mark
var DISC = '\u25CF';   // black circle - the source character a check author still types
var RING = '\u25CB';   // white circle
var DOTR = '\u25CD';   // circle with vertical fill
var DASH = '\u2013';   // en dash
var XMARK = '\u2717';  // ballot X - what DISC actually renders as, see MARKS.glyph below

var MARKS = {};
MARKS[TICK] = { label: 'PASS',           color: '#12905c', glyph: TICK };
MARKS[DISC] = { label: 'FAIL',           color: '#b42318', glyph: XMARK };
MARKS[RING] = { label: 'NEEDED',         color: '#175cd3', glyph: RING };
MARKS[DOTR] = { label: 'VERIFY BY HAND', color: '#175cd3', glyph: DOTR };
MARKS[DASH] = { label: 'N/A',            color: '#828b9c', glyph: DASH };

var ROW_RE = new RegExp('^- ([' + TICK + DISC + RING + DOTR + DASH + ']) (.*)$');
var LIST_RE = /^( *)([-*+]|\d{1,3}[.)]) +(\[[ xX]\] +)?(.*)$/;

// Glyph by nesting level, the way Docs' own list button cycles them.
var OL_GLYPHS = ['NUMBER', 'LATIN_LOWER', 'ROMAN_LOWER'];
var UL_GLYPHS = ['BULLET', 'HOLLOW_BULLET', 'SQUARE_BULLET'];

var VERSION      = 4;      // clients check this before sending a mode an older script lacks
var WRITES       = { patch: 1, rebuild: 1, insert: 1, replaceText: 1, 'delete': 1, table: 1, style: 1,
                    mention: 1, headerFooter: 1, tabs: 1, copy: 1, fill: 1, copySection: 1, batch: 1,
                    comment: 1, reply: 1, docStyle: 1, page: 1, linkHeading: 1, deleteTab: 1, upload: 1 };
var CHIPS        = [];     // person/date chips waiting for the Docs API pass - see finishChips_
var DOC_ID       = null;   // set per request; null means the bound document
var TAB_ID       = null;   // set per request; null means the first tab
var STYLE        = 'pcr';  // 'pcr' = the spec's house style; 'plain' = the doc's own styles
var CHANGES      = {};
var STYLE_QUEUE  = [];     // batchUpdate-only styling, queued during the
                           // DocumentApp pass and applied once at the end -
                           // see applyStyleQueue_. A failure here never loses
                           // text: DocumentApp has already written it by then.
var ADDED_BG     = '#12905c';
var UPDATED_BG   = '#175cd3';
var ADDED_TINT   = '#e9f7f0';
var UPDATED_TINT = '#eaf2fe';
var GREY         = '#667085';
var INK          = '#1a1a1a';
var MONO         = '#344054';
var HIGHLIGHT    = '#fff2a8';
// Chip placeholders are plain ASCII, [[chip:<request nonce>:<n>]]: private-use
// characters were not found again through the Docs API (seen 2026-09-23), and
// the nonce stops a leftover from an earlier request matching this one's chips.
var CHIP_NONCE   = '';

/** '#rrggbb' -> the {red,green,blue} 0-1 float shape every Docs API colour field wants. */
function rgb_(hex) {
  var h = hex.replace('#', '');
  return { red: parseInt(h.substring(0, 2), 16) / 255,
           green: parseInt(h.substring(2, 4), 16) / 255,
           blue: parseInt(h.substring(4, 6), 16) / 255 };
}

// --------------------------------------------------------------- entry points

function doPost(e) {
  // Two overlapping writes would each compute indices against a document the
  // other is mutating. Serialise them.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json({ ok: false, error: 'busy - another write is in progress' });
  try {
    var p = JSON.parse(e.postData.contents);
    if (p.token !== getToken()) return json({ ok: false, error: 'bad token' });
    CHANGES = p.changes || {};
    DOC_ID  = p.docId || null;
    TAB_ID  = p.tabId || null;
    STYLE   = p.style === 'plain' ? 'plain' : 'pcr';
    var mode = p.mode || 'rebuild';

    // A retried write (the client saw a 404 or timeout after the script ran)
    // returns the first attempt's result instead of writing twice.
    var cache = null, key = null;
    if (p.opId && WRITES[mode]) {
      cache = CacheService.getScriptCache();
      key = 'op:' + String(p.opId).substring(0, 200);
      var seen = cache.get(key);
      if (seen) return ContentService.createTextOutput(seen).setMimeType(ContentService.MimeType.JSON);
    }

    var out = run_(mode, p);

    out.version = VERSION;
    var text = JSON.stringify(out);
    if (cache && out.ok) cache.put(key, text, 21600);
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json({ ok: false, error: String(err), stack: (err.stack || '').substring(0, 600) });
  } finally {
    lock.releaseLock();
  }
}

/** One mode. Separate from doPost so batch can run several in one request. */
function run_(mode, p) {
    var out;
    CHIPS = [];
    if (mode === 'inventory')        out = { ok: true, mode: mode, inventory: inventory(p.allNames || []) };
    else if (mode === 'selftest')    out = selftest(p.markdown || '');
    else if (mode === 'patch')       out = patchAll(p.items || [], p.allNames || []);
    else if (mode === 'read')        out = readBlock(p.name, p.heading, p.allNames || []);
    else if (mode === 'outline')     out = outline(p.limit || 400);
    else if (mode === 'markdown')    out = exportMarkdown();
    else if (mode === 'insert')      out = insertAt(p);
    else if (mode === 'replaceText') out = replaceTextIn(p);
    else if (mode === 'delete')      out = deleteBlocks(p);
    else if (mode === 'table')       out = tableEdit(p);
    else if (mode === 'style')       out = styleText(p);
    else if (mode === 'mention')     out = mentionText(p);
    else if (mode === 'headerFooter') out = headerFooter(p);
    else if (mode === 'tabs')        out = tabsEdit(p);
    else if (mode === 'copy')        out = copyDoc(p);
    else if (mode === 'fill')        out = fillTemplate(p);
    else if (mode === 'copySection') out = copySection(p);
    else if (mode === 'batch')       out = batchRun(p);
    else if (mode === 'comments')    out = listComments(p);
    else if (mode === 'comment')     out = addComment(p);
    else if (mode === 'reply')       out = replyComment(p);
    else if (mode === 'docStyle')    out = docStyle(p);
    else if (mode === 'page')        out = pageSetup(p);
    else if (mode === 'linkHeading') out = linkHeading(p);
    else if (mode === 'deleteTab')   out = deleteTab(p);
    else if (mode === 'upload')      out = uploadFile(p);
    else if (mode === 'rebuild') {
      // Clearing someone else's document must be asked for in so many words.
      if (!p.append && DOC_ID && p.confirmClear !== true) {
        out = { ok: false, error: 'rebuild without append clears the whole document - send confirmClear: true' };
      } else {
        out = rebuild(p.markdown, p.append === true, p.allNames || []);
      }
    }
    else out = { ok: false, error: 'unknown mode: ' + mode };
    // Chips written by this mode are placeholders until the Docs API swaps them in.
    if (out.ok && CHIPS.length && DOC_ID) {
      try { out.chips = finishChips_(DOC_ID); } catch (e) { out.chips = { error: String(e) }; }
    }
    return out;
}

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== getToken()) return json({ ok: false, error: 'bad token' });
  // A standalone install (the shareable package) has no document of its own.
  var d = null;
  try { d = DocumentApp.getActiveDocument(); } catch (err) {}
  if (!d) return json({ ok: true, doc: null, version: VERSION });
  return json({ ok: true, doc: d.getName(), children: d.getBody().getNumChildren(), version: VERSION });
}

/** The document this request targets. */
function target() {
  var d = DOC_ID ? DocumentApp.openById(DOC_ID) : DocumentApp.getActiveDocument();
  OPENED.push(d);
  return d;
}
var OPENED = [];   // every handle this request opened, so finishChips_ can flush them

/**
 * The body this request edits. getBody() is always the first tab in a web
 * app, so a tabId from the URL (?tab=t.abc123) is the only way to reach others.
 */
function targetBody(doc) {
  if (!TAB_ID) return doc.getBody();
  var tab = doc.getTab(TAB_ID);
  if (!tab) throw new Error('no tab with id ' + TAB_ID);
  return tab.asDocumentTab().getBody();
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// -------------------------------------------------------------------- parsing
// Pure. No DocumentApp. Anything wrong throws before the Doc is touched.

/** Markdown emphasis -> plain text plus the ranges to style. */
function richText(str) {
  if (STYLE === 'plain') str = chipTokens_(str);
  var re = STYLE === 'plain'
    ? /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|~~([^~]+)~~|==([^=]+)==/g
    : /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  var plain = '', spans = [], last = 0, m;
  while ((m = re.exec(str)) !== null) {
    plain += str.substring(last, m.index);
    var inner = m[1] || m[2] || m[3] || m[4] || m[6] || m[7];
    var kind  = m[1] ? 'b' : m[2] ? 'c' : m[3] ? 'i' : m[4] ? 'l' : m[6] ? 's' : m[7] ? 'h' : null;
    if (kind) spans.push({ s: plain.length, e: plain.length + inner.length - 1,
                           k: kind, u: kind === 'l' ? m[5] : null });
    plain += inner;
    last = m.index + m[0].length;
  }
  return { text: plain + str.substring(last), spans: spans };
}

/** Split a table row on pipes, ignoring any pipe inside `code ticks`. */
function splitRow(row) {
  var r = row.replace(/^\||\|$/g, ''), out = [], cur = '', tick = false;
  for (var i = 0; i < r.length; i++) {
    var ch = r.charAt(i);
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  out.push(cur);
  return out;
}

/** Markdown -> a flat list of block descriptors. */
function parseBlocks(md) {
  var lines = String(md).split('\n'), out = [], i = 0, plain = STYLE === 'plain';

  while (i < lines.length) {
    var s = lines[i].trim();
    if (!s) { i++; continue; }

    // Plain style: real list items. Two spaces (or a tab) of indent per level;
    // '- [ ]' / '- [x]' become a checklist.
    if (plain) {
      var li = lines[i].replace(/\t/g, '  ').match(LIST_RE);
      if (li) {
        out.push({ t: 'li', level: Math.min(8, Math.floor(li[1].length / 2)),
                   ordered: /^\d/.test(li[2]), checkbox: !!li[3],
                   checked: !!li[3] && /x/i.test(li[3]), rich: richText(li[4]) });
        i++; continue;
      }
    }

    if (s.indexOf('```') === 0) {
      i++;
      var code = [];
      while (i < lines.length && lines[i].trim().indexOf('```') !== 0) { code.push(lines[i]); i++; }
      i++;
      out.push({ t: 'code', text: code.join('\n') });
      continue;
    }

    if (s === '---') { out.push({ t: 'rule' }); i++; continue; }

    if (s === '[[TOC]]') { out.push({ t: 'toc' }); i++; continue; }

    if (s === '[[pagebreak]]') { out.push({ t: 'pagebreak' }); i++; continue; }

    // Base64 data URIs only - never a fetchable URL. UrlFetchApp would need the
    // script.external_request scope; a data URI is already inside this payload.
    var img = s.match(/^!\[([^\]]*)\]\((data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+))\)$/);
    if (img) { out.push({ t: 'image', alt: img[1], mime: 'image/' + img[3], b64: img[4] }); i++; continue; }

    // Plain style also takes an image link: a web URL (fetched by Google) or a
    // Drive file link. ![alt|300](url) sets the width in points.
    var imgUrl = plain && s.match(/^!\[([^\]|]*)(?:\|(\d{2,4}))?\]\((https:\/\/[^)\s]+)\)$/);
    if (imgUrl) { out.push({ t: 'image', alt: imgUrl[1], width: imgUrl[2] ? +imgUrl[2] : null, url: imgUrl[3] }); i++; continue; }

    var h = s.match(plain ? /^(#{1,6})\s+(.*)$/ : /^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ t: 'h', level: h[1].length, rich: richText(h[2]) }); i++; continue; }

    if (s.charAt(0) === '|') {
      var rows = [];
      while (i < lines.length && lines[i].trim().charAt(0) === '|') { rows.push(lines[i].trim()); i++; }
      var grid = rows.map(function (r) {
        return splitRow(r).map(function (c) { return richText(c.trim()); });
      });
      if (grid.length > 1) {
        var sep = grid[1].map(function (x) { return x.text; }).join('');
        if (/^[-: ]+$/.test(sep)) grid.splice(1, 1);
      }
      if (grid.length && grid[0].length) out.push({ t: 'table', grid: grid });
      continue;
    }

    if (s.indexOf('> ') === 0) {
      var q = [];
      while (i < lines.length && lines[i].trim().indexOf('> ') === 0) { q.push(lines[i].trim().substring(2)); i++; }
      var joined = q.join(' ');
      var call = joined.match(/^\[!(NOTE|WARNING|KEY)\]\s*(.*)$/i);
      if (call) out.push({ t: 'callout', kind: call[1].toUpperCase(), rich: richText(call[2]) });
      else out.push({ t: 'quote', rich: richText(joined) });
      continue;
    }

    // The spec's own blocks - check names, result rows, asides, gate lines -
    // mean nothing in an ordinary document, where **Name** is just bold text.
    if (!plain) {
      var cn = s.match(/^\*\*([^*]+)\*\*$/);
      if (cn) { out.push({ t: 'check', name: cn[1] }); i++; continue; }

      var rr = s.match(ROW_RE);
      if (rr) { out.push({ t: 'row', mark: rr[1], rich: richText(rr[2]) }); i++; continue; }

      var it = s.match(/^- \*([^*].*)\*$/);
      if (it) { out.push({ t: 'aside', rich: richText(it[1]) }); i++; continue; }

      if (s.indexOf('- ') === 0) {
        var b = s.substring(2);
        out.push({ t: 'bullet', rich: richText(b), gate: /Blocks (approval|funding)|Note only/.test(b) });
        i++; continue;
      }
    }

    var para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(#|\||>|- |```|---$)/.test(lines[i].trim()) &&
           !(plain && LIST_RE.test(lines[i])) &&
           !(!plain && /^\*\*[^*]+\*\*$/.test(lines[i].trim()))) {
      para.push(lines[i].trim()); i++;
      if (plain) break;   // in an ordinary doc a line break is a new paragraph
    }
    if (para.length) out.push({ t: 'para', rich: richText(para.join(' ')) });
    else i++;
  }
  return out;
}

// ------------------------------------------------------------------- emitting

/** Append (at === null) or insert at an index, advancing as it goes. */
function Sink(body, at) { this.b = body; this.at = at; }
Sink.prototype.para = function (text) {
  if (this.at === null) return this.b.appendParagraph(text);
  var p = this.b.insertParagraph(this.at, text); this.at++; return p;
};
Sink.prototype.table = function (cells) {
  if (this.at === null) return this.b.appendTable(cells);
  var t = this.b.insertTable(this.at, cells); this.at++; return t;
};
Sink.prototype.li = function (text) {
  if (this.at === null) return this.b.appendListItem(text);
  var l = this.b.insertListItem(this.at, text); this.at++; return l;
};
Sink.prototype.pagebreak = function () {
  if (this.at === null) return this.b.appendPageBreak();
  var r = this.b.insertPageBreak(this.at); this.at++; return r;
};
Sink.prototype.rule = function () {
  if (this.at === null) return this.b.appendHorizontalRule();
  var r = this.b.insertHorizontalRule(this.at); this.at++; return r;
};

/**
 * Plain style: undo whatever character formatting the new paragraph inherited
 * from its neighbour (Docs copies bold, italic, font, colour and links forward),
 * so the text falls back to the document's own named styles. null means "reset
 * to the paragraph style"; false is the fallback if a setter refuses null.
 */
function clearInline_(txt) {
  if (!txt.getText().length) return;
  var setters = ['setBold', 'setItalic', 'setUnderline', 'setStrikethrough', 'setLinkUrl',
                 'setFontFamily', 'setFontSize', 'setForegroundColor', 'setBackgroundColor'];
  for (var i = 0; i < setters.length; i++) {
    try { txt[setters[i]](null); }
    catch (e) { if (i < 4) txt[setters[i]](false); }
  }
}

/** Apply emphasis ranges, clamped so an out-of-range index is impossible. */
function applySpans(txt, off, spans) {
  if (!spans || !spans.length) return;
  var max = txt.getText().length - 1;
  if (max < 0) return;
  for (var i = 0; i < spans.length; i++) {
    var a = off + spans[i].s, b = off + spans[i].e;
    if (a < 0) a = 0;
    if (b > max) b = max;
    if (b < a || a > max) continue;
    if (spans[i].k === 'b') txt.setBold(a, b, true);
    else if (spans[i].k === 'i') txt.setItalic(a, b, true);
    else if (spans[i].k === 'l') { if (spans[i].u) txt.setLinkUrl(a, b, spans[i].u); }
    else if (spans[i].k === 's') txt.setStrikethrough(a, b, true);
    else if (spans[i].k === 'h') txt.setBackgroundColor(a, b, HIGHLIGHT);
    else if (spans[i].k === 'c') {
      txt.setFontFamily(a, b, 'Roboto Mono');
      if (STYLE !== 'plain') txt.setForegroundColor(a, b, MONO);
      txt.setFontSize(a, b, 9);
    }
  }
}

function emitBlocks(ops, sink) {
  var HEADINGS = [DocumentApp.ParagraphHeading.HEADING1,
                  DocumentApp.ParagraphHeading.HEADING2,
                  DocumentApp.ParagraphHeading.HEADING3,
                  DocumentApp.ParagraphHeading.HEADING4,
                  DocumentApp.ParagraphHeading.HEADING5,
                  DocumentApp.ParagraphHeading.HEADING6];
  var tint = null, n = 0, curCheck = null, listHead = null, listKind = null, plain = STYLE === 'plain';

  for (var k = 0; k < ops.length; k++) {
    var o = ops[k];
    if (o.t !== 'li') listHead = null;
    // A bullet list, a numbered list and a checklist written back to back are
    // three lists; sharing one would let the checklist preset take over all of it.
    if (o.t === 'li') {
      var kind = o.checkbox ? 'check' : o.ordered ? 'ol' : 'ul';
      // Nested items stay in their parent's list; a top-level item of another
      // kind, or a switch to or from checkboxes at any depth, starts a new one.
      if (listHead && kind !== listKind && (o.level === 0 || o.checkbox !== (listKind === 'check'))) listHead = null;
      if (!listHead || o.level === 0) listKind = kind;
    }

    if (o.t === 'li') {
      var item = sink.li(o.rich.text);
      item.setNestingLevel(o.level);
      item.setGlyphType(DocumentApp.GlyphType[(o.ordered ? OL_GLYPHS : UL_GLYPHS)[o.level % 3]]);
      // One run of consecutive items is one list, so numbering continues -
      // and the first item starts a fresh list rather than joining a neighbour.
      // DocumentApp glues a new item onto whatever list precedes it, so it cannot
      // start a separate list. Each run is queued and rebuilt by the Docs API as
      // its own list with the right preset (see applyRangeQueue_); the glyphs set
      // above are what remains if that step is unavailable.
      if (listHead) item.setListId(listHead);
      else {
        listHead = item;
        STYLE_QUEUE.push({ check: curCheck, kind: 'list', items: [], checked: 0,
                           preset: kind === 'check' ? 'BULLET_CHECKBOX' :
                                   kind === 'ol' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE' });
      }
      var run = STYLE_QUEUE[STYLE_QUEUE.length - 1];
      run.items.push({ text: o.rich.text, level: o.level });
      if (o.checked) run.checked++;
      var lt = item.editAsText();
      clearInline_(lt);
      applySpans(lt, 0, o.rich.spans);
      n++; continue;
    }

    if (o.t === 'rule') { tint = null; sink.rule(); n++; continue; }

    if (o.t === 'pagebreak') { sink.pagebreak(); n++; continue; }

    if (o.t === 'toc') {
      // DocumentApp can read a table of contents but cannot create one, and the
      // Docs API does not expose it either. Insert it once by hand in the Doc
      // (Insert > Table of contents); patch mode never touches it, so it stays.
      continue;
    }

    if (o.t === 'image') {
      // A corrupt data URI must not abort emitBlocks partway through a check -
      // patchAll deletes the old block before calling this, so a thrown error
      // here would leave the check half-written. Caught locally, never rethrown.
      try {
        var blob = o.url ? imageBlob_(o.url, o.alt)
                         : Utilities.newBlob(Utilities.base64Decode(o.b64), o.mime, o.alt || 'image');
        var ip = sink.para('');
        var inl = ip.appendInlineImage(blob);
        var MAXW = o.width || 468; // page width in points, 1in margins on US Letter
        if (inl.getWidth() > MAXW) {
          var ratio = MAXW / inl.getWidth();
          inl.setWidth(MAXW);
          inl.setHeight(Math.round(inl.getHeight() * ratio));
        }
        if (o.alt) inl.setAltTitle(o.alt);
      } catch (imgErr) {
        sink.para('[image failed to render: ' + (o.alt || '') + ' - ' + String(imgErr) + ']')
            .setItalic(true).setFontSize(9).setForegroundColor(GREY).setFontFamily('Arial');
      }
      n++; continue;
    }

    if (o.t === 'code') {
      var cp = sink.para(o.text);
      if (plain) clearInline_(cp.editAsText());
      cp.setFontFamily('Roboto Mono').setFontSize(9)
          .setForegroundColor(MONO).setSpacingBefore(4).setSpacingAfter(8).setItalic(false);
      n++; continue;
    }

    if (o.t === 'h') {
      tint = null;
      var hp = sink.para(o.rich.text);
      hp.setHeading(HEADINGS[o.level - 1]);
      if (plain) clearInline_(hp.editAsText());
      else hp.setItalic(false).setFontFamily('Arial');
      applySpans(hp.editAsText(), 0, o.rich.spans);
      n++; continue;
    }

    if (o.t === 'table') {
      var cells = o.grid.map(function (r) { return r.map(function (c) { return c.text; }); });
      var t = sink.table(cells);
      t.setBorderColor('#e0e0e0');
      var nr = Math.min(o.grid.length, t.getNumRows());
      for (var ri = 0; ri < nr; ri++) {
        var row = t.getRow(ri), nc = Math.min(o.grid[ri].length, row.getNumCells());
        for (var ci = 0; ci < nc; ci++) {
          var cell = row.getCell(ci).editAsText();
          cell.setItalic(false).setFontFamily('Arial');
          if (ri === 0) cell.setBold(true).setForegroundColor(GREY).setFontSize(9);
          applySpans(cell, 0, o.grid[ri][ci].spans);
        }
      }
      if (o.grid.length > 1) STYLE_QUEUE.push({ check: curCheck, kind: 'table' });
      n++; continue;
    }

    if (o.t === 'callout') {
      var SKIN = { NOTE:    { bg: '#eef4ff', ink: '#1a3a7a', rail: rgb_('#175cd3') },
                   WARNING: { bg: '#fff4ed', ink: '#7a3510', rail: rgb_('#b45309') },
                   KEY:     { bg: '#eefaf3', ink: '#0d5136', rail: rgb_('#12905c') } };
      var sk = SKIN[o.kind] || SKIN.NOTE;
      var ct = sink.table([[o.rich.text]]);
      ct.setBorderWidth(0);
      var cc = ct.getCell(0, 0);
      cc.setBackgroundColor(sk.bg);
      cc.setPaddingLeft(10).setPaddingRight(10).setPaddingTop(6).setPaddingBottom(6);
      var cx = cc.editAsText();
      cx.setForegroundColor(sk.ink).setFontSize(10).setItalic(false).setBold(false).setFontFamily('Arial');
      applySpans(cx, 0, o.rich.spans);
      STYLE_QUEUE.push({ check: curCheck, kind: 'callout', text: o.rich.text, rgb: sk.rail });
      n++; continue;
    }

    if (o.t === 'quote') {
      var qp = sink.para(o.rich.text);
      qp.setIndentStart(18).setForegroundColor(MONO).setSpacingBefore(4)
        .setSpacingAfter(6).setItalic(false).setFontFamily('Arial');
      applySpans(qp.editAsText(), 0, o.rich.spans);
      n++; continue;
    }

    if (o.t === 'check') {
      curCheck = o.name;
      var change = CHANGES[o.name] || null;
      tint = change === 'ADDED' ? ADDED_TINT : change === 'UPDATED' ? UPDATED_TINT : null;
      var label = change ? (o.name + '   ' + change) : o.name;
      var np = sink.para(label);
      np.setSpacingBefore(12).setSpacingAfter(2);
      var nt = np.editAsText();
      nt.setBold(true); nt.setItalic(false); nt.setFontSize(11.5);
      nt.setForegroundColor(INK); nt.setFontFamily('Arial');
      if (change) {
        var from = o.name.length + 3, to = label.length - 1, cap = nt.getText().length - 1;
        if (to > cap) to = cap;
        if (to >= from && from >= 0) {
          nt.setFontSize(from, to, 7);
          nt.setForegroundColor(from, to, '#ffffff');
          nt.setBackgroundColor(from, to, change === 'ADDED' ? ADDED_BG : UPDATED_BG);
        }
      }
      // Glue the name to its first row so a page break can't strand it alone
      // at the bottom of a page. label, not o.name, since that's this paragraph's
      // actual text - the badge suffix is part of what applyStyleQueue_ must match.
      STYLE_QUEUE.push({ check: curCheck, kind: 'keepWithNext', text: label });
      n++; continue;
    }

    if (o.t === 'row') {
      var mk = MARKS[o.mark] || MARKS[DASH];
      var p = sink.para('');
      p.setIndentStart(18).setSpacingBefore(0).setSpacingAfter(1).setFontSize(10)
       .setItalic(false).setFontFamily('Arial');
      var txt = p.editAsText();
      txt.appendText(o.mark + '  ' + mk.label + '  ' + o.rich.text);
      var last = txt.getText().length - 1;
      var mEnd = o.mark.length - 1;
      var lStart = o.mark.length + 2, lEnd = lStart + mk.label.length - 1;
      var bStart = lEnd + 3;
      if (mEnd >= 0 && mEnd <= last) txt.setForegroundColor(0, mEnd, mk.color).setBold(0, mEnd, true);
      if (lEnd >= lStart && lEnd <= last) {
        txt.setForegroundColor(lStart, lEnd, mk.color).setBold(lStart, lEnd, true)
           .setFontSize(lStart, lEnd, 7.5);
      }
      if (bStart <= last) txt.setForegroundColor(bStart, last, GREY);
      applySpans(txt, bStart, o.rich.spans);
      if (tint && last >= 0) {
        txt.setBackgroundColor(0, last, tint);
        // DocumentApp can only tint the text run above; queue the same colour
        // as a full paragraph-width shade so the highlight reaches the margin.
        STYLE_QUEUE.push({ check: curCheck, kind: 'row',
                            text: o.mark + '  ' + mk.label + '  ' + o.rich.text, rgb: rgb_(tint) });
      }
      n++; continue;
    }

    if (o.t === 'aside') {
      var ip = sink.para(o.rich.text);
      ip.setIndentStart(18).setItalic(true).setFontSize(9.5).setForegroundColor(GREY).setFontFamily('Arial')
        .setSpacingBefore(1).setSpacingAfter(1);
      applySpans(ip.editAsText(), 0, o.rich.spans);
      n++; continue;
    }

    if (o.t === 'bullet') {
      var bp = sink.para(o.rich.text);
      bp.setIndentStart(18).setFontSize(10).setForegroundColor(o.gate ? MONO : GREY)
        .setBold(!!o.gate).setItalic(false).setFontFamily('Arial')
        .setSpacingBefore(2).setSpacingAfter(4);
      applySpans(bp.editAsText(), 0, o.rich.spans);
      n++; continue;
    }

    var pp = sink.para(o.rich.text);
    if (plain) {
      pp.setHeading(DocumentApp.ParagraphHeading.NORMAL);
      clearInline_(pp.editAsText());
    } else {
      pp.setFontSize(10.5).setForegroundColor(INK).setSpacingAfter(6)
        .setItalic(false).setFontFamily('Arial');
    }
    applySpans(pp.editAsText(), 0, o.rich.spans);
    n++;
  }
  return n;
}

// ----------------------------------------------------------------- addressing

var _SCAN = null;

/** One pass over the body. Cached; invalidated after every edit. */
function scanBody(body) {
  if (_SCAN) return _SCAN;
  var out = [], n = body.getNumChildren();
  for (var i = 0; i < n; i++) {
    var el = body.getChild(i), ty = el.getType();
    if (ty === DocumentApp.ElementType.PARAGRAPH) {
      var pa = el.asParagraph();
      out.push({ text: pa.getText().trim(), rule: false, level: headingLevel_(pa.getHeading()) });
    } else if (ty === DocumentApp.ElementType.LIST_ITEM) {
      out.push({ text: el.asListItem().getText().trim(), rule: false, level: 0, li: true });
    } else {
      out.push({ text: '', rule: ty === DocumentApp.ElementType.HORIZONTAL_RULE, level: 0 });
    }
  }
  _SCAN = out;
  return out;
}

function headingLevel_(hd) {
  var H = DocumentApp.ParagraphHeading;
  return hd === H.HEADING1 ? 1 : hd === H.HEADING2 ? 2 : hd === H.HEADING3 ? 3 :
         hd === H.HEADING4 ? 4 : hd === H.HEADING5 ? 5 : hd === H.HEADING6 ? 6 : 0;
}

/** The check name a paragraph opens, allowing for a trailing badge. */
function baseName(text, set) {
  if (set[text]) return text;
  var cut = text.indexOf('   ');
  if (cut > 0 && set[text.substring(0, cut)]) return text.substring(0, cut);
  return null;
}

/** [s, e) of a check's block, or null if it isn't there. */
function checkRange(body, name, set) {
  var sc = scanBody(body), start = -1;
  for (var i = 0; i < sc.length; i++) {
    if (baseName(sc[i].text, set) === name) { start = i; break; }
  }
  if (start < 0) return null;
  for (var j = start + 1; j < sc.length; j++) {
    if (sc[j].rule || sc[j].level > 0 || baseName(sc[j].text, set)) return { s: start, e: j };
  }
  return { s: start, e: sc.length };
}

/** [s, e) of a heading and everything beneath it, or null. */
function sectionRange(body, heading) {
  var sc = scanBody(body), start = -1, lvl = 0;
  for (var i = 0; i < sc.length; i++) {
    if (sc[i].level > 0 && sc[i].text === heading) { start = i; lvl = sc[i].level; break; }
  }
  if (start < 0) return null;
  for (var j = start + 1; j < sc.length; j++) {
    if (sc[j].level > 0 && sc[j].level <= lvl) return { s: start, e: j };
  }
  return { s: start, e: sc.length };
}

// ---------------------------------------------------------------------- modes

function inventory(allNames) {
  var body = targetBody(target());
  var set = {}, a;
  for (a = 0; a < allNames.length; a++) set[allNames[a]] = true;
  var sc = scanBody(body), seen = {}, headings = [], i;
  for (i = 0; i < sc.length; i++) {
    var bn = baseName(sc[i].text, set);
    if (bn) seen[bn] = i;
    if (sc[i].level > 0) headings.push(sc[i].text);
  }
  var missing = [];
  for (a = 0; a < allNames.length; a++) if (!(allNames[a] in seen)) missing.push(allNames[a]);
  return { children: sc.length, found: allNames.length - missing.length,
           missing: missing, headings: headings };
}

/** Parse only. Proves a payload renders without touching the document. */
function selftest(md) {
  var ops = parseBlocks(md), counts = {};
  for (var i = 0; i < ops.length; i++) counts[ops[i].t] = (counts[ops[i].t] || 0) + 1;
  return { ok: true, mode: 'selftest', blocks: ops.length, kinds: counts };
}

/** Return the plain text of one check or section, for assertions. */
function readBlock(name, heading, allNames) {
  var body = targetBody(target());
  var set = {};
  for (var a = 0; a < allNames.length; a++) set[allNames[a]] = true;
  _SCAN = null;
  var r = heading ? sectionRange(body, heading) : checkRange(body, name, set);
  if (!r) return { ok: false, error: 'not found', id: name || heading };
  var sc = scanBody(body), lines = [];
  for (var i = r.s; i < r.e; i++) lines.push(sc[i].rule ? '---' : sc[i].text);
  return { ok: true, mode: 'read', id: name || heading, from: r.s, to: r.e,
           blocks: r.e - r.s, text: lines.join('\n') };
}

var EMITTABLE = { rule: 1, toc: 1, code: 1, h: 1, table: 1, callout: 1, quote: 1,
                  check: 1, row: 1, aside: 1, bullet: 1, para: 1, image: 1, li: 1, pagebreak: 1 };

/** Reject unknown block types before anything is written. */
function assertEmittable(ops) {
  for (var i = 0; i < ops.length; i++) {
    if (!EMITTABLE[ops[i].t]) throw new Error('no emitter for block type: ' + ops[i].t);
  }
}

/**
 * allNames is optional because push_to_doc.py's --rebuild never sends it
 * (rebuild predates that field) - harvested from the check blocks in this
 * same chunk when absent, which is what actually runs today. A chunk never
 * splits a check across the `---` boundary push_to_doc.py cuts on, so this
 * chunk's own names are always enough to bound them in applyStyleQueue_.
 */
function rebuild(md, append, allNames) {
  var ops = parseBlocks(md);          // parse first: a bad payload never clears the Doc
  assertEmittable(ops);               // and never clear for a block we cannot render

  if (!allNames || !allNames.length) {
    allNames = [];
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].t === 'check') allNames.push(ops[i].name);
    }
  }

  var doc = target(), body = targetBody(doc);
  if (!append) body.clear();
  _SCAN = null;
  STYLE_QUEUE = [];
  var before = body.getNumChildren();
  var n = emitBlocks(ops, new Sink(body, null));
  var ranges = [{ s: append ? before : 0, e: body.getNumChildren() }];
  // clear() leaves one empty paragraph behind; drop it now that real content exists
  if (!append && body.getNumChildren() > 1) {
    var first = body.getChild(0);
    if (first.getType() === DocumentApp.ElementType.PARAGRAPH &&
        first.asParagraph().getText().trim() === '') {
      body.removeChild(first);
    }
  }
  _SCAN = null;

  var styling = { queued: STYLE_QUEUE.length, applied: 0 };
  if (STYLE_QUEUE.length) {
    try {
      var docId = doc.getId();
      doc.saveAndClose();
      styling = STYLE === 'plain' ? applyRangeQueue_(docId, ranges) : applyStyleQueue_(docId, allNames);
    } catch (styleErr) {
      styling.error = String(styleErr);
    }
  }

  return { ok: true, mode: 'rebuild', blocks: n, styling: styling, at: new Date().toISOString() };
}

/**
 * Fires everything queued in STYLE_QUEUE as one batchUpdate call: pinned
 * table headers, a left-rail border on callouts, full-width row shading.
 * Needs the Docs advanced service enabled (see the SETUP note up top) - if
 * it isn't, this throws and the caller reports it without losing the patch.
 *
 * Matched by check name and exact text rather than by index, so it never has
 * to assume DocumentApp's child indices and the Docs API's content indices
 * line up. Two passes: first find where each queued check's own block starts
 * and ends (any check name is a boundary, using the same allNames every
 * other mode addresses by); second, walk only inside that block matching
 * queue entries to elements in the order they were queued.
 */
function applyStyleQueue_(docId, allNames) {
  if (!STYLE_QUEUE.length) return { queued: 0, applied: 0 };

  var set = {};
  for (var a = 0; a < allNames.length; a++) set[allNames[a]] = true;
  var wanted = {};
  for (var w = 0; w < STYLE_QUEUE.length; w++) wanted[STYLE_QUEUE[w].check] = true;

  function ptext(p) {
    var s = '', els = (p && p.elements) || [];
    for (var i = 0; i < els.length; i++) s += (els[i].textRun ? els[i].textRun.content : '');
    return s.replace(/\n$/, '');
  }

  var content = Docs.Documents.get(docId).body.content;

  var bounds = {}, curName = null, curStart = -1;
  for (var i = 0; i < content.length; i++) {
    var p = content[i].paragraph;
    if (!p) continue;
    var nm = baseName(ptext(p), set);
    if (nm) {
      if (curName && wanted[curName]) bounds[curName] = { s: curStart, e: i };
      curName = nm; curStart = i;
    }
  }
  if (curName && wanted[curName]) bounds[curName] = { s: curStart, e: content.length };

  var byCheck = {};
  for (var q = 0; q < STYLE_QUEUE.length; q++) {
    var item = STYLE_QUEUE[q];
    (byCheck[item.check] = byCheck[item.check] || []).push(item);
  }

  var requests = [], applied = 0;
  for (var name in bounds) {
    var b = bounds[name], queue = byCheck[name] || [], qi = 0;
    for (var j = b.s; j < b.e && qi < queue.length; j++) {
      var el = content[j], want = queue[qi];
      if (want.kind === 'row' && el.paragraph && ptext(el.paragraph) === want.text) {
        requests.push({ updateParagraphStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          paragraphStyle: { shading: { backgroundColor: { color: { rgbColor: want.rgb } } } },
          fields: 'shading.backgroundColor'
        }});
        qi++; applied++;
      } else if (want.kind === 'callout' && el.table &&
                 ptext(el.table.tableRows[0].tableCells[0].content[0].paragraph) === want.text) {
        requests.push({ updateTableCellStyle: {
          tableRange: { tableCellLocation: { tableStartLocation: { index: el.startIndex }, rowIndex: 0, columnIndex: 0 },
                        rowSpan: 1, columnSpan: 1 },
          tableCellStyle: { borderLeft: { width: { magnitude: 3, unit: 'PT' }, dashStyle: 'SOLID',
                                           color: { color: { rgbColor: want.rgb } } } },
          fields: 'borderLeft'
        }});
        qi++; applied++;
      } else if (want.kind === 'table' && el.table) {
        requests.push({ pinTableHeaderRows: { tableStartLocation: { index: el.startIndex }, pinnedHeaderRowsCount: 1 } });
        qi++; applied++;
      } else if (want.kind === 'keepWithNext' && el.paragraph && ptext(el.paragraph) === want.text) {
        requests.push({ updateParagraphStyle: {
          range: { startIndex: el.startIndex, endIndex: el.endIndex - 1 },
          paragraphStyle: { keepWithNext: true, keepLinesTogether: true },
          fields: 'keepWithNext,keepLinesTogether'
        }});
        qi++; applied++;
      }
    }
  }

  if (requests.length) Docs.Documents.batchUpdate({ requests: requests }, docId);
  return { queued: STYLE_QUEUE.length, applied: applied };
}

/**
 * Replace named checks or sections in place; everything else is untouched.
 * Each item is { markdown } plus either { name: "<check>" } or { heading: "<heading>" }.
 */
function patchAll(items, allNames) {
  var doc = target(), body = targetBody(doc), docId = doc.getId();
  var set = {};
  for (var a = 0; a < allNames.length; a++) set[allNames[a]] = true;
  var done = [], notFound = [], failed = [], ranges = [];
  STYLE_QUEUE = [];

  for (var n = 0; n < items.length; n++) {
    var it = items[n], id = it.name || it.heading, ops;

    try {
      ops = parseBlocks(it.markdown);       // parse before deleting anything
    } catch (err) {
      failed.push({ id: id, error: String(err) });
      continue;
    }
    if (!ops.length) { failed.push({ id: id, error: 'parsed to zero blocks' }); continue; }
    try { assertEmittable(ops); } catch (e2) { failed.push({ id: id, error: String(e2) }); continue; }

    _SCAN = null;
    var r = it.heading ? sectionRange(body, it.heading) : checkRange(body, it.name, set);
    if (!r) { notFound.push(id); continue; }
    if (r.s === 0 && r.e >= body.getNumChildren()) {
      failed.push({ id: id, error: 'range covers the whole body  -  refusing' });
      continue;
    }
    // Docs will not delete a body's final paragraph; give a range that runs to
    // the end an empty paragraph to stop in front of.
    if (r.e >= body.getNumChildren()) body.appendParagraph('');

    var before = body.getNumChildren();
    for (var j = r.e - 1; j >= r.s; j--) body.removeChild(body.getChild(j));
    emitBlocks(ops, new Sink(body, r.s));
    var inserted = body.getNumChildren() - (before - (r.e - r.s)), delta = inserted - (r.e - r.s);
    for (var q = 0; q < ranges.length; q++) {
      if (ranges[q].s >= r.e) { ranges[q].s += delta; ranges[q].e += delta; }
    }
    ranges.push({ s: r.s, e: r.s + inserted });
    done.push(id);
  }

  _SCAN = null;

  // Text content above is already safely written via DocumentApp. Everything
  // from here down is best-effort visual polish - never let it take the
  // patch itself down.
  var styling = { queued: STYLE_QUEUE.length, applied: 0 };
  if (STYLE_QUEUE.length && done.length) {
    try {
      doc.saveAndClose();
      styling = STYLE === 'plain' ? applyRangeQueue_(docId, ranges) : applyStyleQueue_(docId, allNames);
    } catch (styleErr) {
      styling.error = String(styleErr);
    }
  }

  return { ok: failed.length === 0, mode: 'patch', patched: done,
           notFound: notFound, failed: failed, styling: styling, at: new Date().toISOString() };
}

// ------------------------------------------------------- general-document modes
// Everything below serves ordinary documents (gdoc.py sends style: 'plain').
// Same rules as above: locate and validate first, touch the document last.

/** Every tab, depth-first, as { id, title, depth }. */
function listTabs_(doc) {
  var out = [];
  function walk(tabs, depth) {
    for (var i = 0; i < tabs.length; i++) {
      out.push({ id: tabs[i].getId(), title: tabs[i].getTitle(), depth: depth });
      walk(tabs[i].getChildTabs(), depth + 1);
    }
  }
  walk(doc.getTabs(), 0);
  return out;
}

function clip_(s, n) { s = String(s); return s.length > n ? s.substring(0, n) + '...' : s; }

/** Read-only map of the body: what each element is, so edits can be aimed. */
function outline(limit) {
  var doc = target(), body = targetBody(doc), n = body.getNumChildren(), items = [];
  var T = DocumentApp.ElementType, H = DocumentApp.ParagraphHeading, tables = 0;
  for (var i = 0; i < n && items.length < limit; i++) {
    var el = body.getChild(i), ty = el.getType(), it = { i: i };
    if (ty === T.PARAGRAPH) {
      var pa = el.asParagraph(), hd = pa.getHeading(), lv = headingLevel_(hd);
      it.type = lv ? 'h' + lv : hd === H.TITLE ? 'title' : hd === H.SUBTITLE ? 'subtitle' : 'p';
      it.text = clip_(pa.getText(), 300);
      if (!it.text && pa.findElement(T.HORIZONTAL_RULE)) it.type = 'rule';
    } else if (ty === T.LIST_ITEM) {
      var l = el.asListItem();
      it.type = 'li'; it.level = l.getNestingLevel(); it.glyph = String(l.getGlyphType());
      it.text = clip_(l.getText(), 300);
    } else if (ty === T.TABLE) {
      var t = el.asTable(), head = [];
      it.type = 'table'; it.table = tables; it.rows = t.getNumRows();
      it.cols = t.getNumRows() ? t.getRow(0).getNumCells() : 0;
      for (var c = 0; c < it.cols; c++) head.push(clip_(t.getCell(0, c).getText(), 60));
      it.header = head;
    } else {
      it.type = String(ty).toLowerCase();
    }
    if (ty === T.TABLE) tables++;
    items.push(it);
  }
  return { ok: true, mode: 'outline', doc: doc.getName(), tab: TAB_ID, children: n,
           truncated: n > items.length, items: items, tabs: listTabs_(doc) };
}

/** The whole tab as markdown, via Docs' own exporter. */
function exportMarkdown() {
  var doc = target(), md;
  if (TAB_ID && TAB_ID !== doc.getTabs()[0].getId()) {
    // getAs exports the first tab; for any other tab, fall back to our own flat rendering.
    md = null;
  } else {
    md = doc.getAs('text/markdown').getDataAsString();
  }
  if (md === null) {
    var o = outline(100000), lines = [];
    for (var i = 0; i < o.items.length; i++) {
      var it = o.items[i];
      if (/^h\d$/.test(it.type)) lines.push(new Array(+it.type.charAt(1) + 1).join('#') + ' ' + it.text);
      else if (it.type === 'li') lines.push(new Array(it.level + 1).join('  ') + '- ' + it.text);
      else if (it.type === 'table') lines.push('| ' + it.header.join(' | ') + ' |  (table ' + it.table + ', ' + it.rows + ' rows)');
      else if (it.type === 'rule') lines.push('---');
      else lines.push(it.text || '');
    }
    md = lines.join('\n');
  }
  var MAX = 200000;
  return { ok: true, mode: 'markdown', length: md.length, truncated: md.length > MAX,
           markdown: md.substring(0, MAX) };
}

/**
 * Indices [s, e) of body children whose text matches. Exact (trimmed) by
 * default; contains: true for a substring. Paragraphs and list items only.
 */
function matchText_(body, text, contains) {
  _SCAN = null;
  var sc = scanBody(body), hits = [], want = String(text).trim();
  for (var i = 0; i < sc.length; i++) {
    if (sc[i].rule) continue;
    var t = sc[i].text;
    if (contains ? (want && t.indexOf(want) >= 0) : t === want) hits.push(i);
  }
  return hits;
}

/** One child index from a {heading, where} or {afterText|beforeText} locator. */
function locate_(body, p) {
  var n = body.getNumChildren();
  if (p.heading) {
    _SCAN = null;
    var r = sectionRange(body, p.heading);
    if (!r) return { error: 'heading not found: ' + p.heading };
    var where = p.where || 'end';
    if (where === 'end') return { at: r.e };
    if (where === 'start') return { at: r.s + 1 };
    if (where === 'before') return { at: r.s };
    return { error: "where must be 'end', 'start' or 'before'" };
  }
  var key = p.afterText != null ? p.afterText : p.beforeText;
  if (key != null) {
    var hits = matchText_(body, key, p.contains === true);
    if (!hits.length) return { error: 'no paragraph matching: ' + key };
    if (hits.length > 1 && p.nth == null) {
      return { error: hits.length + ' paragraphs match - make the text unique or pass nth (0-based)' };
    }
    var h = hits[p.nth || 0];
    if (h == null) return { error: 'nth out of range (' + hits.length + ' matches)' };
    return { at: p.afterText != null ? h + 1 : h };
  }
  if (p.index != null) {
    if (p.index < 0 || p.index > n) return { error: 'index out of range 0..' + n };
    return { at: p.index };
  }
  return { at: n };
}

/** Insert markdown at a located position. Nothing is deleted. */
function insertAt(p) {
  var ops = parseBlocks(p.markdown || '');
  if (!ops.length) return { ok: false, error: 'markdown parsed to zero blocks' };
  assertEmittable(ops);
  var doc = target(), body = targetBody(doc), docId = doc.getId();
  var loc = locate_(body, p);
  if (loc.error) return { ok: false, error: loc.error };
  var before = body.getNumChildren(), at = loc.at;
  STYLE_QUEUE = [];
  var blocks = emitBlocks(ops, new Sink(body, at >= before ? null : at));
  var added = body.getNumChildren() - before;
  _SCAN = null;
  var styling = { queued: STYLE_QUEUE.length, applied: 0 };
  if (STYLE_QUEUE.length) {
    try { doc.saveAndClose(); styling = applyRangeQueue_(docId, [{ s: at, e: at + added }]); }
    catch (e) { styling.error = String(e); }
  }
  return { ok: true, mode: 'insert', at: at, blocks: blocks, added: added, styling: styling };
}

/** RE2-escape a literal. */
function reEscape_(s) { return String(s).replace(/[\\^$.|?*+()\[\]{}]/g, '\\$&'); }

/**
 * Find and replace. Literal by default (regex: true for RE2), case-sensitive
 * unless matchCase: false, optionally limited to one heading's section.
 * Counts first; `expect` refuses the edit if the count differs, and more than
 * 50 matches needs all: true.
 */
function replaceTextIn(p) {
  if (!p.find) return { ok: false, error: 'find is required' };
  var pattern = p.regex ? String(p.find) : reEscape_(p.find);
  if (p.matchCase === false) pattern = '(?i)' + pattern;
  var repl = p.replace == null ? '' : String(p.replace);
  var doc = target(), body = targetBody(doc), els = [];
  if (p.heading) {
    _SCAN = null;
    var r = sectionRange(body, p.heading);
    if (!r) return { ok: false, error: 'heading not found: ' + p.heading };
    for (var i = r.s; i < r.e; i++) els.push(body.getChild(i));
  } else {
    els.push(body);
  }
  var count = 0, where = [];
  for (var k = 0; k < els.length; k++) {
    var res = null;
    while ((res = els[k].findText(pattern, res)) !== null) {
      count++;
      if (where.length < 10) where.push(clip_(res.getElement().asText().getText(), 160));
    }
  }
  if (!count) return { ok: false, error: 'no match for: ' + p.find, count: 0 };
  if (p.expect != null && count !== p.expect) {
    return { ok: false, error: 'found ' + count + ' matches, expected ' + p.expect + ' - nothing changed',
             count: count, where: where };
  }
  if (count > 50 && p.all !== true) {
    return { ok: false, error: count + ' matches - send all: true to replace them all', count: count, where: where };
  }
  // The replacement is inserted literally - "$5" and backslashes arrive as
  // typed (verified against a live doc 2026-09-23), so it is passed through.
  for (var m = 0; m < els.length; m++) els[m].replaceText(pattern, repl);
  return { ok: true, mode: 'replaceText', count: count, where: where };
}

/**
 * Delete a heading's whole section, or paragraphs/list items by text.
 * Exact text must be unique unless all: true. Never empties the body.
 */
function deleteBlocks(p) {
  var doc = target(), body = targetBody(doc), idx = [];
  if (p.heading) {
    _SCAN = null;
    var r = sectionRange(body, p.heading);
    if (!r) return { ok: false, error: 'heading not found: ' + p.heading };
    for (var i = r.s; i < r.e; i++) idx.push(i);
  } else if (p.text != null) {
    idx = matchText_(body, p.text, p.contains === true);
    if (!idx.length) return { ok: false, error: 'no paragraph matching: ' + p.text };
    if (idx.length > 1 && p.all !== true) {
      return { ok: false, error: idx.length + ' paragraphs match - send all: true to delete them all' };
    }
  } else {
    return { ok: false, error: 'send heading or text' };
  }
  var n = body.getNumChildren();
  if (idx.length >= n) return { ok: false, error: 'that would empty the document - refusing' };
  if (idx[idx.length - 1] >= n - 1) body.appendParagraph('');
  _SCAN = null;
  var sc = scanBody(body), gone = [];
  for (var g = 0; g < idx.length && gone.length < 20; g++) gone.push(clip_(sc[idx[g]].text || '[' + 'non-text element]', 120));
  for (var j = idx.length - 1; j >= 0; j--) body.removeChild(body.getChild(idx[j]));
  _SCAN = null;
  return { ok: true, mode: 'delete', deleted: idx.length, removed: gone };
}

/** The n-th table in the body, by index, first-row text, or first under a heading. */
function findTable_(body, sel) {
  var T = DocumentApp.ElementType, tables = [];
  for (var i = 0; i < body.getNumChildren(); i++) {
    if (body.getChild(i).getType() === T.TABLE) tables.push({ i: i, t: body.getChild(i).asTable() });
  }
  if (!tables.length) return { error: 'the document has no tables' };
  sel = sel || {};
  if (sel.index != null) {
    return tables[sel.index] ? { t: tables[sel.index].t, n: sel.index }
                             : { error: 'table index out of range 0..' + (tables.length - 1) };
  }
  if (sel.header != null) {
    var want = String(sel.header).trim().toLowerCase(), hits = [];
    for (var a = 0; a < tables.length; a++) {
      var row = tables[a].t.getNumRows() ? tables[a].t.getRow(0) : null;
      for (var c = 0; row && c < row.getNumCells(); c++) {
        if (row.getCell(c).getText().trim().toLowerCase() === want) { hits.push(a); break; }
      }
    }
    if (hits.length === 1) return { t: tables[hits[0]].t, n: hits[0] };
    return { error: hits.length ? hits.length + ' tables have that header - pass table.index'
                                : 'no table has a header cell "' + sel.header + '"' };
  }
  if (sel.heading != null) {
    _SCAN = null;
    var r = sectionRange(body, sel.heading);
    if (!r) return { error: 'heading not found: ' + sel.heading };
    for (var b = 0; b < tables.length; b++) {
      if (tables[b].i >= r.s && tables[b].i < r.e) return { t: tables[b].t, n: b };
    }
    return { error: 'no table under heading ' + sel.heading };
  }
  if (tables.length === 1) return { t: tables[0].t, n: 0 };
  return { error: tables.length + ' tables - say which with table.index, table.header or table.heading' };
}

/** Row index from row (number) or matchRow (text of a cell in column matchCol, default 0). */
function findRow_(t, p) {
  if (p.row != null) {
    return p.row >= 0 && p.row < t.getNumRows() ? { r: p.row } : { error: 'row out of range 0..' + (t.getNumRows() - 1) };
  }
  if (p.matchRow != null) {
    var col = colIndex_(t, p.matchCol == null ? 0 : p.matchCol);
    if (col.error) return col;
    var want = String(p.matchRow).trim(), hits = [];
    for (var r = 1; r < t.getNumRows(); r++) {
      var row = t.getRow(r);
      if (col.c < row.getNumCells() && row.getCell(col.c).getText().trim() === want) hits.push(r);
    }
    if (hits.length === 1) return { r: hits[0] };
    return { error: hits.length ? hits.length + ' rows match - pass row' : 'no row with "' + want + '"' };
  }
  return { error: 'send row or matchRow' };
}

/** Column index from a number or a header-cell name (case-insensitive). */
function colIndex_(t, col) {
  if (typeof col === 'number') return { c: col };
  var head = t.getRow(0), want = String(col).trim().toLowerCase();
  for (var c = 0; c < head.getNumCells(); c++) {
    if (head.getCell(c).getText().trim().toLowerCase() === want) return { c: c };
  }
  return { error: 'no column named "' + col + '"' };
}

/** Write markdown into a cell, keeping the reference cell's look if given. */
function fillCell_(cell, md, ref) {
  var rt = richText(String(md == null ? '' : md));
  cell.setText(rt.text);
  var txt = cell.editAsText();
  if (ref && rt.text.length) {
    var r = ref.editAsText(), a = r.getText().length ? r.getAttributes() : null;
    clearInline_(txt);
    if (a) {
      var keep = {};
      var KEYS = [DocumentApp.Attribute.FONT_FAMILY, DocumentApp.Attribute.FONT_SIZE,
                  DocumentApp.Attribute.FOREGROUND_COLOR, DocumentApp.Attribute.BOLD,
                  DocumentApp.Attribute.ITALIC];
      for (var k = 0; k < KEYS.length; k++) if (a[KEYS[k]] != null) keep[KEYS[k]] = a[KEYS[k]];
      // A new row can pick up the header's bold; match the reference row instead.
      keep[DocumentApp.Attribute.BOLD] = a[DocumentApp.Attribute.BOLD] === true;
      keep[DocumentApp.Attribute.ITALIC] = a[DocumentApp.Attribute.ITALIC] === true;
      txt.setAttributes(keep);
    }
    var bg = ref.getBackgroundColor();
    if (bg) cell.setBackgroundColor(bg);
  } else if (rt.text.length) {
    clearInline_(txt);
  }
  applySpans(txt, 0, rt.spans);
}

/** Table rows and cells: read, appendRow, insertRow, updateCell, deleteRow (+ tableMore_ ops). */
function tableEdit(p) {
  var doc = target(), body = targetBody(doc), f = findTable_(body, p.table);
  if (f.error) return { ok: false, error: f.error };
  var more = tableMore_(p, f);
  if (more) return more;
  var t = f.t, op = p.op || 'read', cols = t.getNumRows() ? t.getRow(0).getNumCells() : 0;

  if (op === 'read') {
    var grid = [];
    for (var r = 0; r < t.getNumRows() && r < 500; r++) {
      var row = [], tr = t.getRow(r);
      for (var c = 0; c < tr.getNumCells(); c++) row.push(tr.getCell(c).getText());
      grid.push(row);
    }
    return { ok: true, mode: 'table', op: op, table: f.n, rows: t.getNumRows(), cols: cols, grid: grid };
  }

  if (op === 'appendRow' || op === 'insertRow') {
    var cells = p.cells || [];
    if (cells.length > cols) return { ok: false, error: cells.length + ' cells for a ' + cols + '-column table' };
    var at = op === 'appendRow' ? t.getNumRows() : p.at;
    if (op === 'insertRow' && (at == null || at < 1 || at > t.getNumRows())) {
      return { ok: false, error: 'insertRow needs at between 1 and ' + t.getNumRows() + ' (0 is the header)' };
    }
    // Style new cells like the body row next to them; a header-only table has none.
    var refRow = t.getNumRows() > 1 ? t.getRow(op === 'appendRow' ? t.getNumRows() - 1 : Math.max(1, at - 1)) : null;
    var nr = op === 'appendRow' ? t.appendTableRow() : t.insertTableRow(at);
    for (var k = 0; k < cols; k++) {
      var cell = nr.appendTableCell('');
      fillCell_(cell, cells[k], refRow && k < refRow.getNumCells() ? refRow.getCell(k) : null);
    }
    return { ok: true, mode: 'table', op: op, table: f.n, row: at, rows: t.getNumRows() };
  }

  if (op === 'updateCell') {
    var fr = findRow_(t, p);
    if (fr.error) return { ok: false, error: fr.error };
    var ci = colIndex_(t, p.col == null ? 0 : p.col);
    if (ci.error) return { ok: false, error: ci.error };
    var trow = t.getRow(fr.r);
    if (ci.c >= trow.getNumCells()) return { ok: false, error: 'column out of range' };
    var target_ = trow.getCell(ci.c), was = target_.getText();
    fillCell_(target_, p.text, target_);
    return { ok: true, mode: 'table', op: op, table: f.n, row: fr.r, col: ci.c, was: clip_(was, 200) };
  }

  if (op === 'deleteRow') {
    var dr = findRow_(t, p);
    if (dr.error) return { ok: false, error: dr.error };
    if (dr.r === 0 && p.allowHeader !== true) return { ok: false, error: 'row 0 is the header - send allowHeader: true' };
    if (t.getNumRows() < 2) return { ok: false, error: 'cannot delete the only row of a table' };
    var gone = [];
    for (var g = 0; g < t.getRow(dr.r).getNumCells(); g++) gone.push(clip_(t.getCell(dr.r, g).getText(), 60));
    t.removeRow(dr.r);
    return { ok: true, mode: 'table', op: op, table: f.n, removed: gone, rows: t.getNumRows() };
  }

  return { ok: false, error: 'unknown table op: ' + op };
}

/** The Docs API body for this request's tab. */
function apiBody_(docId) {
  if (!TAB_ID) return Docs.Documents.get(docId).body;
  var d = Docs.Documents.get(docId, { includeTabsContent: true });
  function find(tabs) {
    for (var i = 0; tabs && i < tabs.length; i++) {
      if (tabs[i].tabProperties.tabId === TAB_ID) return tabs[i].documentTab.body;
      var b = find(tabs[i].childTabs);
      if (b) return b;
    }
    return null;
  }
  var body = find(d.tabs);
  if (!body) throw new Error('Docs API has no tab ' + TAB_ID);
  return body;
}

/**
 * Plain-style polish. Like applyStyleQueue_, but located by the child-index
 * ranges this request wrote rather than by check names, so nothing that was
 * already in the document can be restyled. The Docs API body starts with a
 * section break, hence the offset.
 */
function applyRangeQueue_(docId, ranges) {
  if (!STYLE_QUEUE.length) return { queued: 0, applied: 0 };
  function ptext(p) {
    var s = '', els = (p && p.elements) || [];
    for (var i = 0; i < els.length; i++) s += (els[i].textRun ? els[i].textRun.content : '');
    return s.replace(/\n$/, '');
  }
  function loc(o) { if (TAB_ID) o.tabId = TAB_ID; return o; }

  var content = apiBody_(docId).content, off = content.length && content[0].sectionBreak ? 1 : 0;
  var cand = [];
  ranges.sort(function (a, b) { return a.s - b.s; });
  for (var r = 0; r < ranges.length; r++) {
    for (var j = ranges[r].s + off; j < ranges[r].e + off && j < content.length; j++) cand.push(content[j]);
  }

  var requests = [], applied = 0, qi = 0, unchecked = 0, runs = [];
  for (var c = 0; c < cand.length && qi < STYLE_QUEUE.length; c++) {
    var el = cand[c], want = STYLE_QUEUE[qi];
    if (want.kind === 'list' && el.paragraph && ptext(el.paragraph) === want.items[0].text) {
      // The run's items are consecutive paragraphs; confirm each before touching any.
      var paras = [];
      for (var m = 0; m < want.items.length && c + m < cand.length; m++) {
        var pe = cand[c + m];
        if (!pe.paragraph || ptext(pe.paragraph) !== want.items[m].text) break;
        paras.push(pe);
      }
      if (paras.length === want.items.length) {
        runs.push({ paras: paras, want: want });
        unchecked += want.preset === 'BULLET_CHECKBOX' ? want.checked : 0;
        c += paras.length - 1; applied++;
      }
      qi++;
    } else if (want.kind === 'callout' && el.table &&
               ptext(el.table.tableRows[0].tableCells[0].content[0].paragraph) === want.text) {
      requests.push({ updateTableCellStyle: {
        tableRange: { tableCellLocation: { tableStartLocation: loc({ index: el.startIndex }), rowIndex: 0, columnIndex: 0 },
                      rowSpan: 1, columnSpan: 1 },
        tableCellStyle: { borderLeft: { width: { magnitude: 3, unit: 'PT' }, dashStyle: 'SOLID',
                                         color: { color: { rgbColor: want.rgb } } } },
        fields: 'borderLeft' } });
      qi++; applied++;
    } else if (want.kind === 'table' && el.table) {
      requests.push({ pinTableHeaderRows: { tableStartLocation: loc({ index: el.startIndex }), pinnedHeaderRowsCount: 1 } });
      qi++; applied++;
    }
  }
  // Each list run: drop DocumentApp's bullets, then create the list with its
  // preset - which, as the preceding list has a different preset or none,
  // starts a list of its own. deleteParagraphBullets keeps each item's nesting
  // as indent, and createParagraphBullets reads it back as the nesting level,
  // so no leading tabs are needed (adding them doubled the depth - seen
  // 2026-09-23). Neither request moves any index.
  for (var ri = runs.length - 1; ri >= 0; ri--) {
    var ps = runs[ri].paras, w = runs[ri].want, start = ps[0].startIndex, end = ps[ps.length - 1].endIndex;
    requests.push({ deleteParagraphBullets: { range: loc({ startIndex: start, endIndex: end - 1 }) } });
    requests.push({ createParagraphBullets: { range: loc({ startIndex: start, endIndex: end - 1 }),
                                              bulletPreset: w.preset } });
  }
  if (requests.length) Docs.Documents.batchUpdate({ requests: requests }, docId);
  var out = { queued: STYLE_QUEUE.length, applied: applied };
  // The API can make a checkbox but not tick it.
  if (unchecked) out.note = unchecked + ' item(s) marked [x] were created unticked - the API cannot tick a box';
  return out;
}

// ------------------------------------------------------------------- v3 modes
// Chips, styling, comments, templates, tabs, headers/footers, section copy, batch.

/**
 * @[someone@x.com] and @date(2026-09-30) or @date(2026-09-30 14:00) become
 * numbered placeholders here; finishChips_ swaps each for a real chip once the
 * text is in the document. DocumentApp cannot create chips; the Docs API can.
 */
function chipToken_(n) {
  if (!CHIP_NONCE) CHIP_NONCE = Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  return '[[chip:' + CHIP_NONCE + ':' + n + ']]';
}

function chipTokens_(str) {
  return String(str)
    .replace(/@\[([^\]\s@]+@[^\]\s]+)\]/g, function (m, email) {
      CHIPS.push({ type: 'person', email: email });
      return chipToken_(CHIPS.length - 1);
    })
    .replace(/@date\((\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}))?\)/g, function (m, d, t) {
      CHIPS.push({ type: 'date', date: d, time: t || null });
      return chipToken_(CHIPS.length - 1);
    })
    .replace(/@file\((https:\/\/[^)\s]+)\)/g, function (m, uri) {
      CHIPS.push({ type: 'file', uri: uri });
      return chipToken_(CHIPS.length - 1);
    })
    .replace(/\[\^([^\]]+)\]/g, function (m, note) {
      CHIPS.push({ type: 'footnote', text: note });
      return chipToken_(CHIPS.length - 1);
    });
}

/** Flush DocumentApp, then replace every placeholder with its chip, last first. */
function finishChips_(docId) {
  for (var h = 0; h < OPENED.length; h++) { try { OPENED[h].saveAndClose(); } catch (e) {} }
  OPENED = [];
  var hits = [];
  function walk(content) {
    for (var i = 0; content && i < content.length; i++) {
      var el = content[i];
      if (el.paragraph) {
        var pe = el.paragraph.elements || [];
        for (var j = 0; j < pe.length; j++) {
          var tr = pe[j].textRun;
          if (!tr || tr.content.indexOf('[[chip:' + CHIP_NONCE + ':') < 0) continue;
          var re = new RegExp('\\[\\[chip:' + CHIP_NONCE + ':(\\d+)\\]\\]', 'g'), m;
          while ((m = re.exec(tr.content)) !== null) {
            hits.push({ s: pe[j].startIndex + m.index, e: pe[j].startIndex + m.index + m[0].length, n: +m[1] });
          }
        }
      } else if (el.table) {
        var rows = el.table.tableRows || [];
        for (var r = 0; r < rows.length; r++) {
          var cells = rows[r].tableCells || [];
          for (var c = 0; c < cells.length; c++) walk(cells[c].content);
        }
      }
    }
  }
  walk(apiBody_(docId).content);
  hits.sort(function (x, y) { return y.s - x.s; });
  function loc(o) { if (TAB_ID) o.tabId = TAB_ID; return o; }
  var requests = [], pairs = [];
  for (var k = 0; k < hits.length; k++) {
    var chip = CHIPS[hits[k].n];
    if (!chip) continue;
    requests.push({ deleteContentRange: { range: loc({ startIndex: hits[k].s, endIndex: hits[k].e }) } });
    if (chip.type === 'person') {
      requests.push({ insertPerson: { personProperties: { email: chip.email }, location: loc({ index: hits[k].s }) } });
    } else if (chip.type === 'file') {
      requests.push({ insertRichLink: { richLinkProperties: { uri: chip.uri }, location: loc({ index: hits[k].s }) } });
    } else if (chip.type === 'footnote') {
      requests.push({ createFootnote: { location: loc({ index: hits[k].s }) } });
    } else {
      var props = { dateFormat: 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED' };
      if (chip.time) {
        // The API refuses timeZoneId with this time format (seen 2026-09-23), and
        // an unzoned chip shows its timestamp in UTC - so the wall-clock time is
        // written as UTC, and 14:00 displays as 2:00 PM for every reader.
        var hm = chip.time.split(':');
        props.timestamp = chip.date + 'T' + ('0' + hm[0]).slice(-2) + ':' + hm[1] + ':00Z';
        props.timeFormat = 'TIME_FORMAT_HOUR_MINUTE';
      } else {
        props.timestamp = chip.date + 'T12:00:00Z';   // noon UTC: the same calendar day everywhere
      }
      requests.push({ insertDate: { dateElementProperties: props, location: loc({ index: hits[k].s }) } });
    }
    pairs.push({ n: hits[k].n, reqs: requests.slice(-2) });
  }
  if (!hits.length) return { placed: 0, error: 'placeholders not found through the Docs API - left as ' + chipToken_(0) + '...' };
  var placed = hits.length, failed = [], errors = [];
  try {
    if (requests.length) Docs.Documents.batchUpdate({ requests: requests }, docId);
  } catch (err) {
    // One bad chip fails the whole batch; place them one at a time instead, last
    // first so each index is still valid, and keep the rest as plain text.
    placed = 0;
    for (var pi = 0; pi < pairs.length; pi++) {
      try { Docs.Documents.batchUpdate({ requests: pairs[pi].reqs }, docId); placed++; }
      catch (e1) { failed.push(pairs[pi].n); if (errors.length < 3) errors.push(String(e1)); }
    }
  }
  var notes = fillFootnotes_(docId, hits);
  if (failed.length) {
    // Never leave placeholder marks behind: the failures become plain text.
    var body = targetBody(DocumentApp.openById(docId));
    for (var q = 0; q < failed.length; q++) {
      var c2 = CHIPS[failed[q]];
      var txt = c2.type === 'person' ? c2.email : c2.type === 'file' ? c2.uri :
                c2.type === 'footnote' ? '(' + c2.text + ')' : c2.date + (c2.time ? ' ' + c2.time : '');
      body.replaceText(reEscape_(chipToken_(failed[q])), txt);
    }
    return { placed: placed, asText: failed.length, errors: errors, footnotes: notes };
  }
  return notes ? { placed: placed, footnotes: notes } : { placed: placed };
}

/** Matches of p.find within the section (or whole body): [{el: Text, s, e}]. */
function findMatches_(body, p) {
  var pattern = p.regex ? String(p.find) : reEscape_(p.find);
  if (p.matchCase === false) pattern = '(?i)' + pattern;
  var els = [];
  if (p.heading) {
    _SCAN = null;
    var r = sectionRange(body, p.heading);
    if (!r) return { error: 'heading not found: ' + p.heading };
    for (var i = r.s; i < r.e; i++) els.push(body.getChild(i));
  } else {
    els.push(body);
  }
  var hits = [];
  for (var k = 0; k < els.length; k++) {
    var res = null;
    while ((res = els[k].findText(pattern, res)) !== null) {
      hits.push({ el: res.getElement().asText(), s: res.getStartOffset(), e: res.getEndOffsetInclusive(),
                  whole: res.getElement() });
    }
  }
  if (!hits.length) return { error: 'no match for: ' + p.find };
  if (p.expect != null && hits.length !== p.expect) {
    return { error: 'found ' + hits.length + ' matches, expected ' + p.expect + ' - nothing changed' };
  }
  if (hits.length > 50 && p.all !== true) return { error: hits.length + ' matches - send all: true' };
  return { hits: hits };
}

/**
 * Restyle existing text: bold, italic, underline, strike (true/false), color,
 * highlight (hex, or 'none'), size (pt), font, link (url, or 'none').
 * line: true styles the whole paragraph each match is in.
 */
function styleText(p) {
  if (!p.find) return { ok: false, error: 'find is required' };
  var doc = target(), f = findMatches_(targetBody(doc), p);
  if (f.error) return { ok: false, error: f.error };
  var seen = [], n = 0;
  for (var i = 0; i < f.hits.length; i++) {
    var h = f.hits[i], t = h.el, s = h.s, e = h.e;
    if (p.line) {
      var par = h.whole;
      while (par && par.getType() !== DocumentApp.ElementType.PARAGRAPH &&
             par.getType() !== DocumentApp.ElementType.LIST_ITEM) par = par.getParent();
      if (!par || seen.indexOf(par) >= 0) continue;
      seen.push(par);
      t = par.editAsText(); s = 0; e = t.getText().length - 1;
      if (e < 0) continue;
    }
    if (p.bold != null) t.setBold(s, e, !!p.bold);
    if (p.italic != null) t.setItalic(s, e, !!p.italic);
    if (p.underline != null) t.setUnderline(s, e, !!p.underline);
    if (p.strike != null) t.setStrikethrough(s, e, !!p.strike);
    if (p.color) t.setForegroundColor(s, e, p.color === 'none' ? null : p.color);
    if (p.highlight) t.setBackgroundColor(s, e, p.highlight === 'none' ? null : p.highlight === true || p.highlight === 'yes' ? HIGHLIGHT : p.highlight);
    if (p.size) t.setFontSize(s, e, +p.size);
    if (p.font) t.setFontFamily(s, e, p.font);
    if (p.link) t.setLinkUrl(s, e, p.link === 'none' ? null : p.link);
    n++;
  }
  return { ok: true, mode: 'style', styled: n };
}

/** Turn existing text into a person chip (email) or a date chip (date). */
function mentionText(p) {
  if (!p.find || !(p.email || p.date)) return { ok: false, error: 'send find plus email or date' };
  var chipMd = p.email ? '@[' + p.email + ']' : '@date(' + p.date + ')';
  if (chipTokens_(chipMd) === chipMd) return { ok: false, error: 'not a valid email or YYYY-MM-DD date' };
  CHIPS = [];
  var doc = target(), f = findMatches_(targetBody(doc), p);
  if (f.error) return { ok: false, error: f.error };
  // Last match first so earlier offsets in the same paragraph stay valid.
  for (var i = f.hits.length - 1; i >= 0; i--) {
    var h = f.hits[i], tok = chipTokens_(chipMd);
    h.el.deleteText(h.s, h.e);
    h.el.insertText(h.s, tok);
  }
  return { ok: true, mode: 'mention', replaced: f.hits.length };
}

/** Set (or clear, text '') the header or footer of the doc / tab. */
function headerFooter(p) {
  var doc = target(), holder = TAB_ID ? doc.getTab(TAB_ID).asDocumentTab() : doc;
  var which = p.which === 'footer' ? 'footer' : 'header';
  var sec = which === 'footer' ? holder.getFooter() : holder.getHeader();
  var was = sec ? sec.getText() : '';
  if (!sec) {
    if (!p.text) return { ok: true, mode: 'headerFooter', which: which, was: '', note: 'nothing to clear' };
    sec = which === 'footer' ? holder.addFooter() : holder.addHeader();
  }
  sec.setText(p.text || '');
  return { ok: true, mode: 'headerFooter', which: which, was: clip_(was, 300) };
}

/** Tabs: list, add {title, parentTabId, index, emoji}, rename {tabId, title, emoji}. */
function tabsEdit(p) {
  var op = p.op || 'list';
  if (op === 'list') return { ok: true, mode: 'tabs', tabs: listTabs_(target()) };
  var docId = DOC_ID || target().getId();
  if (op === 'add') {
    var tp = {};
    if (p.title) tp.title = p.title;
    if (p.parentTabId) tp.parentTabId = p.parentTabId;
    if (p.index != null) tp.index = p.index;
    if (p.emoji) tp.iconEmoji = p.emoji;
    var res = Docs.Documents.batchUpdate({ requests: [{ addDocumentTab: { tabProperties: tp } }] }, docId);
    var rep = res.replies && res.replies[0] && res.replies[0].addDocumentTab;
    return { ok: true, mode: 'tabs', op: op, tab: rep ? rep.tabProperties : null };
  }
  if (op === 'rename') {
    if (!p.tabId) return { ok: false, error: 'rename needs tabId (see tabs list)' };
    var props = { tabId: p.tabId }, fields = [];
    if (p.title) { props.title = p.title; fields.push('title'); }
    if (p.emoji) { props.iconEmoji = p.emoji; fields.push('iconEmoji'); }
    if (!fields.length) return { ok: false, error: 'send title and/or emoji' };
    Docs.Documents.batchUpdate({ requests: [{ updateDocumentTabProperties: { tabProperties: props, fields: fields.join(',') } }] }, docId);
    return { ok: true, mode: 'tabs', op: op, tabId: p.tabId };
  }
  return { ok: false, error: 'unknown tabs op: ' + op + ' (list, add, rename)' };
}

/** Copy the doc (a template) under a new title; returns the copy's id and link. */
function copyDoc(p) {
  if (!p.title) return { ok: false, error: 'copy needs a title' };
  var src = DriveApp.getFileById(DOC_ID);
  var copy = p.folderId ? src.makeCopy(p.title, DriveApp.getFolderById(p.folderId)) : src.makeCopy(p.title);
  return { ok: true, mode: 'copy', id: copy.getId(), url: copy.getUrl(), title: copy.getName() };
}

/** Fill {{key}} placeholders in the body, header and footer. Reports misses and leftovers. */
function fillTemplate(p) {
  var values = p.values || {}, doc = target(), holder = TAB_ID ? doc.getTab(TAB_ID).asDocumentTab() : doc;
  var parts = [targetBody(doc)];
  if (holder.getHeader()) parts.push(holder.getHeader());
  if (holder.getFooter()) parts.push(holder.getFooter());
  var filled = {}, missing = [];
  for (var key in values) {
    var pat = '\\{\\{\\s*' + reEscape_(key) + '\\s*\\}\\}', count = 0;
    for (var i = 0; i < parts.length; i++) {
      var r = null;
      while ((r = parts[i].findText(pat, r)) !== null) count++;
      if (count) parts[i].replaceText(pat, String(values[key]));
    }
    if (count) filled[key] = count; else missing.push(key);
  }
  var left = [];
  for (var j = 0; j < parts.length; j++) {
    var r2 = null;
    while ((r2 = parts[j].findText('\\{\\{[^}]+\\}\\}', r2)) !== null && left.length < 30) {
      var t = r2.getElement().asText().getText().substring(r2.getStartOffset(), r2.getEndOffsetInclusive() + 1);
      if (left.indexOf(t) < 0) left.push(t);
    }
  }
  return { ok: true, mode: 'fill', filled: filled, notInDoc: missing, stillUnfilled: left };
}

/** Copy a section (fromHeading) of another doc to a located spot here, formatting intact. */
function copySection(p) {
  if (!p.fromDoc || !p.fromHeading) return { ok: false, error: 'send fromDoc and fromHeading' };
  var sdoc = DocumentApp.openById(p.fromDoc);
  var sbody = p.fromTab ? sdoc.getTab(p.fromTab).asDocumentTab().getBody() : sdoc.getBody();
  _SCAN = null;
  var r = sectionRange(sbody, p.fromHeading);
  if (!r) return { ok: false, error: 'heading not found in source: ' + p.fromHeading };
  var copies = [], T = DocumentApp.ElementType;
  for (var i = r.s; i < r.e; i++) copies.push(sbody.getChild(i).copy());
  _SCAN = null;
  var doc = target(), body = targetBody(doc), loc = locate_(body, p);
  if (loc.error) return { ok: false, error: loc.error };
  var at = loc.at, n = 0, skipped = 0, end = at >= body.getNumChildren();
  for (var k = 0; k < copies.length; k++) {
    var c = copies[k], ty = c.getType();
    if (ty === T.PARAGRAPH) end ? body.appendParagraph(c.asParagraph()) : body.insertParagraph(at + n, c.asParagraph());
    else if (ty === T.LIST_ITEM) end ? body.appendListItem(c.asListItem()) : body.insertListItem(at + n, c.asListItem());
    else if (ty === T.TABLE) end ? body.appendTable(c.asTable()) : body.insertTable(at + n, c.asTable());
    else { skipped++; continue; }
    n++;
  }
  _SCAN = null;
  return { ok: true, mode: 'copySection', copied: n, skipped: skipped, at: at };
}

/** Several modes in order, one request. Stops at the first failure. */
function batchRun(p) {
  var ops = p.ops || [], results = [];
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i], m = o.mode;
    if (m === 'batch' || (m === 'rebuild' && !o.append)) {
      return { ok: false, error: 'op ' + i + ': ' + m + ' is not allowed in a batch', done: results };
    }
    CHIP_NONCE = '';
    var r = run_(m, o);
    results.push(r);
    if (!r.ok) return { ok: false, error: 'op ' + i + ' (' + m + ') failed: ' + r.error, done: results };
  }
  return { ok: true, mode: 'batch', ran: results.length, results: results };
}

// Comments need the Drive advanced service (Editor > Services > Drive API).
function drive_() {
  if (typeof Drive === 'undefined') throw new Error('comments need the Drive API service - in the Apps Script editor: Services > + > Drive API > Add, then redeploy');
  return Drive;
}

function listComments(p) {
  var res = drive_().Comments.list(DOC_ID, { pageSize: 100, includeDeleted: false,
    fields: 'comments(id,content,createdTime,resolved,author(displayName,emailAddress),quotedFileContent(value),replies(id,content,action,createdTime,author(displayName)))' });
  var out = [], cs = res.comments || [];
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i];
    if (p.open && c.resolved) continue;
    out.push({ id: c.id, by: c.author ? c.author.displayName : '', at: c.createdTime, resolved: !!c.resolved,
               on: c.quotedFileContent ? clip_(c.quotedFileContent.value, 200) : null, text: c.content,
               replies: (c.replies || []).map(function (r) {
                 return { by: r.author ? r.author.displayName : '', text: r.content || '', action: r.action || null };
               }) });
  }
  return { ok: true, mode: 'comments', count: out.length, comments: out };
}

function addComment(p) {
  if (!p.text) return { ok: false, error: 'comment needs text' };
  var c = drive_().Comments.create({ content: p.text }, DOC_ID, { fields: 'id,content' });
  return { ok: true, mode: 'comment', id: c.id };
}

function replyComment(p) {
  if (!p.commentId || !(p.text || p.resolve || p.reopen)) return { ok: false, error: 'send commentId plus text and/or resolve' };
  var body = {};
  if (p.text) body.content = p.text;
  if (p.resolve) body.action = 'resolve';
  else if (p.reopen) body.action = 'reopen';
  var r = drive_().Replies.create(body, DOC_ID, p.commentId, { fields: 'id,action' });
  return { ok: true, mode: 'reply', id: r.id, action: r.action || null };
}

// ------------------------------------------------------------------- v4 modes
// Footnotes, table colour/columns/merge/widths, doc styles, page setup,
// links to headings, tab delete. (An in-doc menu was tried and removed
// 2026-09-23: bound-doc only, and menu edits are invisible to the Docs API
// until the menu function returns.)

/** The Docs API view of this request's tab: { body, footnotes }. */
function apiTab_(docId) {
  if (!TAB_ID) { var d0 = Docs.Documents.get(docId); return { body: d0.body, footnotes: d0.footnotes || {} }; }
  var d = Docs.Documents.get(docId, { includeTabsContent: true });
  function find(tabs) {
    for (var i = 0; tabs && i < tabs.length; i++) {
      if (tabs[i].tabProperties.tabId === TAB_ID) return tabs[i].documentTab;
      var t = find(tabs[i].childTabs);
      if (t) return t;
    }
    return null;
  }
  var dt = find(d.tabs);
  if (!dt) throw new Error('Docs API has no tab ' + TAB_ID);
  return { body: dt.body, footnotes: dt.footnotes || {} };
}

/**
 * createFootnote leaves an empty footnote (" \n"). Match the new, still-empty
 * footnotes to this request's footnote chips in document order and write
 * their text. Pre-existing footnotes always have text, so they never match.
 */
function fillFootnotes_(docId, hits) {
  var want = [];
  var asc = hits.slice().sort(function (a, b) { return a.s - b.s; });
  for (var i = 0; i < asc.length; i++) {
    var c = CHIPS[asc[i].n];
    if (c && c.type === 'footnote') want.push(c.text);
  }
  if (!want.length) return null;
  var tab = apiTab_(docId), refs = [];
  function walk(content) {
    for (var i = 0; content && i < content.length; i++) {
      var el = content[i];
      if (el.paragraph) {
        var pe = el.paragraph.elements || [];
        for (var j = 0; j < pe.length; j++) if (pe[j].footnoteReference) refs.push(pe[j].footnoteReference.footnoteId);
      } else if (el.table) {
        (el.table.tableRows || []).forEach(function (r) { (r.tableCells || []).forEach(function (c) { walk(c.content); }); });
      }
    }
  }
  walk(tab.body.content);
  var empty = [];
  for (var k = 0; k < refs.length; k++) {
    var fn = tab.footnotes[refs[k]], txt = '';
    ((fn && fn.content) || []).forEach(function (el) {
      ((el.paragraph && el.paragraph.elements) || []).forEach(function (e) { if (e.textRun) txt += e.textRun.content; });
    });
    if (txt.trim() === '') empty.push({ id: refs[k], start: fn.content[0].startIndex || 0 });
  }
  if (empty.length !== want.length) return { written: 0, error: empty.length + ' empty footnotes for ' + want.length + ' notes - left empty' };
  var reqs = [];
  for (var m = 0; m < empty.length; m++) {
    var l = { segmentId: empty[m].id, index: empty[m].start + 1 };
    if (TAB_ID) l.tabId = TAB_ID;
    reqs.push({ insertText: { text: want[m], location: l } });
  }
  Docs.Documents.batchUpdate({ requests: reqs }, docId);
  return { written: reqs.length };
}

/** Start index of the n-th top-level table, for Docs API table requests. */
function tableStart_(docId, n) {
  var content = apiTab_(docId).body.content, seen = 0;
  for (var i = 0; i < content.length; i++) {
    if (content[i].table) { if (seen === n) return content[i]; seen++; }
  }
  throw new Error('table ' + n + ' not found through the Docs API');
}

/**
 * Table ops that need the Docs API or whole-table passes:
 *   color    {match, col?, color, row?}  shade cells whose text equals match
 *                                        (contains: true for a substring); row: true shades the row
 *   addColumn {header, after? | before?, value?}   new column, header styled like its neighbour
 *   deleteColumn {col}
 *   merge / unmerge {row, col, rows, cols}
 *   widths {widths: {"Lead": 60, "Issue": 220}}   points; unnamed columns share the rest
 */
function tableMore_(p, f) {
  var t = f.t, op = p.op, docId = DOC_ID;
  function loc(o) { if (TAB_ID) o.tabId = TAB_ID; return o; }
  if (op === 'color') {
    if (!p.match || !p.color) return { ok: false, error: 'color needs match and color' };
    var ci = p.col != null ? colIndex_(t, p.col) : null;
    if (ci && ci.error) return { ok: false, error: ci.error };
    var want = String(p.match).trim().toLowerCase(), n = 0;
    for (var r = 1; r < t.getNumRows(); r++) {
      var row = t.getRow(r), hit = false;
      for (var c = 0; c < row.getNumCells(); c++) {
        if (ci && c !== ci.c) continue;
        var tx = row.getCell(c).getText().trim().toLowerCase();
        if (p.contains ? tx.indexOf(want) >= 0 : tx === want) {
          hit = true;
          if (!p.row) row.getCell(c).setBackgroundColor(p.color === 'none' ? null : p.color);
        }
      }
      if (hit) {
        n++;
        if (p.row) for (var c2 = 0; c2 < row.getNumCells(); c2++) row.getCell(c2).setBackgroundColor(p.color === 'none' ? null : p.color);
      }
    }
    return { ok: true, mode: 'table', op: op, table: f.n, rows: n };
  }
  if (op === 'addColumn') {
    var ref = colIndex_(t, p.after != null ? p.after : p.before != null ? p.before : t.getRow(0).getNumCells() - 1);
    if (ref.error) return { ok: false, error: ref.error };
    var right = p.before == null, at = right ? ref.c + 1 : ref.c;
    var el = tableStart_(docId, f.n);
    Docs.Documents.batchUpdate({ requests: [{ insertTableColumn: {
      tableCellLocation: { tableStartLocation: loc({ index: el.startIndex }), rowIndex: 0, columnIndex: ref.c },
      insertRight: right } }] }, docId);
    // The new cells are empty; fill header (and optional value) through the API,
    // last row first so earlier indices stay valid, copying the neighbour's text style.
    var tbl = tableStart_(docId, f.n).table, reqs = [];
    for (var ri = tbl.tableRows.length - 1; ri >= 0; ri--) {
      var cells = tbl.tableRows[ri].tableCells, text = ri === 0 ? (p.header || '') : (p.value || '');
      if (!text) continue;
      var cell = cells[at], nb = cells[right ? at - 1 : at + 1];
      var idx = cell.content[0].startIndex;
      reqs.push({ insertText: { text: text, location: loc({ index: idx }) } });
      var run = nb && nb.content[0].paragraph && nb.content[0].paragraph.elements[0].textRun;
      if (run && run.textStyle) {
        var ts = run.textStyle, keep = {}, fields = [];
        ['bold', 'italic', 'fontSize', 'foregroundColor', 'weightedFontFamily'].forEach(function (k) {
          if (ts[k] != null) { keep[k] = ts[k]; fields.push(k); }
        });
        if (fields.length) reqs.push({ updateTextStyle: { range: loc({ startIndex: idx, endIndex: idx + text.length }),
                                                          textStyle: keep, fields: fields.join(',') } });
      }
    }
    if (reqs.length) Docs.Documents.batchUpdate({ requests: reqs }, docId);
    return { ok: true, mode: 'table', op: op, table: f.n, column: at, header: p.header || '' };
  }
  if (op === 'deleteColumn') {
    var dc = colIndex_(t, p.col);
    if (dc.error) return { ok: false, error: dc.error };
    if (t.getRow(0).getNumCells() < 2) return { ok: false, error: 'cannot delete the only column' };
    var e2 = tableStart_(docId, f.n);
    Docs.Documents.batchUpdate({ requests: [{ deleteTableColumn: {
      tableCellLocation: { tableStartLocation: loc({ index: e2.startIndex }), rowIndex: 0, columnIndex: dc.c } } }] }, docId);
    return { ok: true, mode: 'table', op: op, table: f.n, removed: dc.c };
  }
  if (op === 'merge' || op === 'unmerge') {
    var mc = colIndex_(t, p.col == null ? 0 : p.col);
    if (mc.error) return { ok: false, error: mc.error };
    var e3 = tableStart_(docId, f.n), req = {};
    req[op === 'merge' ? 'mergeTableCells' : 'unmergeTableCells'] = { tableRange: {
      tableCellLocation: { tableStartLocation: loc({ index: e3.startIndex }), rowIndex: p.row || 0, columnIndex: mc.c },
      rowSpan: p.rows || 1, columnSpan: p.cols || 1 } };
    Docs.Documents.batchUpdate({ requests: [req] }, docId);
    return { ok: true, mode: 'table', op: op, table: f.n };
  }
  if (op === 'widths') {
    var e4 = tableStart_(docId, f.n), wreq = [], w = p.widths || {};
    for (var key in w) {
      var wc = colIndex_(t, /^\d+$/.test(key) ? +key : key);
      if (wc.error) return { ok: false, error: wc.error };
      wreq.push({ updateTableColumnProperties: { tableStartLocation: loc({ index: e4.startIndex }), columnIndices: [wc.c],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: +w[key], unit: 'PT' } },
        fields: 'widthType,width' } });
    }
    if (!wreq.length) return { ok: false, error: 'widths needs {column: points}' };
    Docs.Documents.batchUpdate({ requests: wreq }, docId);
    return { ok: true, mode: 'table', op: op, table: f.n, set: wreq.length };
  }
  return null;
}

var NAMED = { title: 'TITLE', subtitle: 'SUBTITLE', normal: 'NORMAL_TEXT', h1: 'HEADING_1', h2: 'HEADING_2',
              h3: 'HEADING_3', h4: 'HEADING_4', h5: 'HEADING_5', h6: 'HEADING_6' };

// A clean house look: bold headings in one family, a readable body.
var CLEAN_STYLES = {
  normal: { font: 'Arial', size: 11, color: '#1a1a1a' },
  title: { font: 'Arial', size: 24, bold: true },
  h1: { font: 'Arial', size: 20, bold: true, spaceAbove: 20, spaceBelow: 6 },
  h2: { font: 'Arial', size: 16, bold: true, spaceAbove: 16, spaceBelow: 4 },
  h3: { font: 'Arial', size: 13, bold: true, spaceAbove: 12, spaceBelow: 3 },
  h4: { font: 'Arial', size: 11, bold: true, spaceAbove: 10, spaceBelow: 2 }
};

/**
 * Change the doc's own named styles, so every heading (or all body text)
 * changes at once: {styles: {h2: {bold, italic, size, font, color, spaceAbove, spaceBelow}}}
 * or {preset: 'clean'}. Text with its own direct formatting keeps it.
 */
function docStyle(p) {
  var styles = p.preset === 'clean' ? CLEAN_STYLES : (p.styles || {}), reqs = [];
  for (var key in styles) {
    var type = NAMED[String(key).toLowerCase()] || key, st = styles[key], ts = {}, ps = {}, fields = [];
    if (st.bold != null) { ts.bold = !!st.bold; fields.push('textStyle.bold'); }
    if (st.italic != null) { ts.italic = !!st.italic; fields.push('textStyle.italic'); }
    if (st.size) { ts.fontSize = { magnitude: +st.size, unit: 'PT' }; fields.push('textStyle.fontSize'); }
    if (st.font) { ts.weightedFontFamily = { fontFamily: st.font }; fields.push('textStyle.weightedFontFamily'); }
    if (st.color) { ts.foregroundColor = { color: { rgbColor: rgb_(st.color) } }; fields.push('textStyle.foregroundColor'); }
    if (st.spaceAbove != null) { ps.spaceAbove = { magnitude: +st.spaceAbove, unit: 'PT' }; fields.push('paragraphStyle.spaceAbove'); }
    if (st.spaceBelow != null) { ps.spaceBelow = { magnitude: +st.spaceBelow, unit: 'PT' }; fields.push('paragraphStyle.spaceBelow'); }
    if (!fields.length) continue;
    var r = { updateNamedStyle: { namedStyle: { namedStyleType: type, textStyle: ts, paragraphStyle: ps },
                                  fields: 'namedStyleType,' + fields.join(',') } };
    if (TAB_ID) r.updateNamedStyle.tabId = TAB_ID;
    reqs.push(r);
  }
  if (!reqs.length) return { ok: false, error: "send styles {h2: {bold: true, size: 16}} or preset: 'clean'" };
  Docs.Documents.batchUpdate({ requests: reqs }, DOC_ID);
  return { ok: true, mode: 'docStyle', updated: reqs.length };
}

/** Page setup: margins {top,bottom,left,right} pt, landscape, background '#hex', size 'letter' | 'a4'. */
function pageSetup(p) {
  var ds = {}, fields = [];
  var m = p.margins || {};
  ['top', 'bottom', 'left', 'right'].forEach(function (side) {
    if (m[side] != null) {
      var k = 'margin' + side.charAt(0).toUpperCase() + side.substring(1);
      ds[k] = { magnitude: +m[side], unit: 'PT' }; fields.push(k);
    }
  });
  if (p.landscape != null) { ds.flipPageOrientation = !!p.landscape; fields.push('flipPageOrientation'); }
  if (p.background) {
    ds.background = { color: p.background === 'none' ? {} : { color: { rgbColor: rgb_(p.background) } } };
    fields.push('background');
  }
  if (p.size) {
    var SIZES = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] }, sz = SIZES[String(p.size).toLowerCase()];
    if (!sz) return { ok: false, error: 'size must be letter, a4 or legal' };
    ds.pageSize = { width: { magnitude: sz[0], unit: 'PT' }, height: { magnitude: sz[1], unit: 'PT' } };
    fields.push('pageSize');
  }
  if (!fields.length) return { ok: false, error: 'send margins, landscape, background or size' };
  var req = { updateDocumentStyle: { documentStyle: ds, fields: fields.join(',') } };
  if (TAB_ID) req.updateDocumentStyle.tabId = TAB_ID;
  Docs.Documents.batchUpdate({ requests: [req] }, DOC_ID);
  return { ok: true, mode: 'page', set: fields };
}

/** Link text matching find to a heading in the same tab, so clicking it jumps there. */
function linkHeading(p) {
  if (!p.find || !p.to) return { ok: false, error: 'send find (the text to link) and to (the heading)' };
  // Heading ids only exist in the Docs API; read them before DocumentApp opens the doc.
  var content = apiTab_(DOC_ID).body.content, hid = null;
  for (var i = 0; i < content.length && !hid; i++) {
    var par = content[i].paragraph;
    if (!par || !par.paragraphStyle || !par.paragraphStyle.headingId) continue;
    var tx = '';
    (par.elements || []).forEach(function (e) { if (e.textRun) tx += e.textRun.content; });
    if (tx.trim() === String(p.to).trim()) hid = par.paragraphStyle.headingId;
  }
  if (!hid) return { ok: false, error: 'no heading with text: ' + p.to };
  var f = findMatches_(targetBody(target()), p);
  if (f.error) return { ok: false, error: f.error };
  var url = (TAB_ID ? '?tab=' + TAB_ID : '') + '#heading=' + hid;
  for (var k = 0; k < f.hits.length; k++) f.hits[k].el.setLinkUrl(f.hits[k].s, f.hits[k].e, url);
  return { ok: true, mode: 'linkHeading', linked: f.hits.length, heading: hid };
}

/** Delete a tab - only when confirmTitle repeats the tab's exact title. */
function deleteTab(p) {
  if (!p.tabId) return { ok: false, error: 'deleteTab needs tabId (see tabs list)' };
  var tabs = listTabs_(target()), hit = null;
  for (var i = 0; i < tabs.length; i++) if (tabs[i].id === p.tabId) hit = tabs[i];
  if (!hit) return { ok: false, error: 'no tab ' + p.tabId };
  if (tabs.length < 2) return { ok: false, error: 'cannot delete the only tab' };
  if (p.confirmTitle !== hit.title) {
    return { ok: false, error: 'to delete tab "' + hit.title + '" (and its child tabs) send confirmTitle with that exact title' };
  }
  Docs.Documents.batchUpdate({ requests: [{ deleteTab: { tabId: p.tabId } }] }, DOC_ID);
  return { ok: true, mode: 'deleteTab', deleted: hit.title };
}

/**
 * Image for a URL: a Drive file link is read through Drive (no download
 * permission needed beyond Drive); anything else is fetched by Google's
 * servers. Only PNG, JPEG and GIF are accepted - what Docs can embed.
 */
function imageBlob_(url, alt) {
  var drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]{20,})/) ||
              url.match(/docs\.google\.com\/uc\?id=([A-Za-z0-9_-]{20,})/);
  var blob;
  if (drive) {
    blob = DriveApp.getFileById(drive[1]).getBlob();
  } else {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' fetching the image');
    blob = res.getBlob();
  }
  var type = String(blob.getContentType() || '').toLowerCase();
  if (!/^image\/(png|jpe?g|gif)$/.test(type)) throw new Error('not a PNG, JPEG or GIF image (' + (type || 'unknown type') + ')');
  if (blob.getBytes().length > 25 * 1024 * 1024) throw new Error('image over 25 MB');
  return blob.setName(alt || 'image');
}

/** Save a file (base64) into a Drive folder: {name, base64, mimeType?, folderId?}. No document needed. */
function uploadFile(p) {
  if (!p.name || !p.base64) return { ok: false, error: 'upload needs name and base64' };
  var blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mimeType || 'application/octet-stream', p.name);
  var folder = p.folderId ? DriveApp.getFolderById(p.folderId) : DriveApp.getRootFolder();
  var file = folder.createFile(blob);
  return { ok: true, mode: 'upload', id: file.getId(), url: file.getUrl(), size: file.getSize() };
}
