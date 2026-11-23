#!/usr/bin/env python3
"""Validate workbooks/ and build a chart catalog, using only Python's stdlib.

The workbook remains the source of truth. Decimal arithmetic validates quantities
before conversion to JavaScript-compatible JSON numbers for chart rendering.
Simulation dates are labels; they must never be converted to real-world dates.
"""

from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import sys
import tempfile
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[1]
WORKBOOKS = ROOT / "workbooks"
DEFAULT_INPUT = WORKBOOKS / "YDA价格汇总与每日行情.xlsx"
DEFAULT_OUTPUT = ROOT / "data" / "market.json"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DATE_PATTERN = re.compile(r"第(\d+)年\s+(\d{1,2})月(\d{1,2})日")
PRICE_HEADERS = ["价格HK/YDA", "发行量（已挂）YDA", "价格新高发行YDA", "成交量新高发行YDA", "成交量YDA"]
DAILY_HEADERS = ["模拟日期（UTC）", "价格（收盘）HK/YDA", "成交量YDA", "开盘价HK/YDA", "最高价HK/YDA", "最低价HK/YDA", "成交额HK", "成交笔数", "状态"]
PRICE_SCHEMAS = {
    "发行量（已挂）YDA": {
        "totalLabel": "已挂 / 成交合计",
        "basis": "actual-order-price",
        "description": "发行量按实际挂单价归集（含预挂），实际成交量按真实成交价统计。",
    },
    "发行量（整批）YDA": {
        "totalLabel": "发行 / 成交合计",
        "basis": "batch-primary-price",
        "description": "整批发行量归入主发行价（含预挂及待挂），实际成交量按真实成交价统计。",
    },
}


class DataError(ValueError):
    """An input is missing, ambiguous, or inconsistent with its source totals."""


def column_index(reference: str) -> int:
    match = re.fullmatch(r"([A-Z]+)[1-9]\d*", reference)
    if not match:
        raise DataError(f"Invalid cell reference: {reference}")
    value = 0
    for letter in match[1]:
        value = value * 26 + ord(letter) - ord("A") + 1
    return value - 1


def cell_text(cell: ET.Element, shared_strings: list[str]) -> str:
    kind = cell.get("t")
    if kind == "e":
        raise DataError(f"Excel error at {cell.get('r')}")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.findall("s:is//s:t", NS))
    value = cell.find("s:v", NS)
    if value is None or value.text is None:
        if cell.find("s:f", NS) is not None:
            raise DataError(f"Formula has no cached value at {cell.get('r')}; save a recalculated workbook first")
        return ""
    if kind == "s":
        try:
            return shared_strings[int(value.text)]
        except (ValueError, IndexError) as error:
            raise DataError(f"Invalid shared string at {cell.get('r')}") from error
    return value.text


def read_sheets(source: Path) -> dict[str, list[list[str]]]:
    with ZipFile(source) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.findall(".//s:t", NS)) for item in strings]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships.findall(f"{{{PACKAGE_REL_NS}}}Relationship") if item.get("TargetMode") != "External"}
        result = {}
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            name = sheet.attrib["name"]
            if name not in ("价格发行与成交", "每日K线"):
                continue
            target = targets[sheet.attrib[f"{{{REL_NS}}}id"]]
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            xml = ET.fromstring(archive.read(path))
            rows = []
            for row in xml.findall("s:sheetData/s:row", NS):
                values = {}
                for cell in row.findall("s:c", NS):
                    values[column_index(cell.attrib["r"])] = cell_text(cell, shared).strip()
                if not any(values.values()):
                    continue
                rows.append([values.get(index, "") for index in range(max(values, default=-1) + 1)])
            result[name] = rows
        return result


def number(value: str, label: str, *, positive: bool = False) -> Decimal:
    if not value:
        raise DataError(f"Missing numeric value: {label}")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise DataError(f"Invalid numeric value at {label}: {value!r}") from error
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise DataError(f"Expected {'positive' if positive else 'nonnegative'} finite value at {label}")
    return result


def require_headers(rows: list[list[str]], expected: list[str], sheet: str) -> None:
    actual = [re.sub(r"\s+", "", value) for value in rows[0]] if rows else []
    if actual != expected:
        raise DataError(f"Unexpected column headers in {sheet}: {actual}")


def sum_check(actual: Decimal, expected: Decimal, label: str) -> None:
    # All quantity cells and their source totals retain eight decimals. Check
    # exactly, instead of hiding a missing row inside a floating-point tolerance.
    if actual != expected:
        raise DataError(f"Total mismatch for {label}: calculated {actual}, workbook {expected}")


