"""_drafts/<slug>.md (front matter + markdown) -> posts/<slug>.html, plus the
post's entry on blog.html.

  python3 _drafts/md2html.py . <slug> [--check]      # from the site root

Everything outside the article (site header, footer) is kept from the current
HTML. The front matter sets <title>, the description and og tags, the date
(published_time, the <time> under the title, and the month on blog.html). A
comment at the top of the markdown goes just before <article>, where the draft
notes sit. --check prints a diff against the current files instead of writing.

Markdown: ## headings, paragraphs, - and 1. lists, | tables |, ``` code blocks,
`code`, **bold**, *italic*, [links](url), and <!-- comments -->. Raw HTML in the
text is escaped, so a < in prose stays a <.
"""
import datetime
import difflib
import pathlib
import re
import sys

root, slug = pathlib.Path(sys.argv[1]), sys.argv[2]
check = "--check" in sys.argv
md_path = root / "_drafts" / f"{slug}.md"
html_path = root / "posts" / f"{slug}.html"
blog_path = root / "blog.html"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def attr(s):
    return esc(s).replace('"', "&quot;")


def inline(s):
    codes = []

    def keep(m):
        codes.append("<code>" + esc(m.group(1)) + "</code>")
        return f"\x00{len(codes) - 1}\x00"

    s = re.sub(r"`([^`]+)`", keep, s)
    s = esc(s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{m.group(2).replace(chr(34), "&quot;")}">{m.group(1)}</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", s)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], s)


def split_blocks(text):
    blocks, cur, fence, comment = [], [], False, False
    for ln in text.split("\n"):
        if fence:
            cur.append(ln)
            if ln.startswith("```"):
                blocks.append(cur)
                cur, fence = [], False
        elif comment:
            cur.append(ln)
            comment = "-->" not in ln
        elif ln.startswith("```"):
            if cur:
                blocks.append(cur)
            cur, fence = [ln], True
        elif not ln.strip():
            if cur:
                blocks.append(cur)
            cur = []
        else:
            cur.append(ln)
            comment = ln.lstrip().startswith("<!--") and "-->" not in ln
    assert not fence, "unclosed ``` code block"
    if cur:
        blocks.append(cur)
    return blocks


def items(lines, marker):
    out = []
    for ln in lines:
        m = re.match(marker, ln)
        if m:
            out.append(ln[m.end():].strip())
        else:
            out[-1] += " " + ln.strip()
    return out


def cells(ln):
    ln = ln.strip().removeprefix("|").removesuffix("|")
    return [inline(c.strip().replace("\\|", "|")) for c in re.split(r"(?<!\\)\|", ln)]


def render(b):
    first = b[0].strip()
    if first.startswith("```"):
        return "  <pre><code>" + esc("\n".join(b[1:-1])) + "</code></pre>"
    if first.startswith("<!--"):
        if first.endswith("-->") and len(b) > 1:    # a one-line note on the block below it
            return "  " + first + "\n" + render(b[1:])
        return "\n".join("  " + ln if ln.strip() else ln for ln in b)
    if m := re.match(r"(#{2,4}) ", first):
        n = len(m.group(1))
        return f"  <h{n}>{inline(' '.join(ln.strip() for ln in b)[n + 1:])}</h{n}>"
    if first.startswith("|"):
        head, rows = cells(b[0]), [cells(r) for r in b[2:]]
        th = "".join(f"<th>{c}</th>" for c in head)
        trs = "".join("      <tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>\n" for r in rows)
        return f"  <table>\n    <thead><tr>{th}</tr></thead>\n    <tbody>\n{trs}    </tbody>\n  </table>"
    if re.match(r"[-*] ", first):
        lis = "".join(f"    <li>{inline(i)}</li>\n" for i in items(b, r"\s*[-*] "))
        return f"  <ul>\n{lis}  </ul>"
    if re.match(r"\d+\. ", first):
        lis = "".join(f"    <li>{inline(i)}</li>\n" for i in items(b, r"\s*\d+\. "))
        return f"  <ol>\n{lis}  </ol>"
    return "  <p>" + inline(" ".join(ln.strip() for ln in b)) + "</p>"


md = md_path.read_text(encoding="utf-8").replace("\r\n", "\n")
m = re.match(r"---\n(.*?)\n---\n", md, re.S)
fm = dict(ln.split(": ", 1) for ln in m.group(1).split("\n") if ln.strip())
for k in ("title", "dek", "date", "description"):
    assert fm.get(k, "").strip(), f"front matter needs {k}"
fm = {k: v.strip() for k, v in fm.items()}
date = datetime.date.fromisoformat(fm["date"])
blocks = split_blocks(md[m.end():])
lead = ""
if blocks and blocks[0][0].startswith("<!--"):
    lead = "\n".join(blocks.pop(0)) + "\n\n"

article = (
    f'{lead}<article class="post">\n'
    f'  <header class="post-head">\n'
    f'    <h1>{esc(fm["title"])}</h1>\n'
    f'    <p class="dek">{inline(fm["dek"])}</p>\n'
    f'    <time datetime="{date.isoformat()}">{date:%B} {date.day}, {date.year}</time>\n'
    f'  </header>\n\n'
    + "\n\n".join(render(b) for b in blocks)
    + "\n</article>"
)

old = html_path.read_text(encoding="utf-8")
new, n = re.subn(r"(</nav>\n</header>\n\n).*?</article>", lambda m: m.group(1) + article, old, count=1, flags=re.S)
assert n == 1, "couldn't find the article in the HTML"
for pat, val in [
    (r"<title>.*?</title>", f"<title>{esc(fm['title'])} — Greg Meyer</title>"),
    (r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{attr(fm["description"])}">'),
    (r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{attr(fm["title"])}">'),
    (r'<meta property="og:description" content="[^"]*">', f'<meta property="og:description" content="{attr(fm["description"])}">'),
    (r'<meta property="article:published_time" content="[^"]*">', f'<meta property="article:published_time" content="{date.isoformat()}">'),
]:
    new, n = re.subn(pat, lambda _: val, new, count=1)
    assert n == 1, pat

blog_old = blog_path.read_text(encoding="utf-8")
blog_new, n = re.subn(
    rf'(<h3><a href="posts/{re.escape(slug)}\.html">).*?(</a></h3>\s*<span class="when">).*?(</span>)',
    lambda m: f"{m.group(1)}{esc(fm['title'])}{m.group(2)}{date:%b %Y}{m.group(3)}", blog_old, count=1)
assert n == 1, "couldn't find the post on blog.html"

for path, a, b in [(html_path, old, new), (blog_path, blog_old, blog_new)]:
    if check:
        diff = list(difflib.unified_diff(a.splitlines(), b.splitlines(), str(path), "from markdown", lineterm="", n=0))
        print("\n".join(diff) if diff else f"{path.name}: identical")
    elif a != b:
        path.write_text(b, encoding="utf-8", newline="\n")
        print("wrote", path)
