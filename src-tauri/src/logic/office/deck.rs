//! Reveal.js presentation decks — render, sanitize, read back, export.
//!
//! A deck is ONE self-contained `.html` file: the vendored reveal.js runtime
//! (assets/, MIT) is inlined at creation time so the file presents anywhere,
//! with no network and no external parts. The model authors slides as
//! structured args (`DeckSlide`: a title plus a body-HTML fragment); the
//! template here wraps them, and a deterministic sanitizer strips
//! script-capable markup from the model-supplied fragments — the only script
//! in the finished file is the runtime we baked in ourselves.
//!
//! The deck is the single source of truth. Reading it back
//! (`parse_deck` → markdown) powers `office_read_document` and RAG indexing;
//! exporting to `.pptx` (`export_pptx`) walks the same parse — no LLM in the
//! loop, ever.

use base64::Engine as _;
use office_oxide::ir::ImageFormat;
use office_oxide::pptx::write::PptxWriter;
use serde::Deserialize;
use std::collections::HashMap;

const REVEAL_JS: &str = include_str!("assets/reveal.min.js");
const REVEAL_CSS: &str = include_str!("assets/reveal.css");
const THEME_CSS: &str = include_str!("assets/theme-black.css");

/// Extra presentation styling on top of the vendored theme: images sit
/// quietly, tables read as tables.
const DECK_TWEAK_CSS: &str = "\
.reveal section img { max-height: 55vh; border: 0; background: none; box-shadow: none; }
.reveal section table { font-size: 0.65em; border-collapse: collapse; margin: 0.5em auto; }
.reveal section th, .reveal section td { border: 1px solid rgba(255,255,255,0.25); padding: 0.3em 0.6em; }
.reveal section h3 { color: #13daec; text-transform: none; letter-spacing: normal; }
";

/// One slide as authored by the model: an optional title (rendered as the
/// slide's `<h2>`) and a body-HTML fragment using the deck vocabulary
/// (h3/p/ul/table/img).
#[derive(Clone, Debug, Deserialize)]
pub struct DeckSlide {
    pub title: Option<String>,
    pub body_html: String,
}

// ── render ───────────────────────────────────────────────────────────────────

/// Render the full self-contained deck document.
pub fn render_deck(title: &str, slides: &[DeckSlide]) -> String {
    let mut sections = String::new();
    for slide in slides {
        sections.push_str("<section>\n");
        if let Some(t) = slide.title.as_deref().filter(|t| !t.trim().is_empty()) {
            sections.push_str(&format!("<h2>{}</h2>\n", escape_html(t.trim())));
        }
        sections.push_str(slide.body_html.trim());
        sections.push_str("\n</section>\n");
    }
    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:\">\n\
<title>{title}</title>\n\
<style>\n{REVEAL_CSS}\n{THEME_CSS}\n{DECK_TWEAK_CSS}\n</style>\n\
</head>\n\
<body>\n\
<div class=\"reveal\"><div class=\"slides\">\n\
{sections}\
</div></div>\n\
<script>\n{REVEAL_JS}\n</script>\n\
<script>\nReveal.initialize({{hash: true, controls: true, progress: true, center: true, transition: \"slide\", slideNumber: \"c/t\"}});\n</script>\n\
</body>\n\
</html>\n",
        title = escape_html(title),
    )
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ── sanitizer ────────────────────────────────────────────────────────────────

/// Elements dropped together with their content — anything that can execute
/// script, load remote frames, or hijack navigation.
const DROP_WITH_CONTENT: &[&str] = &[
    "script", "iframe", "object", "embed", "svg", "math", "template", "form", "select",
    "textarea", "video", "audio", "applet", "frameset",
];

/// Elements dropped as a single tag (void or rarely-closed).
const DROP_TAG_ONLY: &[&str] = &[
    "link", "meta", "base", "input", "button", "source", "track", "frame", "param",
];

/// Attributes whose value is a URL and must be scheme-checked.
const URL_ATTRS: &[&str] = &["src", "href", "action", "formaction", "poster", "background"];

/// Sanitize a model-authored HTML fragment: drop script-capable elements (with
/// their content), strip event-handler attributes, and drop URL attributes with
/// unsafe schemes. Everything else passes through byte-for-byte — this is a
/// scanner, not a rewriter, so valid markup is never mangled.
pub fn sanitize_html_fragment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            let next = input[i..].find('<').map(|n| i + n).unwrap_or(bytes.len());
            out.push_str(&input[i..next]);
            i = next;
            continue;
        }
        let rest = &input[i..];
        if rest.starts_with("<!--") {
            // Drop comments wholesale (including conditional-comment games).
            i += rest.find("-->").map(|n| n + 3).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            // Doctype / processing instruction / CDATA marker — drop the tag.
            i += rest.find('>').map(|n| n + 1).unwrap_or(rest.len());
            continue;
        }
        let Some(tag) = parse_tag(rest) else {
            // Stray '<' — keep it as text.
            out.push('<');
            i += 1;
            continue;
        };
        if DROP_WITH_CONTENT.contains(&tag.name.as_str()) {
            if tag.self_closing {
                i += tag.end;
            } else {
                i += tag.end + skip_until_close(&rest[tag.end..], &tag.name);
            }
            continue;
        }
        if DROP_TAG_ONLY.contains(&tag.name.as_str()) {
            i += tag.end;
            continue;
        }
        if tag.closing {
            out.push_str(&format!("</{}>", tag.name));
            i += tag.end;
            continue;
        }
        // Kept element: rebuild the open tag with filtered attributes.
        out.push('<');
        out.push_str(&tag.name);
        for attr in &tag.attrs {
            if keep_attribute(&tag.name, attr) {
                out.push(' ');
                out.push_str(&attr.name);
                if let Some(v) = &attr.value {
                    out.push_str("=\"");
                    out.push_str(&v.replace('"', "&quot;"));
                    out.push('"');
                }
            }
        }
        out.push_str(if tag.self_closing { " />" } else { ">" });
        i += tag.end;
    }
    out
}

