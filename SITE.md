# gmmeyer.com — site notes

Personal site / online resume for Greg Meyer. Plain static HTML pages, served by GitHub Pages at [gmmeyer.com](https://gmmeyer.com).

## Social cards

Each page has Open Graph / Twitter meta tags pointing at a 1200×630 image in `img/og/`. After adding a post (copy the `og:*` tags from an existing post) or changing a title/description, regenerate the images with headless Chrome:

```sh
python3 _cards/build.py
```

## Search: sitemap, feed and structured data

`sitemap.xml` (every page with a canonical link) and `feed.xml` (RSS of every `og:type` article) are generated from the pages' meta tags. Rerun after adding a post or changing a page:

```sh
python3 _feeds/build.py
```

Each post also carries a `BlogPosting` JSON-LD block in its `<head>`, and the home page has `WebSite` / `ProfilePage` / `Person` JSON-LD. When adding a post, copy the block from an existing post and update `headline`, `description`, `datePublished`, `url`, `mainEntityOfPage` and `image`. Check changes with Google's [Rich Results Test](https://search.google.com/test/rich-results).

On posts, the site name in the top header is a `<p class="site-name">`, not an `<h1>`, so the post title is the page's only `<h1>`.

## Icons

`favicon.ico`, `icon-192.png` and `apple-touch-icon.png` are rendered from `_cards/icon.html`:

```sh
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=512,512 --default-background-color=00000000 \
  --screenshot=/tmp/icon-512.png "file://$PWD/_cards/icon.html"
magick /tmp/icon-512.png -resize 192x192 -strip icon-192.png
magick /tmp/icon-512.png -background "#0b5fa5" -alpha remove -resize 180x180 -strip apple-touch-icon.png
magick /tmp/icon-512.png -define icon:auto-resize=48,32,16 favicon.ico
```