def parse_data(sheets: dict[str, list[list[str]]]) -> dict:
    try:
        price_rows, daily_rows = sheets["价格发行与成交"], sheets["每日K线"]
    except KeyError as error:
        raise DataError(f"Required worksheet missing: {error.args[0]}") from error
    normalized_price_headers = [re.sub(r"\s+", "", value) for value in price_rows[0]] if price_rows else []
    schema = PRICE_SCHEMAS.get(normalized_price_headers[1]) if len(normalized_price_headers) > 1 else None
    if schema is None:
        raise DataError(f"Unexpected column headers in 价格发行与成交: {normalized_price_headers}")
    expected_price_headers = PRICE_HEADERS.copy()
    expected_price_headers[1] = normalized_price_headers[1]
    require_headers(price_rows, expected_price_headers, "价格发行与成交")
    daily_headers = DAILY_HEADERS.copy()
    history_header = ""
    if daily_rows and len(daily_rows[0]) == len(DAILY_HEADERS) + 1:
        history_header = re.sub(r"\s+", "", daily_rows[0][-1])
        if history_header in ("发行回看天数", "调整系数"):
            daily_headers.append(history_header)
    require_headers(daily_rows, daily_headers, "每日K线")
    price_keys = ["price", "issued", "priceHighIssued", "volumeHighIssued", "volume"]
    prices, daily, price_notes, daily_notes = [], [], [], []
    price_totals, daily_totals = None, None
    for row_number, row in enumerate(price_rows[1:], 2):
        row = row + [""] * (5 - len(row))
        if row[0] in {candidate["totalLabel"] for candidate in PRICE_SCHEMAS.values()}:
            if row[0] != schema["totalLabel"]:
                raise DataError(f"Price total label {row[0]!r} does not match issuance header {normalized_price_headers[1]!r}")
            if price_totals is not None:
                raise DataError("Duplicate price total row")
            price_totals = {key: number(row[index], f"价格发行与成交 row {row_number}") for index, key in enumerate(price_keys) if index}
            continue
        if not any(row[1:]):
            if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", row[0]):
                raise DataError(f"Missing price values at row {row_number}")
            price_notes.append(row[0])
            continue
        point = {key: number(row[index], f"价格发行与成交 row {row_number} {key}", positive=index == 0) for index, key in enumerate(price_keys)}
        if prices and point["price"] <= prices[-1]["price"]:
            raise DataError(f"Duplicate or unordered price at row {row_number}")
        sum_check(point["priceHighIssued"] + point["volumeHighIssued"], point["issued"], f"issued components at price {point['price']}")
        prices.append(point)

    last_date = None
    daily_fields = {"close": 1, "volume": 2, "open": 3, "high": 4, "low": 5, "turnover": 6, "tradeCount": 7}
    for row_number, row in enumerate(daily_rows[1:], 2):
        row = row + [""] * (len(daily_headers) - len(row))
        if row[0] == "全程成交合计":
            if daily_totals is not None:
                raise DataError("Duplicate daily total row")
            daily_totals = {key: number(row[daily_fields[key]], f"每日K线 total {key}") for key in ("volume", "turnover", "tradeCount")}
            continue
        if not any(row[1:]):
            if DATE_PATTERN.fullmatch(row[0]):
                raise DataError(f"Missing daily values at row {row_number}")
            daily_notes.append(row[0])
            continue
        match = DATE_PATTERN.fullmatch(row[0])
        if not match:
            raise DataError(f"Invalid simulation date at row {row_number}: {row[0]!r}")
        year, month, day_of_month = map(int, match.groups())
        month_days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        if year < 1 or not 1 <= month <= 12 or not 1 <= day_of_month <= month_days[month - 1]:
            raise DataError(f"Invalid simulation date: {row[0]}")
        current_date = year, month, day_of_month
        if last_date is not None and current_date <= last_date:
            raise DataError(f"Duplicate or unordered simulation date: {row[0]}")
        if last_date is not None:
            previous_year, previous_month, previous_day = last_date
            if previous_day < month_days[previous_month - 1]:
                next_dates = {(previous_year, previous_month, previous_day + 1)}
            elif previous_month == 12:
                next_dates = {(previous_year + 1, 1, 1)}
            else:
                next_dates = {(previous_year, previous_month + 1, 1)}
            # A simulation year is not a Gregorian year. Both February endings
            # are valid; every other missing day is detectable without inventing
            # an absolute calendar year, including zero-volume days totals miss.
            if previous_month == 2 and previous_day == 28:
                next_dates.add((previous_year, 3, 1))
            if current_date not in next_dates:
                raise DataError(f"Missing simulation day before {row[0]}")
        last_date = current_date
        point = {key: number(row[index], f"每日K线 row {row_number} {key}", positive=key in ("open", "high", "low", "close")) for key, index in daily_fields.items()}
        if not point["low"] <= min(point["open"], point["close"]) <= max(point["open"], point["close"]) <= point["high"]:
            raise DataError(f"Invalid OHLC bounds at {row[0]}")
        if point["tradeCount"] != point["tradeCount"].to_integral_value():
            raise DataError(f"Non-integer trade count at {row[0]}")
        point["tradeCount"] = int(point["tradeCount"])
        if not row[8]:
            raise DataError(f"Missing daily status at {row[0]}")
        if point["volume"] == 0:
            if point["turnover"] != 0 or point["tradeCount"] != 0:
                raise DataError(f"Zero volume with nonzero turnover/trades at {row[0]}")
            prior_close = daily[-1]["close"] if daily else point["open"]
            if any(point[key] != prior_close for key in ("open", "high", "low", "close")):
                raise DataError(f"No-trade day does not carry previous close at {row[0]}")
        point.update(day=len(daily) + 1, year=year, month=month, dayOfMonth=day_of_month, dateLabel=row[0], status=row[8])
        if history_header:
            is_window = history_header == "发行回看天数"
            for index, token in enumerate(row[9].split("→"), 1):
                label = f"每日K线 {row[0]} {history_header}（第{index}项）"
                value = number(token.strip(), label, positive=is_window)
                if is_window and value != value.to_integral_value():
                    raise DataError(f"Expected whole days at {label}")
            key = "issueWindowDays" if is_window else "adjustmentCoefficient"
            point[key] = row[9]
        daily.append(point)

    if not prices or not daily or price_totals is None or daily_totals is None:
        raise DataError("Both worksheets require data rows and their labeled total rows")
    for key, total in price_totals.items():
        sum_check(sum(point[key] for point in prices), total, f"price {key}")
    for key, total in daily_totals.items():
        sum_check(sum(point[key] for point in daily), total, f"daily {key}")
    sum_check(price_totals["volume"], daily_totals["volume"], "volume across worksheets")
    return {
        "meta": {
            "sheetNames": ["价格发行与成交", "每日K线"],
            "priceUnit": "HK", "volumeUnit": "YDA", "turnoverUnit": "HK",
            "issuanceBasis": schema["basis"], "issuanceDescription": schema["description"],
            "isSimulation": True, "calendar": "simulation-year", "timezone": "UTC",
            "priceCount": len(prices), "dayCount": len(daily),
            "firstDate": daily[0]["dateLabel"], "lastDate": daily[-1]["dateLabel"],
            "sourceNotes": {"prices": price_notes, "daily": daily_notes},
        },
        "prices": prices,
        "daily": daily,
    }


