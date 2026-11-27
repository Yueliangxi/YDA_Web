"""Multi-workbook discovery, identity, description pairing and safe publication."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import StringIO
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from test_data import data, fixture


def workbook(path, sheets=None):
    """A small local XLSX fixture, with the same strict source rows as test_data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    namespace = data.NS["s"]
    root = ET.Element(f"{{{namespace}}}workbook")
    listing = ET.SubElement(root, f"{{{namespace}}}sheets")
    relationships = ET.Element(f"{{{data.PACKAGE_REL_NS}}}Relationships")
    with ZipFile(path, "w") as archive:
        for index, (name, rows) in enumerate((sheets or fixture()).items(), 1):
            identity = f"rId{index}"
            ET.SubElement(listing, f"{{{namespace}}}sheet", name=name, sheetId=str(index),
                          attrib={f"{{{data.REL_NS}}}id": identity})
            ET.SubElement(relationships, f"{{{data.PACKAGE_REL_NS}}}Relationship", Id=identity,
                          Target=f"worksheets/sheet{index}.xml", Type=f"{data.REL_NS}/worksheet")
            sheet = ET.Element(f"{{{namespace}}}worksheet")
            body = ET.SubElement(sheet, f"{{{namespace}}}sheetData")
            for row_number, values in enumerate(rows, 1):
                row = ET.SubElement(body, f"{{{namespace}}}row", r=str(row_number))
                for column, value in enumerate(values):
                    cell = ET.SubElement(row, f"{{{namespace}}}c", r=f"{chr(65 + column)}{row_number}", t="inlineStr")
                    inline = ET.SubElement(cell, f"{{{namespace}}}is")
                    ET.SubElement(inline, f"{{{namespace}}}t").text = value
            archive.writestr(f"xl/worksheets/sheet{index}.xml", ET.tostring(sheet, encoding="utf-8"))
        archive.writestr("xl/workbook.xml", ET.tostring(root, encoding="utf-8"))
        archive.writestr("xl/_rels/workbook.xml.rels", ET.tostring(relationships, encoding="utf-8"))
    return path


