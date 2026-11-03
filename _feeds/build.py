#!/usr/bin/env python3
"""Write sitemap.xml and feed.xml from the pages' own meta tags.

Every page with a <link rel="canonical"> goes in the sitemap. Its <lastmod> is
the date of the last commit that touched the page, or today if the page has
uncommitted changes. Posts (og:type "article") also go in the RSS feed, newest
first, using og:title, the meta description and article:published_time.

    python3 _feeds/build.py
"""
import datetime
import email.utils
import html.parser
import pathlib
import subprocess
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://gmmeyer.com/"
NAME = "Greg Meyer"


class Head(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self.canonical = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        key = a.get("property") or a.get("name")
        if tag == "meta" and key and "content" in a:
            self.meta.setdefault(key, a["content"])
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")


def read(page):
    head = Head()
    head.feed(page.read_text())
    return head


def lastmod(page):
    rel = page.relative_to(ROOT).as_posix()
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--", rel], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    committed = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", rel], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    return committed if committed and not dirty else datetime.date.today().isoformat()


def sitemap(pages):
    urls = "".join(
        f"  <url>\n    <loc>{escape(head.canonical)}</loc>\n"
        f"    <lastmod>{lastmod(page)}</lastmod>\n  </url>\n"
        for page, head in pages
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}</urlset>\n"
    )


def feed(posts, blog):
    items = ""
    for _, head in posts:
        m = head.meta
        d = datetime.date.fromisoformat(m["article:published_time"][:10])
        # Noon UTC so the date reads the same in US and European timezones.
        when = datetime.datetime(d.year, d.month, d.day, 12, tzinfo=datetime.timezone.utc)
        items += (
            "    <item>\n"
            f"      <title>{escape(m['og:title'])}</title>\n"
            f"      <link>{escape(head.canonical)}</link>\n"
            f'      <guid isPermaLink="true">{escape(head.canonical)}</guid>\n'
            f"      <pubDate>{email.utils.format_datetime(when)}</pubDate>\n"
            f"      <dc:creator>{NAME}</dc:creator>\n"
            f"      <description>{escape(m.get('description', ''))}</description>\n"
            "    </item>\n"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        "  <channel>\n"
        f"    <title>{NAME}</title>\n"
        f"    <link>{escape(blog.canonical)}</link>\n"
        f"    <description>{escape(blog.meta['description'])}</description>\n"
        "    <language>en</language>\n"
        f'    <atom:link href="{SITE}feed.xml" rel="self" type="application/rss+xml"/>\n'
        f"{items}"
        "  </channel>\n"
        "</rss>\n"
    )


def main():
    top = sorted(ROOT.glob("*.html"), key=lambda p: (p.name != "index.html", p.name))
    pages = [(p, read(p)) for p in top + sorted(ROOT.glob("posts/*.html"))]
    pages = [(p, h) for p, h in pages if h.canonical and h.canonical.startswith(SITE)]
    posts = sorted(
        ((p, h) for p, h in pages if h.meta.get("og:type") == "article"),
        key=lambda ph: ph[1].meta["article:published_time"],
        reverse=True,
    )
    # Pages first, then posts newest first.
    ordered = [ph for ph in pages if ph not in posts] + posts
    blog = next(h for p, h in pages if p.name == "blog.html")

    (ROOT / "sitemap.xml").write_text(sitemap(ordered))
    (ROOT / "feed.xml").write_text(feed(posts, blog))
    print(f"sitemap.xml: {len(ordered)} urls, feed.xml: {len(posts)} posts")


if __name__ == "__main__":
    main()