def build(source: Path) -> dict:
    payload = parse_data(read_sheets(source))
    payload["meta"].update(sourceFile=source.name, sourceSha256=file_sha256(source))
    return payload


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: dict) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
                  default=lambda value: float(value) if isinstance(value, Decimal) else value)
        stream.write("\n")


def natural_path_key(path: str) -> tuple:
    # Numeric segments compare as numbers; the exact path breaks case/zero ties.
    parts = tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                  for part in re.split(r"(\d+)", path))
    return parts, path


def discover_workbooks(directory: Path) -> list[Path]:
    """Only visit the explicit public-source directory; never follow symlinks."""
    if directory.is_symlink():
        raise DataError(f"Workbook directory cannot be a symlink: {directory}")
    found = []
    def fail(error):
        raise error
    for parent, directories, names in os.walk(directory, followlinks=False, onerror=fail):
        directories[:] = [name for name in directories if not name.startswith((".", "~$"))
                          and not (Path(parent) / name).is_symlink()]
        for name in names:
            path = Path(parent) / name
            if (not name.startswith((".", "~$")) and path.suffix.lower() == ".xlsx"
                    and not path.is_symlink() and path.is_file()):
                found.append(path)
    found.sort(key=lambda path: natural_path_key(path.relative_to(directory).as_posix()))
    if not found:
        raise DataError(f"No .xlsx workbooks found in {directory}")
    return found


