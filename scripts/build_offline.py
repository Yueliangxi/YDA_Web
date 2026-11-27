#!/usr/bin/env python3
"""Build one self-contained YDA market HTML file from the current workbooks."""

import argparse
import base64
import gzip
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import BadZipFile

if __package__:
    from . import build_data
else:
    import build_data


ROOT = build_data.ROOT
DEFAULT_OUTPUT = ROOT / "YDA本地行情.html"
ASSET_TAG = re.compile(r"""<(?:link|script)\b[^>]*>""", re.IGNORECASE)
ASSET_URL = re.compile(r"""\b(?:href|src)\s*=\s*(["'])(.*?)\1""", re.IGNORECASE)
MIME_TYPES = {".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml"}


def inline_asset(match):
    tag = match.group()
    reference = ASSET_URL.search(tag)
    if not reference:
        return tag
    url = urlsplit(reference[2])
    if url.scheme == "data":
        return tag
    if url.scheme or url.netloc or url.path.startswith("/"):
        raise ValueError(f"Expected a relative asset URL in {tag}")
    asset = (ROOT / unquote(url.path)).resolve()
    if not asset.is_relative_to(ROOT) or asset.suffix not in MIME_TYPES:
        raise ValueError(f"Unsupported offline asset: {url.path}")
    encoded = base64.b64encode(asset.read_bytes()).decode("ascii")
    start, end = reference.span(2)
    return tag[:start] + f"data:{MIME_TYPES[asset.suffix]};base64,{encoded}" + tag[end:]


def embedded_json(data):
    # A workbook title or the license text may contain a literal HTML end tag.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", r"\u003c")


def build_offline(output, default_workbook=None):
    template = ROOT / "index.html"
    output = Path(output).resolve()
    if output == template or output.suffix.lower() not in (".html", ".htm"):
        raise ValueError("Choose a separate .html output file for the offline page")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".yda-offline-", dir=output.parent) as temporary:
        staging = Path(temporary)
        data_dir = staging / "data"
        catalog = build_data.build_catalog(output=data_dir)
        if default_workbook:
            entries = [e for e in catalog["datasets"] if default_workbook in (
                e["sourceFile"], e["title"], e["sourcePath"],
                Path(e["sourcePath"]).relative_to(build_data.WORKBOOKS.name).as_posix(),
            )]
            if len(entries) != 1:
                raise ValueError(f"Expected one workbook matching {default_workbook!r}, found {len(entries)}")
            catalog["defaultId"] = entries[0]["id"]

        html = ASSET_TAG.sub(inline_asset, template.read_text(encoding="utf-8"))
        before, separator, after = html.rpartition("</body>")
        if not separator:
            raise ValueError(f"Missing </body> in {template}")
        license_text = "\n\n".join((ROOT / "vendor" / name).read_text(encoding="utf-8")
                                  for name in ("ECHARTS-NOTICE.txt", "ECHARTS-LICENSE.txt"))
        page = staging / "offline.html"
        with page.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(before)
            stream.write(f'<script id="echarts-license" type="application/json">{embedded_json(license_text)}</script>\n')
            stream.write(f'<script id="offline-catalog" type="application/json">{embedded_json(catalog)}</script>\n')
            for entry in catalog["datasets"]:
                source = data_dir / entry["dataFile"]
                compressed = gzip.compress(source.read_bytes(), compresslevel=6, mtime=0)
                encoded = base64.b64encode(compressed).decode("ascii")
                stream.write(f'<script id="offline-{entry["id"]}" type="application/octet-stream">{encoded}</script>\n')
            stream.write(separator + after)
        os.replace(page, output)
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Destination HTML file")
    parser.add_argument("--default", metavar="WORKBOOK", help="Workbook to display first (name or relative path)")
    args = parser.parse_args()
    try:
        catalog = build_offline(args.output, args.default)
    except (ValueError, OSError, BadZipFile, KeyError, ET.ParseError) as error:
        print(f"Offline build failed: {error}", file=sys.stderr)
        return 1
    print(f"Exported {len(catalog['datasets'])} workbooks to {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
