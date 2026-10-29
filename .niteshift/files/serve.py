#!/usr/bin/env python3
"""Serve the site for the Niteshift preview, close to how GitHub Pages does.

This is `python3 -m http.server` plus what the preview needs from it: Range
requests, so the post videos can seek; revalidation on every load, so edits show
up on refresh; and Pages' URL handling (/blog serves blog.html, and folders
without an index.html are a 404 rather than a listing).

    serve.py PORT
"""
import http.server
import os
import re
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        fs = super().translate_path(path)
        if not os.path.exists(fs) and os.path.isfile(fs + ".html"):
            return fs + ".html"
        return fs

    def list_directory(self, path):
        self.send_error(404)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        self.range = None
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if not m or m.groups() == ("", "") or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first, last = m.groups()
        if first:
            start, end = int(first), min(int(last or size - 1), size - 1)
        else:
            start, end = max(size - int(last), 0), size - 1
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        f = open(path, "rb")
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.range = (start, end - start + 1)
        return f

    def copyfile(self, source, outputfile):
        if self.range is None:
            return super().copyfile(source, outputfile)
        start, left = self.range
        source.seek(start)
        while left > 0 and (chunk := source.read(min(left, 1 << 16))):
            outputfile.write(chunk)
            left -= len(chunk)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("", int(sys.argv[1])), Handler).serve_forever()