def dataset_id(relative_path: Path) -> str:
    return "w-" + hashlib.sha256(relative_path.as_posix().encode("utf-8")).hexdigest()[:16]


def workbook_description(source: Path, directory: Path) -> tuple[str | None, str | None]:
    description = source.with_suffix(".md")
    if description.is_symlink():
        raise DataError(f"Cannot read description {directory.name}/{description.relative_to(directory).as_posix()}: symlinks are not supported")
    try:
        return description.read_text(encoding="utf-8-sig"), description.name
    except FileNotFoundError:
        return None, None
    except (OSError, UnicodeError) as error:
        raise DataError(f"Cannot read description {directory.name}/{description.relative_to(directory).as_posix()}: {error}") from error


def remove_generated_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def publish_catalog(staging: Path, output: Path) -> None:
    """Install only our three generated artifacts, restoring all on a failed swap."""
    existed = output.exists()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-backup-", dir=output.parent) as temporary:
        backup = Path(temporary)
        changed = []
        try:
            # Install the catalog last so its entries only name complete files.
            for name in ("datasets", "market.json", "catalog.json"):
                target = output / name
                previous = backup / name if target.exists() or target.is_symlink() else None
                if previous is not None:
                    os.replace(target, previous)
                changed.append((target, previous))
                os.replace(staging / name, target)
        except OSError:
            for target, previous in reversed(changed):
                remove_generated_path(target)
                if previous is not None:
                    os.replace(previous, target)
            if not existed:
                output.rmdir()
            raise


def build_catalog(directory: Path = WORKBOOKS, output: Path = ROOT / "data") -> dict:
    """Stage each validated workbook separately before publishing the complete set."""
    sources = discover_workbooks(directory)
    preferred = directory / DEFAULT_INPUT.name
    default_source = preferred if preferred in sources else sources[0]
    default_id = dataset_id(default_source.relative_to(directory))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-build-", dir=output.parent) as temporary:
        staging = Path(temporary)
        (staging / "datasets").mkdir()
        entries, identities = [], set()
        for source in sources:
            relative = source.relative_to(directory)
            identity = dataset_id(relative)
            source_path = "workbooks/" + relative.as_posix()
            if identity in identities:
                raise DataError(f"Dataset ID collision for {source_path}")
            identities.add(identity)
            try:
                payload = build(source)
                description, description_file = workbook_description(source, directory)
                payload["meta"].update(descriptionMarkdown=description, descriptionFile=description_file)
                data_file = f"datasets/{identity}.json"
                destination = staging / data_file
                write_json(destination, payload)
                meta = payload["meta"]
                entries.append({
                    "id": identity, "title": source.stem, "sourceFile": source.name,
                    "sourcePath": source_path, "dataFile": data_file,
                    "sourceSha256": meta["sourceSha256"], "dataSha256": file_sha256(destination),
                    **{key: meta[key] for key in ("dayCount", "priceCount", "firstDate", "lastDate")},
                })
                # Keep only the small catalog entries while validating the next file.
                del payload, meta
            except (DataError, OSError, BadZipFile, KeyError, ET.ParseError, ValueError) as error:
                raise DataError(f"Workbook {source_path}: {error}") from error
        catalog = {"version": 1, "defaultId": default_id, "datasets": entries}
        shutil.copyfile(staging / f"datasets/{default_id}.json", staging / "market.json")
        write_json(staging / "catalog.json", catalog)
        publish_catalog(staging, output)
    return catalog


def build_single(source: Path, output: Path) -> dict:
    payload = build(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-build-", dir=output.parent) as temporary:
        staging = Path(temporary) / output.name
        write_json(staging, payload)
        os.replace(staging, output)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Explicit single-workbook mode: source .xlsx")
    parser.add_argument("--output", type=Path, help="Explicit single-workbook mode: output JSON path")
    args = parser.parse_args()
    try:
        if args.input is not None or args.output is not None:
            source, destination = args.input or DEFAULT_INPUT, args.output or DEFAULT_OUTPUT
            payload = build_single(source, destination)
            print(f"Validated and exported {len(payload['prices'])} prices and {len(payload['daily'])} days to {destination}")
        else:
            catalog = build_catalog()
            print(f"Validated and exported {len(catalog['datasets'])} workbooks to {ROOT / 'data' / 'catalog.json'}")
    except (DataError, OSError, BadZipFile, KeyError, ET.ParseError, ValueError) as error:
        source_note = f" ({args.input or DEFAULT_INPUT})" if args.input is not None or args.output is not None else ""
        print(f"Data export failed{source_note}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
