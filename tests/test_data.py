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
            data.PRICE_HEADERS.copy(),
            ["1", "3", "1", "2", "4"],
            ["1.1", "5", "2", "3", "6"],
            ["已挂 / 成交合计", "8", "3", "5", "10"],
            ["Source price note"],
        ],
        "每日K线": [
            data.DAILY_HEADERS.copy(),
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
        self.assertEqual(result["meta"]["issuanceBasis"], "actual-order-price")
        self.assertIn("实际挂单价", result["meta"]["issuanceDescription"])

    def test_accepts_batch_issuance_schema_and_preserves_its_meaning(self):
        sheets = fixture()
        sheets["价格发行与成交"][0][1] = "发行量（整批）\nYDA"
        sheets["价格发行与成交"][3][0] = "发行 / 成交合计"
        result = data.parse_data(sheets)
        self.assertEqual(result["meta"]["issuanceBasis"], "batch-primary-price")
        self.assertIn("主发行价", result["meta"]["issuanceDescription"])
        self.assertIn("待挂", result["meta"]["issuanceDescription"])
        self.assertEqual(result["prices"][0]["issued"], Decimal("3"))
        self.assertEqual(result["meta"]["sourceNotes"]["prices"], ["Source price note"])

    def test_rejects_mismatched_issuance_header_and_total_label(self):
        for header, total in (("发行量（已挂）YDA", "发行 / 成交合计"), ("发行量（整批）YDA", "已挂 / 成交合计")):
            with self.subTest(header=header):
                sheets = fixture()
                sheets["价格发行与成交"][0][1] = header
                sheets["价格发行与成交"][3][0] = total
                with self.assertRaisesRegex(data.DataError, "does not match issuance header"):
                    data.parse_data(sheets)

    def test_rejects_unknown_issuance_schema(self):
        sheets = fixture()
        sheets["价格发行与成交"][0][1] = "发行量YDA"
        with self.assertRaisesRegex(data.DataError, "Unexpected column headers"):
            data.parse_data(sheets)

    def test_ohlc_mapping_and_no_trade_days(self):
        result = data.parse_data(fixture())
        first, second = result["daily"]
        self.assertEqual([first[key] for key in ("open", "close", "low", "high")], [Decimal("1"), Decimal("1.1"), Decimal("1"), Decimal("1.1")])
        self.assertEqual((second["day"], second["volume"], second["dateLabel"]), (2, Decimal("0"), "第1年 01月02日"))

    def test_circulation_uses_settled_new_unit_balances_with_exact_decimals(self):
        sheets = fixture()
        split = "01:00 拆分　每 1 YDA 拆为 10 YDA，拆分前 100.000 HKD/YDA，拆分后参考价 10.000 HKD/YDA"
        sheets["每日K线"][1][8] += "\n" + split + "\n" + split
        sheets["流通量"] = [
            data.SUPPLY_HEADERS,
            ["1", "100", "999999999999999999999.00000001", "1", "999999999999999999998.00000001"],
            ["2", "100", "999999999999999999999.00000001", "0", "999999999999999999999.00000001"],
        ]
        result = data.parse_data(sheets)
        self.assertEqual(result["meta"]["circulatingSupply"], sheets["流通量"][2][4])
        self.assertEqual(result["meta"]["splitFactor"], "100")
        self.assertEqual(result["daily"][0]["circulatingSupply"], sheets["流通量"][1][4])
        self.assertEqual(result["daily"][0]["volume"], 10)
        self.assertIn("流通量", result["meta"]["sheetNames"])

    def test_legacy_split_status_exposes_units_without_claiming_circulation(self):
        sheets = fixture()
        before = data.parse_data(sheets)
        self.assertNotIn("circulatingSupply", before["meta"])
        self.assertNotIn("splitFactor", before["daily"][0])
        sheets["每日K线"][1][8] += "\n03:00 拆分　每 1 YDA 拆为 10 YDA，拆分前 10.000 HKD/YDA，拆分后参考价 1.000 HKD/YDA"
        legacy = data.parse_data(sheets)
        self.assertNotIn("circulatingSupply", legacy["meta"])
        self.assertEqual([row["splitFactor"] for row in legacy["daily"]], ["10", "10"])
        self.assertEqual(legacy["meta"]["splitFactor"], "10")

    def test_unknown_circulation_is_distinct_from_zero_and_checked(self):
        sheets = fixture()
        sheets["流通量"] = [data.SUPPLY_HEADERS, ["1", "1", "2", "2", "0"], ["2", "1", "2", "3"]]
        result = data.parse_data(sheets)
        self.assertEqual([row["circulatingSupply"] for row in result["daily"]], ["0", None])
        self.assertIsNone(result["meta"]["circulatingSupply"])
        sheets["流通量"][2].append("0")
        with self.assertRaisesRegex(data.DataError, "must be blank"):
            data.parse_data(sheets)

    def test_circulation_snapshots_must_reconcile_with_day_units_and_inventory(self):
        for modified, message in (
            (["3", "10", "33", "1", "32"], "simulation day"),
            (["2", "10", "33", "1", "33"], "circulation"),
            (["2", "10", "33", "1"], "Missing numeric value"),
            (["2", "15", "33", "1", "32"], "split factor"),
        ):
            with self.subTest(modified=modified):
                sheets = fixture()
                sheets["流通量"] = [data.SUPPLY_HEADERS, ["1", "10", "30", "0", "30"], modified]
                with self.assertRaisesRegex(data.DataError, message):
                    data.parse_data(sheets)
        sheets["流通量"][2] = ["2", "20", "33", "1", "32"]
        sheets["每日K线"][2][8] += "\n05:00 拆分　每 1 YDA 拆为 10 YDA"
        with self.assertRaisesRegex(data.DataError, "Total mismatch for split factor"):
            data.parse_data(sheets)

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

    def test_large_turnover_reconciles_to_the_last_decimal_place(self):
        sheets = fixture()
        first, second, total = sheets["每日K线"][1:4]
        first[2], first[6] = "9", "132771827458707114450131.766833"
        second[2], second[6:9] = "1", ["0.000001", "1", "实际成交"]
        total[6:8] = ["132771827458707114450131.766834", "3"]
        data.parse_data(sheets)

        total[6] = "132771827458707114450131.766833"
        with self.assertRaisesRegex(data.DataError, "Total mismatch for daily turnover"):
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
        for source in data.discover_workbooks(data.WORKBOOKS):
            with self.subTest(source=source.relative_to(data.WORKBOOKS).as_posix()):
                sheets = data.read_sheets(source)
                result = data.build(source)
                source_dates = [row[0] for row in sheets["每日K线"] if data.DATE_PATTERN.fullmatch(row[0])]
                self.assertEqual([row["dateLabel"] for row in result["daily"]], source_dates)
                self.assertEqual(result["daily"][0]["close"], Decimal(sheets["每日K线"][1][1]))
                self.assertEqual(result["daily"][-1]["day"], len(source_dates))
                self.assertEqual(len(result["meta"]["sourceSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