/// A parsed open/close tag at a known position.
struct Tag {
    /// Position just past the closing `>`.
    end: usize,
    /// Lowercased element name.
    name: String,
    closing: bool,
    self_closing: bool,
    attrs: Vec<Attr>,
}

struct Attr {
    name: String,
    value: Option<String>,
}

/// Parse the tag starting at the beginning of `src` (which must start with
/// `<` followed by a name character).
fn parse_tag(src: &str) -> Option<Tag> {
    let bytes = src.as_bytes();
    if bytes.len() < 2 || !(bytes[1].is_ascii_alphabetic() || bytes[1] == b'/' || bytes[1] == b'!') {
        return None;
    }
    let mut i = 1usize;
    let closing = bytes[i] == b'/';
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let name = src[name_start..i].to_ascii_lowercase();

    let mut attrs = Vec::new();
    let mut self_closing = false;
    // Scan to the tag's closing '>', respecting quoted attribute values.
    while i < bytes.len() {
        // Skip whitespace.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        if bytes[i] == b'>' {
            i += 1;
            break;
        }
        if bytes[i] == b'/' {
            self_closing = true;
            i += 1;
            continue;
        }
        // Attribute name.
        let astart = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
            && bytes[i] != b'/'
        {
            i += 1;
        }
        if i == astart {
            i += 1; // skip a stray char
            continue;
        }
        let aname = src[astart..i].to_ascii_lowercase();
        // Optional value.
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let value = if j < bytes.len() && bytes[j] == b'=' {
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                let quote = bytes[j];
                let vstart = j + 1;
                let vend = src[vstart..].find(quote as char).map(|n| vstart + n);
                match vend {
                    Some(vend) => {
                        let v = src[vstart..vend].to_string();
                        i = vend + 1;
                        Some(v)
                    }
                    None => return None, // unterminated quote
                }
            } else {
                let vstart = j;
                while j < bytes.len()
                    && !bytes[j].is_ascii_whitespace()
                    && bytes[j] != b'>'
                {
                    j += 1;
                }
                let v = src[vstart..j].to_string();
                i = j;
                if v.is_empty() {
                    None
                } else {
                    Some(v)
                }
            }
        } else {
            i = j;
            None
        };
        attrs.push(Attr { name: aname, value });
    }
    Some(Tag {
        end: i,
        name,
        closing,
        self_closing,
        attrs,
    })
}

