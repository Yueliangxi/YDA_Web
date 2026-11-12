"""Input validation and workbook-to-chart mapping checks (no dependencies)."""

from decimal import Decimal
import importlib.util
from pathlib import Path
import unittest
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_data", ROOT / "scripts" / "build_data.py")
data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data)


def fixture():
    return {
        "价格发行与成交": [
            data.PRICE_HEADERS,
            ["1", "3", "1", "2", "4"],
            ["1.1", "5", "2", "3", "6"],
            ["已挂 / 成交合计", "8", "3", "5", "10"],
            ["Source price note"],
        ],
        "每日K线": [
            data.DAILY_HEADERS,
            ["第1年 01月01日", "1.1", "10", "1", "1.1", "1", "10.6", "2", "实际成交"],
            ["第1年 01月02日", "1.1", "0", "1.1", "1.1", "1.1", "0", "0", "无成交，沿用前收盘"],
            ["全程成交合计", "", "10", "", "", "", "10.6", "2"],
            ["Source daily note"],
        ],
    }


class DataTests(unittest.TestCase):
    def test_maps_issuance_and_trade_volume_separately(self):
        result = data.parse_data(fixture())
        self.assertEqual(result["prices"][0], {"price": Decimal("1"), "issued": Decimal("3"), "priceHighIssued": Decimal("1"), "volumeHighIssued": Decimal("2"), "volume": Decimal("4")})
        self.assertEqual(len(result["prices"]), 2)
        self.assertEqual(result["meta"]["sourceNotes"]["prices"], ["Source price note"])

    def test_ohlc_mapping_and_no_trade_days(self):
        result = data.parse_data(fixture())
        first, second = result["daily"]
        self.assertEqual([first[key] for key in ("open", "close", "low", "high")], [Decimal("1"), Decimal("1.1"), Decimal("1"), Decimal("1.1")])
        self.assertEqual((second["day"], second["volume"], second["dateLabel"]), (2, Decimal("0"), "第1年 01月02日"))

    def test_rejects_missing_value_instead_of_inventing_zero(self):
        sheets = fixture()
        sheets["价格发行与成交"][1][2] = ""
        with self.assertRaisesRegex(data.DataError, "Missing numeric value"):
            data.parse_data(sheets)

    def test_rejects_duplicate_dates_and_prices(self):
        for sheet, row_index in (("每日K线", 2), ("价格发行与成交", 2)):
            sheets = fixture()
            sheets[sheet][row_index][0] = sheets[sheet][1][0]
            with self.assertRaisesRegex(data.DataError, "Duplicate or unordered"):
                data.parse_data(sheets)

    def test_rejects_inconsistent_candle(self):
        sheets = fixture()
        sheets["每日K线"][1][4] = "1.05"
        with self.assertRaisesRegex(data.DataError, "OHLC"):
            data.parse_data(sheets)

    def test_detects_missing_zero_volume_day_without_relying_on_totals(self):
        sheets = fixture()
        sheets["每日K线"][2][0] = "第1年 01月03日"
        with self.assertRaisesRegex(data.DataError, "Missing simulation day"):
            data.parse_data(sheets)

    def test_rejects_wrong_totals_or_component_split(self):
        for row, column in ((3, 4), (1, 2)):
            sheets = fixture()
            sheets["价格发行与成交"][row][column] = "999"
            with self.assertRaisesRegex(data.DataError, "Total mismatch"):
                data.parse_data(sheets)

    def test_rejects_missing_formula_cache(self):
        cell = ET.fromstring(f'<c xmlns="{data.NS["s"]}" r="A2"><f>1+1</f></c>')
        with self.assertRaisesRegex(data.DataError, "no cached value"):
            data.cell_text(cell, [])

    def test_reads_numeric_text_and_shared_strings(self):
        cell = ET.fromstring(f'<c xmlns="{data.NS["s"]}" r="G2" t="inlineStr"><is><t>174279830.31695015128</t></is></c>')
        self.assertEqual(data.number(data.cell_text(cell, []), "test"), Decimal("174279830.31695015128"))
        shared = ET.fromstring(f'<c xmlns="{data.NS["s"]}" r="A1" t="s"><v>0</v></c>')
        self.assertEqual(data.cell_text(shared, ["模拟日期（UTC）"]), "模拟日期（UTC）")

    def test_current_workbook_reconciles_and_preserves_source_rows(self):
        sheets = data.read_sheets(data.DEFAULT_INPUT)
        result = data.build(data.DEFAULT_INPUT)
        source_dates = [row[0] for row in sheets["每日K线"] if data.DATE_PATTERN.fullmatch(row[0])]
        self.assertEqual([row["dateLabel"] for row in result["daily"]], source_dates)
        self.assertEqual(result["daily"][0]["close"], Decimal(sheets["每日K线"][1][1]))
        self.assertEqual(result["daily"][-1]["day"], len(source_dates))
        self.assertEqual(len(result["meta"]["sourceSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
