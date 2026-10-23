# gmmeyer.com

Personal site / online resume for Greg Meyer. A single static `index.html`, served by GitHub Pages at [gmmeyer.com](https://gmmeyer.com).

## Social cards

Each page has Open Graph / Twitter meta tags pointing at a 1200×630 image in `img/og/`. After adding a post (copy the `og:*` tags from an existing post) or changing a title/description, regenerate the images with headless Chrome:

```sh
python3 _cards/build.py
```