def snapshot(directory):
    return {path.relative_to(directory).as_posix(): path.read_bytes()
            for path in directory.rglob("*") if path.is_file()}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sources = self.root / "workbooks"
        self.sources.mkdir()
        self.output = self.root / "data"

    def test_imports_window_coefficient_and_original_nine_column_workbooks_together(self):
        workbook(self.sources / "original.xlsx")
        sheets = fixture()
        daily = sheets["每日K线"]
        daily[0].append("调整系数")
        daily[1].append("10.00  →  10.200000 → 10.00")
        daily[2].append("0")
        workbook(self.sources / "coefficients.xlsx", sheets)
        daily[0][-1] = "发行回看天数"
        daily[1][-1] = "75→76→75"
        daily[2][-1] = "75"
        workbook(self.sources / "windows.xlsx", sheets)

        catalog = data.build_catalog(self.sources, self.output)
        imported = {}
        for entry in catalog["datasets"]:
            payload = json.loads((self.output / entry["dataFile"]).read_text())
            imported[entry["sourceFile"]] = payload["daily"]
        with_coefficients = imported["coefficients.xlsx"]
        self.assertEqual([row.pop("adjustmentCoefficient") for row in with_coefficients],
                         ["10.00  →  10.200000 → 10.00", "0"])
        self.assertEqual(with_coefficients, imported["original.xlsx"])
        with_windows = imported["windows.xlsx"]
        self.assertEqual([row.pop("issueWindowDays") for row in with_windows], ["75→76→75", "75"])
        self.assertEqual(with_windows, imported["original.xlsx"])

        daily[0][-1] = "未知列"
        with self.assertRaisesRegex(data.DataError, "Unexpected column headers in 每日K线"):
            data.build(workbook(self.sources / "unknown.xlsx", sheets))

    def test_requires_nonnegative_finite_daily_coefficient_values_if_column_is_present(self):
        for invalid in (None, "", "10 → ", "10 → → 11", "10 → -0.2", "NaN", "Infinity", "无"):
            with self.subTest(invalid=invalid):
                sheets = fixture()
                rows = sheets["每日K线"]
                rows[0].append("调整系数")
                rows[1].append("10")
                if invalid is not None:
                    rows[2].append(invalid)
                with self.assertRaisesRegex(data.DataError, "第1年 01月02日 调整系数"):
                    data.build(workbook(self.sources / "invalid.xlsx", sheets))

    def test_window_entries_are_positive_whole_days(self):
        for invalid in (None, "75→", "75→0", "75→-1", "75→76.5", "NaN"):
            with self.subTest(invalid=invalid):
                sheets = fixture()
                rows = sheets["每日K线"]
                rows[0].append("发行回看天数")
                rows[1].append("75")
                if invalid is not None:
                    rows[2].append(invalid)
                with self.assertRaisesRegex(data.DataError, "第1年 01月02日 发行回看天数"):
                    data.build(workbook(self.sources / "invalid.xlsx", sheets))

    def test_discovers_only_visible_workbooks_naturally_without_following_links(self):
        for name in ("方案10.xlsx", "方案2.xlsx", "nested/中文 空格#&.XLSX"):
            workbook(self.sources / name)
        for name in ("~$打开中.xlsx", ".隐藏.xlsx", ".cache/broken.xlsx", "~$temp/broken.xlsx"):
            path = self.sources / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"not an xlsx")
        (self.sources / "孤立说明.md").write_bytes(b"\xff")
        outside = self.root / "private"
        outside.mkdir()
        (outside / "broken.xlsx").write_bytes(b"not public")
        (self.sources / "linked.xlsx").symlink_to(outside / "broken.xlsx")
        (self.sources / "linked-directory").symlink_to(outside, target_is_directory=True)
        found = [path.relative_to(self.sources).as_posix() for path in data.discover_workbooks(self.sources)]
        self.assertEqual(found, ["nested/中文 空格#&.XLSX", "方案2.xlsx", "方案10.xlsx"])
        catalog = data.build_catalog(self.sources, self.output)
        self.assertEqual(len(catalog["datasets"]), 3)
        self.assertEqual(catalog["defaultId"], catalog["datasets"][0]["id"])
        special = catalog["datasets"][0]
        self.assertEqual(special["sourcePath"], "workbooks/nested/中文 空格#&.XLSX")
        self.assertEqual(special["title"], "中文 空格#&")

    def test_fixed_default_wins_and_stable_path_ids_do_not_depend_on_order_or_content(self):
        preferred = workbook(self.sources / data.DEFAULT_INPUT.name)
        shutil.copyfile(preferred, self.sources / "A2.xlsx")
        first = data.build_catalog(self.sources, self.output)
        by_name = {entry["sourceFile"]: entry for entry in first["datasets"]}
        identity = by_name[preferred.name]["id"]
        self.assertEqual(identity, "w-" + hashlib.sha256(preferred.name.encode("utf-8")).hexdigest()[:16])
        self.assertEqual(first["defaultId"], identity)
        self.assertNotEqual(identity, by_name["A2.xlsx"]["id"])
        self.assertEqual(by_name[preferred.name]["sourceSha256"], by_name["A2.xlsx"]["sourceSha256"])
        workbook(self.sources / "A1.xlsx")
        changed = fixture()
        changed["价格发行与成交"][-1] = ["Updated source note"]
        workbook(preferred, changed)
        second = data.build_catalog(self.sources, self.output)
        by_name_again = {entry["sourceFile"]: entry for entry in second["datasets"]}
        self.assertEqual(second["defaultId"], identity)
        self.assertEqual(by_name_again["A2.xlsx"]["id"], by_name["A2.xlsx"]["id"])
        self.assertNotEqual(by_name_again[preferred.name]["sourceSha256"], by_name[preferred.name]["sourceSha256"])
        self.assertNotEqual(by_name_again[preferred.name]["dataSha256"], by_name[preferred.name]["dataSha256"])

    def test_natural_fallback_default_and_manifest_alias_hashes_agree(self):
        workbook(self.sources / "试验10.xlsx")
        workbook(self.sources / "试验2.xlsx")
        catalog = data.build_catalog(self.sources, self.output)
        self.assertEqual([entry["title"] for entry in catalog["datasets"]], ["试验2", "试验10"])
        self.assertEqual(catalog["defaultId"], catalog["datasets"][0]["id"])
        self.assertEqual(json.loads((self.output / "catalog.json").read_text()), catalog)
        for entry in catalog["datasets"]:
            raw = (self.output / entry["dataFile"]).read_bytes()
            payload = json.loads(raw)
            self.assertEqual(entry["dataSha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(entry["sourceSha256"], hashlib.sha256((self.root / entry["sourcePath"]).read_bytes()).hexdigest())
            for key in ("sourceFile", "sourceSha256", "dayCount", "priceCount", "firstDate", "lastDate"):
                self.assertEqual(entry[key], payload["meta"][key])
            self.assertIsNone(payload["meta"]["descriptionMarkdown"])
            self.assertIsNone(payload["meta"]["descriptionFile"])
            if entry["id"] == catalog["defaultId"]:
                self.assertEqual((self.output / "market.json").read_bytes(), raw)
        before = snapshot(self.output)
        data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)

    def test_workbook_circulation_is_exact_in_published_json(self):
        sheets = fixture()
        sheets["每日K线"][1][8] += "\n01:00 拆分　每 1 YDA 拆为 10 YDA"
        qty = "267805606563.15804783"
        sheets["流通量"] = [data.SUPPLY_HEADERS, ["1", "10", qty, "0", qty], ["2", "10", qty, "0", qty]]
        workbook(self.sources / "拆分.xlsx", sheets)
        data.build_catalog(self.sources, self.output)
        payload = json.loads((self.output / "market.json").read_text())
        self.assertEqual(payload["meta"]["circulatingSupply"], qty)
        self.assertEqual(payload["daily"][-1]["splitFactor"], "10")

    def test_descriptions_pair_in_the_same_directory_and_markdown_only_change_refreshes_data_hash(self):
        for name in ("first/同名.xlsx", "second/同名.xlsx", "缺说明.xlsx"):
            workbook(self.sources / name)
        (self.sources / "first/同名.md").write_text("\ufeff# 第一份\n\n参数 **1%**\n", encoding="utf-8")
        (self.sources / "second/同名.md").write_text("# 第二份\n参数20,000 HK", encoding="utf-8")
        (self.sources / "无Excel.md").write_text("not a dataset", encoding="utf-8")
        first = data.build_catalog(self.sources, self.output)
        entries = {entry["sourcePath"]: entry for entry in first["datasets"]}
        self.assertEqual(len(entries), 3)
        payloads = {source: json.loads((self.output / entry["dataFile"]).read_text()) for source, entry in entries.items()}
        self.assertEqual(payloads["workbooks/first/同名.xlsx"]["meta"]["descriptionMarkdown"], "# 第一份\n\n参数 **1%**\n")
        self.assertEqual(payloads["workbooks/second/同名.xlsx"]["meta"]["descriptionMarkdown"], "# 第二份\n参数20,000 HK")
        self.assertEqual(payloads["workbooks/first/同名.xlsx"]["meta"]["descriptionFile"], "同名.md")
        self.assertIsNone(payloads["workbooks/缺说明.xlsx"]["meta"]["descriptionMarkdown"])
        (self.sources / "first/同名.md").write_text("# 已更新说明", encoding="utf-8")
        second = data.build_catalog(self.sources, self.output)
        updated = {entry["sourcePath"]: entry for entry in second["datasets"]}
        for source in entries:
            self.assertEqual(entries[source]["id"], updated[source]["id"])
            self.assertEqual(entries[source]["sourceSha256"], updated[source]["sourceSha256"])
            self.assertEqual(entries[source]["dataSha256"] == updated[source]["dataSha256"], "first/" not in source)

    def test_bad_workbook_or_bad_description_preserves_all_previous_outputs(self):
        workbook(self.sources / "有效.xlsx")
        data.build_catalog(self.sources, self.output)
        (self.output / "keep.txt").write_text("unrelated output", encoding="utf-8")
        before = snapshot(self.output)
        bad = self.sources / "损坏 文件.xlsx"
        bad.write_bytes(b"not a zip")
        with self.assertRaisesRegex(data.DataError, "损坏 文件.xlsx"):
            data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)
        bad.unlink()
        description = self.sources / "有效.md"
        description.write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(data.DataError, "有效.md"):
            data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)
        description.unlink()
        description.mkdir()
        with self.assertRaisesRegex(data.DataError, "有效.md"):
            data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)
        self.assertFalse(list(self.root.glob(".data-*-*")))

    def test_no_workbooks_does_not_publish_an_empty_catalog(self):
        workbook(self.sources / "唯一.xlsx")
        data.build_catalog(self.sources, self.output)
        before = snapshot(self.output)
        (self.sources / "唯一.xlsx").unlink()
        (self.sources / "孤立.md").write_text("not a workbook", encoding="utf-8")
        with self.assertRaisesRegex(data.DataError, "No .xlsx workbooks.*workbooks"):
            data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)

    def test_failed_publication_rolls_back_then_success_removes_stale_datasets_only(self):
        workbook(self.sources / "old.xlsx")
        old = data.build_catalog(self.sources, self.output)
        (self.output / "keep.txt").write_text("keep", encoding="utf-8")
        before = snapshot(self.output)
        (self.sources / "old.xlsx").unlink()
        workbook(self.sources / "new.xlsx")
        original_replace = data.os.replace
        def fail_catalog(source, target):
            if Path(source).name == "catalog.json" and Path(source).parent.name.startswith(".data-build-"):
                raise OSError("injected catalog publication failure")
            return original_replace(source, target)
        with mock.patch.object(data.os, "replace", side_effect=fail_catalog):
            with self.assertRaisesRegex(OSError, "injected"):
                data.build_catalog(self.sources, self.output)
        self.assertEqual(snapshot(self.output), before)
        new = data.build_catalog(self.sources, self.output)
        self.assertFalse((self.output / old["datasets"][0]["dataFile"]).exists())
        self.assertTrue((self.output / new["datasets"][0]["dataFile"]).exists())
        self.assertEqual((self.output / "keep.txt").read_text(), "keep")
        self.assertFalse(list(self.root.glob(".data-*-*")))

    def test_cli_keeps_explicit_single_mode_and_no_arguments_dispatches_to_catalog(self):
        source = workbook(self.sources / "single.xlsx")
        target = self.root / "single.json"
        with mock.patch.object(sys, "argv", ["build_data.py", "--input", str(source), "--output", str(target)]):
            with redirect_stdout(StringIO()):
                self.assertEqual(data.main(), 0)
        self.assertEqual(json.loads(target.read_text())["meta"]["sourceFile"], "single.xlsx")
        self.assertFalse(self.output.exists())
        previous = target.read_bytes()
        source.write_bytes(b"corrupt")
        error = StringIO()
        with mock.patch.object(sys, "argv", ["build_data.py", "--input", str(source), "--output", str(target)]):
            with redirect_stderr(error):
                self.assertEqual(data.main(), 1)
        self.assertIn("single.xlsx", error.getvalue())
        self.assertEqual(target.read_bytes(), previous)
        with mock.patch.object(sys, "argv", ["build_data.py"]), mock.patch.object(data, "build_catalog", return_value={"datasets": []}) as build:
            with redirect_stdout(StringIO()):
                self.assertEqual(data.main(), 0)
            build.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
