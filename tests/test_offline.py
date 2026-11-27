"""Verify the local HTML export against the same workbook data as the website."""

import base64
from functools import partial
import gzip
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import build_offline as offline
from test_catalog import workbook


class OfflinePage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []
        self.scripts = {}
        self.script_id = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link":
            self.assets.append(attrs["href"])
        elif tag == "script":
            if "src" in attrs:
                self.assets.append(attrs["src"])
            self.script_id = attrs.get("id")

    def handle_data(self, text):
        if self.script_id:
            self.scripts[self.script_id] = text

    def handle_endtag(self, tag):
        if tag == "script":
            self.script_id = None


class OfflineTests(unittest.TestCase):
    def test_packs_verified_workbooks_and_preserves_previous_export_on_error(self):
        with tempfile.TemporaryDirectory() as folder:
            sources = Path(folder) / "workbooks"
            first = workbook(sources / "a.xlsx")
            selected = workbook(sources / "行情 & 参数.xlsx")
            description = "# 参数\n\n字面内容 </script> & 价格"
            selected.with_suffix(".md").write_text(description, encoding="utf-8")
            destination = Path(folder) / "行情.html"
            build_catalog = partial(offline.build_data.build_catalog, directory=sources)
            with patch.object(offline.build_data, "build_catalog", build_catalog):
                offline.build_offline(destination, selected.name)
                saved = destination.read_bytes()
                page = OfflinePage()
                page.feed(saved.decode("utf-8"))
                self.assertTrue(page.assets)
                self.assertTrue(all(url.startswith("data:") for url in page.assets))
                self.assertIn("Apache License", json.loads(page.scripts["echarts-license"]))
                catalog = json.loads(page.scripts["offline-catalog"])
                self.assertEqual([e["sourceFile"] for e in catalog["datasets"]], [first.name, selected.name])
                self.assertEqual(catalog["defaultId"], catalog["datasets"][1]["id"])
                for entry in catalog["datasets"]:
                    raw = gzip.decompress(base64.b64decode(page.scripts["offline-" + entry["id"]], validate=True))
                    self.assertEqual(hashlib.sha256(raw).hexdigest(), entry["dataSha256"])
                    payload = json.loads(raw)
                    self.assertEqual(len(payload["daily"]), 2)
                    expected_notes = description if entry["sourceFile"] == selected.name else None
                    self.assertEqual(payload["meta"]["descriptionMarkdown"], expected_notes)

                with self.assertRaisesRegex(ValueError, "matching"):
                    offline.build_offline(destination, "不存在.xlsx")
                self.assertEqual(destination.read_bytes(), saved)
