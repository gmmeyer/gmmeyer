#!/usr/bin/env python3
"""Render the social-card images (img/og/*.png) for the site.

For every page with an og:image under gmmeyer.com, reads its og:title,
og:description and article:published_time, fills in _cards/card.html and
screenshots it with headless Chrome to the path named by og:image.

    python3 _cards/build.py

Set CHROME=/path/to/chrome if Chrome isn't in /Applications.
"""
import datetime
import html.parser
import os
import pathlib
import subprocess
import tempfile
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "_cards" / "card.html"
CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
SITE = "https://gmmeyer.com/"
NAME = "Greg Meyer"

# Card text that should differ from what the page's meta tags say.
OVERRIDES = {
    "index.html": {
        "title": NAME,
        "kicker": "Software engineer · New York",
        "desc": "Founding engineer at Zingage. Previously co-founder of "
        "Bearworks and senior engineer at Datadog.",
        "byline": "",
    },
}


class Meta(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        key = a.get("property") or a.get("name")
        if tag == "meta" and key and "content" in a:
            self.meta.setdefault(key, a["content"])


def card_for(page):
    parser = Meta()
    parser.feed(page.read_text())
    meta = parser.meta
    image = meta.get("og:image", "")
    if not image.startswith(SITE):
        return None
    card = {
        "title": meta["og:title"].removesuffix(f" — {NAME}"),
        "desc": meta.get("og:description", ""),
        "kicker": "",
        "byline": NAME,
    }
    if "article:published_time" in meta:
        d = datetime.date.fromisoformat(meta["article:published_time"][:10])
        card["kicker"] = f"Blog · {d:%B} {d.day}, {d.year}"
    card.update(OVERRIDES.get(page.relative_to(ROOT).as_posix(), {}))
    return ROOT / image.removeprefix(SITE), card


def render(out, card, profile):
    out.parent.mkdir(parents=True, exist_ok=True)
    query = urllib.parse.urlencode(card, quote_via=urllib.parse.quote)
    subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--window-size=1200,630",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={profile}",
            f"--screenshot={out}",
            f"{TEMPLATE.as_uri()}?{query}",
        ],
        check=True,
        capture_output=True,
    )
    print(out.relative_to(ROOT))


def main():
    pages = sorted(ROOT.glob("*.html")) + sorted(ROOT.glob("posts/*.html"))
    with tempfile.TemporaryDirectory() as profile:
        for page in pages:
            if found := card_for(page):
                render(*found, profile)


if __name__ == "__main__":
    main()