/// Advance past an element's content until its matching close tag (nesting on
/// the same name). Returns the consumed length (to end of input when
/// unclosed).
fn skip_until_close(src: &str, name: &str) -> usize {
    let open = format!("<{name}");
    let close = format!("</{name}");
    let mut depth = 1usize;
    let mut i = 0usize;
    while i < src.len() {
        if let Some(p) = src[i..].find('<') {
            let at = i + p;
            if src[at..].starts_with(&close) {
                depth -= 1;
                if depth == 0 {
                    let end = src[at..].find('>').map(|n| at + n + 1).unwrap_or(src.len());
                    return end;
                }
                i = at + close.len();
            } else if src[at..].starts_with(&open)
                && !src[at + open.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
            {
                depth += 1;
                i = at + open.len();
            } else {
                i = at + 1;
            }
        } else {
            return src.len();
        }
    }
    src.len()
}

fn keep_attribute(tag: &str, attr: &Attr) -> bool {
    if attr.name.starts_with("on") && attr.name.len() > 2 {
        return false;
    }
    if attr.name == "style" || attr.name == "class" || attr.name == "data-file" {
        return true;
    }
    if URL_ATTRS.contains(&attr.name.as_str()) {
        let Some(v) = attr.value.as_deref() else {
            return true;
        };
        return safe_url(tag, attr.name.as_str(), v);
    }
    if attr.name.starts_with("xlink:") {
        return false;
    }
    true
}

/// Scheme gate for URL-bearing attributes. `data:` image URLs are allowed on
/// embed targets only; `javascript:`/`vbscript:`/`file:` and friends never.
fn safe_url(tag: &str, attr: &str, raw: &str) -> bool {
    let v = raw.trim().to_ascii_lowercase();
    if v.is_empty() || v.starts_with('#') || v.starts_with('/') || v.starts_with('.') {
        return true;
    }
    if v.starts_with("http://") || v.starts_with("https://") || v.starts_with("mailto:") {
        return true;
    }
    if v.starts_with("data:") {
        // data: images on image targets only (`data:image/png|jpeg|gif|svg+xml`).
        let ok_image = v.starts_with("data:image/png")
            || v.starts_with("data:image/jpeg")
            || v.starts_with("data:image/jpg")
            || v.starts_with("data:image/gif")
            || v.starts_with("data:image/webp")
            || v.starts_with("data:image/svg+xml");
        let image_target =
            tag == "img" && (attr == "src" || attr == "poster" || attr == "background");
        return ok_image && image_target;
    }
    // Relative URL with no scheme — safe. Anything else (javascript:, file:,
    // unknown:) is dropped.
    !v.contains(':') || v.split(':').next().is_none_or(str::is_empty)
}

// ── stored-file image references (charts on slides) ──────────────────────────

/// Collect every `data-file="…"` handle referenced by `<img>` tags across the
/// slides — the caller resolves them against the office store.
pub fn collect_file_refs(slides: &[DeckSlide]) -> Vec<String> {
    let mut refs = Vec::new();
    for slide in slides {
        let mut i = 0usize;
        while let Some(p) = slide.body_html[i..].find("<img") {
            let at = i + p;
            if let Some(tag) = parse_tag(&slide.body_html[at..]) {
                for a in &tag.attrs {
                    if a.name == "data-file" {
                        if let Some(v) = a.value.as_deref() {
                            if !refs.iter().any(|r| r == v) {
                                refs.push(v.to_string());
                            }
                        }
                    }
                }
                i = at + tag.end;
            } else {
                i = at + 4;
            }
        }
    }
    refs
}

/// Replace every `<img data-file="…">` with an inline `data:` URL from the
/// resolved map. Unresolvable refs become a visible placeholder comment so the
/// model sees what failed instead of a silently empty slide.
pub fn substitute_file_refs(
    slides: &mut [DeckSlide],
    resolved: &HashMap<String, (String, Vec<u8>)>,
) {
    for slide in slides {
        let mut i = 0usize;
        loop {
            let Some(p) = slide.body_html[i..].find("<img") else { break };
            let at = i + p;
            let Some(tag) = parse_tag(&slide.body_html[at..]) else {
                i = at + 4;
                continue;
            };
            let handle = tag.attrs.iter().find_map(|a| {
                (a.name == "data-file").then(|| a.value.clone()).flatten()
            });
            let replacement = match handle.as_deref() {
                Some(h) => match resolved.get(h) {
                    Some((mime, bytes)) => {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                        format!("<img src=\"data:{mime};base64,{b64}\">")
                    }
                    None => format!("<!-- kawai: stored file {h} not found -->"),
                },
                None => {
                    i = at + tag.end;
                    continue;
                }
            };
            slide.body_html.replace_range(at..at + tag.end, &replacement);
            i = at + replacement.len();
        }
    }
}

/// MIME type for a stored office-store extension, image kinds only.
pub fn image_mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

// ── parse (deck → structured) ────────────────────────────────────────────────

/// A deck parsed back from its HTML: the structure the renderer produced.
#[derive(Debug, Default)]
pub struct ParsedDeck {
    pub title: Option<String>,
    pub slides: Vec<ParsedSlide>,
}

#[derive(Debug, Default)]
pub struct ParsedSlide {
    pub title: Option<String>,
    pub blocks: Vec<SlideBlock>,
}

#[derive(Debug)]
pub enum SlideBlock {
    Para(String),
    Bullets(Vec<String>),
    Table(Vec<Vec<String>>),
    Image { mime: String, data: Vec<u8> },
}

/// Parse a deck document back into structure. Works on any HTML: a document
/// without `<section>` elements degrades to a single slide holding the body's
/// text.
pub fn parse_deck(html: &str) -> ParsedDeck {
    let title = extract_element(html, "title")
        .map(|t| decode_entities(&strip_tags(&t)))
        .filter(|t| !t.trim().is_empty());
    let mut slides = Vec::new();
    let mut cursor = 0usize;
    while let Some((start, end)) = next_element_span(html, cursor, "section") {
        let inner = &html[start..end];
        let parsed = parse_slide_inner(inner);
        if parsed.title.is_some() || !parsed.blocks.is_empty() {
            slides.push(parsed);
        }
        cursor = end + format!("</section").len();
    }
    if slides.is_empty() {
        let body = extract_element(html, "body").unwrap_or_else(|| html.to_string());
        let parsed = parse_slide_inner(&body);
        if parsed.title.is_some() || !parsed.blocks.is_empty() {
            slides.push(parsed);
        }
    }
    ParsedDeck { title, slides }
}

/// Find the inner span of the next `<name …>` element starting at `from`,
/// honoring nesting on the same name.
fn next_element_span(html: &str, from: usize, name: &str) -> Option<(usize, usize)> {
    let open = format!("<{name}");
    let close = format!("</{name}");
    let mut search = from;
    let open_at = loop {
        let at = html[search..].find(&open)?;
        let at = search + at;
        let next_char = html[at + open.len()..].chars().next();
        if next_char.is_some_and(|c| c.is_ascii_whitespace() || c == '>' || c == '/') {
            break at;
        }
        search = at + open.len();
    };
    let after_open = html[open_at..]
        .find('>')
        .map(|n| open_at + n + 1)
        .unwrap_or(html.len());
    // Self-closing <section/> — empty inner span.
    if html[open_at..after_open].trim_end().ends_with('/') {
        return Some((after_open, after_open));
    }
    let mut depth = 1usize;
    let mut i = after_open;
    while i < html.len() {
        if let Some(p) = html[i..].find('<') {
            let at = i + p;
            if html[at..].starts_with(&close) {
                depth -= 1;
                if depth == 0 {
                    return Some((after_open, at));
                }
                i = at + close.len();
            } else if html[at..].starts_with(&open)
                && !html[at + open.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
            {
                depth += 1;
                i = at + open.len();
            } else {
                i = at + 1;
            }
        } else {
            break;
        }
    }
    Some((after_open, html.len()))
}

fn extract_element(html: &str, name: &str) -> Option<String> {
    let (s, e) = next_element_span(html, 0, name)?;
    Some(html[s..e].to_string())
}

/// Parse the children of one `<section>` (or fallback body) into a slide.
fn parse_slide_inner(inner: &str) -> ParsedSlide {
    let mut slide = ParsedSlide::default();
    walk_children(inner, &mut slide, true);
    slide
}

/// Walk the immediate children of `html`, appending blocks to `slide`. Inside
/// container elements (`div` & co.) the walk recurses inline — layout wrappers
/// do not eat content.
/// HTML void elements — never closed, no content span.
const VOID_ELEMENTS: &[&str] = &[
    "img", "br", "hr", "input", "link", "meta", "source", "area", "base", "col", "embed",
    "track", "wbr", "param",
];

fn walk_children(html: &str, slide: &mut ParsedSlide, top: bool) {
    let mut i = 0usize;
    let mut text_start = 0usize;
    while i < html.len() {
        let Some(p) = html[i..].find('<') else { break };
        let at = i + p;
        if at > text_start {
            push_text(&decode_entities(&html[text_start..at]), slide, top);
        }
        let rest = &html[at..];
        if rest.starts_with("<!--") {
            i = at + rest.find("-->").map(|n| n + 3).unwrap_or(rest.len());
            text_start = i;
            continue;
        }
        let Some(tag) = parse_tag(rest) else {
            i = at + 1;
            text_start = i;
            continue;
        };
        let name = tag.name.clone();
        let is_void = VOID_ELEMENTS.contains(&name.as_str());
        let span_end = if tag.self_closing || tag.closing || is_void {
            tag.end
        } else {
            skip_until_close(&rest[tag.end..], &name) + tag.end
        };
        let close_len = if tag.self_closing || tag.closing || is_void {
            0
        } else {
            format!("</{name}>").len()
        };
        let content = &rest[tag.end..span_end.saturating_sub(close_len).max(tag.end)];
        match name.as_str() {
            "h2" if top => {
                let text = decode_entities(&strip_tags(content));
                if !text.trim().is_empty() {
                    if slide.title.is_none() {
                        slide.title = Some(text.trim().to_string());
                    } else {
                        slide.blocks.push(SlideBlock::Para(text.trim().to_string()));
                    }
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let text = decode_entities(&strip_tags(content));
                if !text.trim().is_empty() {
                    slide.blocks.push(SlideBlock::Para(text.trim().to_string()));
                }
            }
            "p" | "blockquote" | "figcaption" | "pre" => {
                let text = decode_entities(&strip_tags(content));
                let text = text.replace(['\r', '\n'], " ");
                if !text.trim().is_empty() {
                    slide.blocks.push(SlideBlock::Para(text.trim().to_string()));
                }
            }
            "ul" | "ol" => {
                let items = collect_list_items(content);
                if !items.is_empty() {
                    slide.blocks.push(SlideBlock::Bullets(items));
                }
            }
            "table" => {
                let rows = collect_table_rows(content);
                if !rows.is_empty() {
                    slide.blocks.push(SlideBlock::Table(rows));
                }
            }
            "img" => {
                let src = tag
                    .attrs
                    .iter()
                    .find(|a| a.name == "src")
                    .and_then(|a| a.value.clone())
                    .unwrap_or_default();
                if let Some((mime, data)) = decode_data_url(&src) {
                    slide.blocks.push(SlideBlock::Image { mime, data });
                }
            }
            "aside" => {} // presenter notes stay out of the export
            _ => {
                if !tag.closing && !tag.self_closing {
                    walk_children(content, slide, false);
                }
            }
        }
        i = at + span_end;
        text_start = i;
    }
    if text_start < html.len() {
        push_text(&decode_entities(&html[text_start..]), slide, top);
    }
}

fn push_text(text: &str, slide: &mut ParsedSlide, top: bool) {
    let t = text.trim();
    if t.is_empty() {
        return;
    }
    if top && slide.title.is_none() {
        // Untitled section whose first content is bare text — use it as the
        // title so the pptx export keeps one idea per slide.
        slide.title = Some(t.to_string());
        return;
    }
    slide.blocks.push(SlideBlock::Para(t.to_string()));
}

fn collect_list_items(list_html: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut cursor = 0usize;
    while let Some((s, e)) = next_element_span(list_html, cursor, "li") {
        let text = decode_entities(&strip_tags(&list_html[s..e]));
        let text = text.replace(['\r', '\n'], " ");
        if !text.trim().is_empty() {
            items.push(text.trim().to_string());
        }
        cursor = e + 4;
    }
    items
}

fn collect_table_rows(table_html: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut cursor = 0usize;
    while let Some((s, e)) = next_element_span(table_html, cursor, "tr") {
        let mut cells = Vec::new();
        let mut cc = s;
        while let Some((cs, ce)) =
            next_element_span(&table_html[s..e], cc - s, "td").or_else(|| {
                next_element_span(&table_html[s..e], cc - s, "th").map(|(a, b)| (a, b))
            })
        {
            let text = decode_entities(&strip_tags(&table_html[s + cs..s + ce]));
            cells.push(text.trim().to_string());
            cc = s + ce + 4;
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
        cursor = e + 4;
    }
    rows
}

fn decode_data_url(src: &str) -> Option<(String, Vec<u8>)> {
    let v = src.trim();
    let rest = v.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    if !meta.to_ascii_lowercase().ends_with(";base64") {
        return None;
    }
    let mime = meta.trim_end_matches(";base64").to_ascii_lowercase();
    let data = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()?;
    Some((mime, data))
}

/// Strip all tags from a fragment, keeping text content.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    while i < html.len() {
        let Some(p) = html[i..].find('<') else {
            out.push_str(&html[i..]);
            break;
        };
        let at = i + p;
        out.push_str(&html[i..at]);
        let rest = &html[at..];
        if rest.starts_with("<!--") {
            i = at + rest.find("-->").map(|n| n + 3).unwrap_or(rest.len());
        } else {
            i = at + rest.find('>').map(|n| n + 1).unwrap_or(rest.len());
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        let tail = &rest[p..];
        let end = tail.find(';');
        let name_len = end.filter(|n| *n <= 12).unwrap_or(0);
        if name_len > 1 && name_len <= 12 {
            let entity = &tail[1..name_len];
            let decoded = if let Some(num) = entity.strip_prefix('#') {
                let cp = if let Some(hex) = num.strip_prefix('x').or(num.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    num.parse::<u32>().ok()
                };
                cp.and_then(char::from_u32).map(|c| c.to_string())
            } else {
                named_entity(entity)
            };
            match decoded {
                Some(d) => {
                    out.push_str(&d);
                    rest = &tail[name_len + 1..];
                }
                None => {
                    out.push('&');
                    rest = &tail[1..];
                }
            }
        } else {
            out.push('&');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

fn named_entity(name: &str) -> Option<String> {
    let s = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" | "rsquo" => "'",
        "lsquo" => "\u{2018}",
        "ldquo" => "\u{201C}",
        "rdquo" => "\u{201D}",
        "nbsp" => "\u{A0}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "hellip" => "\u{2026}",
        "rarr" => "\u{2192}",
        "larr" => "\u{2190}",
        "copy" => "\u{A9}",
        "trade" => "\u{2122}",
        "reg" => "\u{AE}",
        "deg" => "\u{B0}",
        "times" => "\u{D7}",
        "divide" => "\u{F7}",
        "plusmn" => "\u{B1}",
        "bull" => "\u{2022}",
        "middot" => "\u{B7}",
        "euro" => "\u{20AC}",
        "pound" => "\u{A3}",
        "yen" => "\u{A5}",
        "sect" => "\u{A7}",
        "para" => "\u{B6}",
        "laquo" => "\u{AB}",
        "raquo" => "\u{BB}",
        _ => return None,
    };
    Some(s.to_string())
}

// ── markdown readback ────────────────────────────────────────────────────────

/// Render a parsed deck as markdown (headings + bullets + pipe tables) — the
/// format `office_read_document` and RAG indexing consume.
pub fn deck_to_markdown(deck: &ParsedDeck) -> String {
    let mut md = String::new();
    if let Some(t) = deck.title.as_deref() {
        md.push_str(&format!("# {}\n\n", t));
    }
    for slide in &deck.slides {
        if let Some(t) = slide.title.as_deref() {
            md.push_str(&format!("## {}\n\n", t));
        }
        for block in &slide.blocks {
            match block {
                SlideBlock::Para(text) => md.push_str(&format!("{}\n\n", text)),
                SlideBlock::Bullets(items) => {
                    for item in items {
                        md.push_str(&format!("- {}\n", item));
                    }
                    md.push('\n');
                }
                SlideBlock::Table(rows) => {
                    if let Some(first) = rows.first() {
                        md.push_str(&format!("| {} |\n", first.join(" | ")));
                        md.push_str(&format!(
                            "|{}|\n",
                            vec![" --- "; first.len()].join("|")
                        ));
                        for row in &rows[1..] {
                            md.push_str(&format!("| {} |\n", row.join(" | ")));
                        }
                        md.push('\n');
                    }
                }
                SlideBlock::Image { .. } => md.push_str("[figure]\n\n"),
            }
        }
    }
    md
}

// ── pptx export ──────────────────────────────────────────────────────────────

/// Outcome stats for the export tool's result payload.
#[derive(Debug, Default)]
pub struct ExportStats {
    pub slides: usize,
    pub images_kept: usize,
    pub images_dropped: usize,
}

/// Standard 16:9 pptx canvas (EMU) the writer defaults to.
const CANVAS_W: i64 = 12_192_000;
const CANVAS_H: i64 = 6_858_000;

/// Convert a parsed deck to `.pptx` bytes via `office_oxide::PptxWriter` —
/// deterministic, no LLM. Titles become slide titles, bullets/paragraphs flow
/// as body text, tables render as one text line per row, and raster images
/// (png/jpeg/gif) are embedded centered; anything else (svg, colors, layout)
/// is counted as dropped.
pub fn export_pptx(deck: &ParsedDeck) -> Result<(Vec<u8>, ExportStats), String> {
    let mut writer = PptxWriter::new();
    let mut stats = ExportStats::default();

    if let Some(t) = deck.title.as_deref() {
        writer.set_metadata(&office_oxide::ir::Metadata {
            title: Some(t.to_string()),
            ..Default::default()
        });
    }

    for slide in &deck.slides {
        let sw = writer.add_slide();
        if let Some(t) = slide.title.as_deref() {
            sw.set_title(t);
        }
        for block in &slide.blocks {
            match block {
                SlideBlock::Para(text) => {
                    sw.add_text(text);
                }
                SlideBlock::Bullets(items) => {
                    let refs: Vec<&str> = items.iter().map(String::as_str).collect();
                    sw.add_bullet_list(&refs);
                }
                SlideBlock::Table(rows) => {
                    for row in rows {
                        sw.add_text(&row.join("  |  "));
                    }
                }
                SlideBlock::Image { mime, data } => {
                    let format = match mime.as_str() {
                        "image/png" => Some(ImageFormat::Png),
                        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
                        "image/gif" => Some(ImageFormat::Gif),
                        _ => None,
                    };
                    match (format, image_dims(mime, data)) {
                        (Some(f), Some((w, h))) => {
                            // Fit into a centered box below the title area,
                            // preserving aspect ratio.
                            let avail_w = CANVAS_W * 7 / 10;
                            let avail_h = CANVAS_H / 2;
                            let scale = (avail_w as f64 / w as f64)
                                .min(avail_h as f64 / h as f64)
                                .min(1.0);
                            let dw = (w as f64 * scale) as u64;
                            let dh = (h as f64 * scale) as u64;
                            let x = (CANVAS_W - dw as i64) / 2;
                            let y = CANVAS_H * 3 / 10;
                            sw.add_image(data.clone(), f, x, y, dw, dh);
                            stats.images_kept += 1;
                        }
                        _ => {
                            stats.images_dropped += 1;
                        }
                    }
                }
            }
        }
    }
    stats.slides = deck.slides.len();

    let mut bytes = std::io::Cursor::new(Vec::new());
    writer
        .write_to(&mut bytes)
        .map_err(|e| format!("pptx write failed: {e}"))?;
    Ok((bytes.into_inner(), stats))
}

/// Pixel dimensions of a png/jpeg/gif payload.
fn image_dims(mime: &str, data: &[u8]) -> Option<(u32, u32)> {
    if mime == "image/png" && data.len() >= 24 && data.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
        let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
        return Some((w, h));
    }
    if mime == "image/gif" && data.len() >= 10 && data.starts_with(b"GIF8") {
        let w = u16::from_le_bytes([data[6], data[7]]) as u32;
        let h = u16::from_le_bytes([data[8], data[9]]) as u32;
        return Some((w, h));
    }
    if mime == "image/jpeg" || mime == "image/jpg" {
        let mut i = 2usize;
        while i + 9 < data.len() {
            if data[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = data[i + 1];
            // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
            if (0xC0..=0xCF).contains(&marker)
                && marker != 0xC4
                && marker != 0xC8
                && marker != 0xCC
            {
                let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
                let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
                return Some((w, h));
            }
            if i + 3 < data.len() {
                let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
                i += 2 + seg_len;
            } else {
                break;
            }
        }
    }
    None
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn slide(title: &str, body: &str) -> DeckSlide {
        DeckSlide {
            title: Some(title.into()),
            body_html: body.into(),
        }
    }

    #[test]
    fn sanitizer_strips_scripts_and_handlers() {
        let dirty = "<p onclick=\"evil()\">hi</p><script>alert(1)</script>\
<img src=\"x\" onerror=\"evil()\" onerror2=\"x\">\
<a href=\"javascript:evil()\">link</a>\
<a href=\"https://ok.example\">ok</a>\
<iframe src=\"https://x\"></iframe><style>.a{color:red}</style>";
        let clean = sanitize_html_fragment(dirty);
        assert!(!clean.contains("script"), "{clean}");
        assert!(!clean.contains("iframe"), "{clean}");
        assert!(!clean.contains("onclick"), "{clean}");
        assert!(!clean.contains("onerror"), "{clean}");
        assert!(!clean.contains("javascript:"), "{clean}");
        assert!(clean.contains("<p>hi</p>"), "{clean}");
        assert!(clean.contains("https://ok.example"), "{clean}");
        assert!(clean.contains(".a{color:red}"), "{clean}");
        // The img tag survives (src kept relative), minus handlers.
        assert!(clean.contains("<img src=\"x\">"), "{clean}");
    }

    #[test]
    fn sanitizer_keeps_data_images_and_blocks_remote() {
        let clean = sanitize_html_fragment(
            "<img src=\"data:image/png;base64,AAAA\"><img src=\"data:text/html;base64,PGI+\">",
        );
        assert!(clean.contains("data:image/png"), "{clean}");
        assert!(!clean.contains("data:text/html"), "{clean}");
    }

    #[test]
    fn render_parse_markdown_roundtrip() {
        let slides = vec![
            slide(
                "First",
                "<h3>Sub</h3><p>Hello <b>world</b></p><ul><li>one &amp; only</li><li>two</li></ul>",
            ),
            slide(
                "Data",
                "<table><tr><th>City</th><th>Pop</th></tr><tr><td>Jakarta</td><td>10M</td></tr></table>",
            ),
        ];
        let html = render_deck("My Deck", &slides);
        assert!(html.contains("<section>"));
        assert!(html.contains("Reveal.initialize"));

        let parsed = parse_deck(&html);
        assert_eq!(parsed.title.as_deref(), Some("My Deck"));
        assert_eq!(parsed.slides.len(), 2);
        assert_eq!(parsed.slides[0].title.as_deref(), Some("First"));
        assert!(matches!(&parsed.slides[0].blocks[0], SlideBlock::Para(p) if p == "Sub"));
        assert!(matches!(&parsed.slides[0].blocks[1], SlideBlock::Para(p) if p == "Hello world"));
        assert!(matches!(&parsed.slides[0].blocks[2], SlideBlock::Bullets(b) if b[0] == "one & only"));

        let md = deck_to_markdown(&parsed);
        assert!(md.contains("# My Deck"), "{md}");
        assert!(md.contains("## First"), "{md}");
        assert!(md.contains("- one & only"), "{md}");
        assert!(md.contains("| City | Pop |"), "{md}");
    }

    #[test]
    fn parse_survives_layout_wrappers() {
        let html = render_deck(
            "T",
            &[slide(
                "S",
                "<div class=\"r-stack\"><p>deep</p><div><ul><li>x</li></ul></div></div>",
            )],
        );
        let parsed = parse_deck(&html);
        assert!(parsed.slides[0]
            .blocks
            .iter()
            .any(|b| matches!(b, SlideBlock::Para(p) if p == "deep")));
        assert!(parsed.slides[0]
            .blocks
            .iter()
            .any(|b| matches!(b, SlideBlock::Bullets(v) if v == &["x".to_string()])));
    }

    #[test]
    fn non_deck_html_degrades_to_single_slide() {
        let parsed = parse_deck("<html><head><title>Page</title></head><body><h1>Head</h1><p>Line</p></body></html>");
        assert_eq!(parsed.title.as_deref(), Some("Page"));
        assert_eq!(parsed.slides.len(), 1);
        let md = deck_to_markdown(&parsed);
        assert!(md.contains("Head"), "{md}");
        assert!(md.contains("Line"), "{md}");
    }

    #[test]
    fn export_pptx_embeds_title_bullets_and_image() {
        // 1x1 red PNG.
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D',
            b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xDE,
        ];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let slides = vec![slide(
            "With image",
            &format!("<ul><li>a</li><li>b</li></ul><img src=\"data:image/png;base64,{b64}\">"),
        )];
        let html = render_deck("Deck", &slides);
        let parsed = parse_deck(&html);
        let (bytes, stats) = export_pptx(&parsed).expect("export");
        assert!(bytes.starts_with(b"PK"), "not a zip/pptx");
        assert_eq!(stats.slides, 1);
        assert_eq!(stats.images_kept, 1);
        assert_eq!(stats.images_dropped, 0);
        // The embedded media part is inside the package (zip stores central
        // directory filenames uncompressed, so the path is findable).
        assert!(
            bytes.windows(9).any(|w| w == b"ppt/media"),
            "no media part in package ({} bytes)",
            bytes.len()
        );
    }

    #[test]
    fn exported_pptx_reads_back() {
        let slides = vec![
            slide("A", "<p>one</p><ul><li>x</li></ul>"),
            slide("B", "<p>two</p>"),
        ];
        let html = render_deck("Deck", &slides);
        let parsed = parse_deck(&html);
        let (bytes, stats) = export_pptx(&parsed).expect("export");
        let doc = office_oxide::Document::from_reader(
            std::io::Cursor::new(bytes),
            office_oxide::DocumentFormat::Pptx,
        )
        .expect("office_oxide reads the exported pptx back");
        let text = doc.plain_text();
        assert!(text.contains("one"), "{text:?}");
        assert!(text.contains("two"), "{text:?}");
        assert_eq!(doc.as_pptx().map(|d| d.slides.len()), Some(2));
        assert_eq!(stats.slides, 2);
    }

    #[test]
    fn file_refs_substitute() {
        let mut slides = vec![slide("S", "<img data-file=\"doc1\" alt=\"chart\">")];
        let refs = collect_file_refs(&slides);
        assert_eq!(refs, ["doc1"]);
        let mut map = HashMap::new();
        map.insert(
            "doc1".to_string(),
            ("image/svg+xml".to_string(), b"<svg/>".to_vec()),
        );
        substitute_file_refs(&mut slides, &map);
        assert!(slides[0].body_html.contains("data:image/svg+xml;base64,"), "{:#?}", slides[0]);
        assert!(!slides[0].body_html.contains("data-file"));
    }

    #[test]
    fn entities_decode() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt; &#65; &mdash; &bogus; &"),
            "a & b <c> A \u{2014} &bogus; &");
    }
}
