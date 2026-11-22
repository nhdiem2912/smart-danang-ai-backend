import json
import math
import sys
from pathlib import Path

from sqlalchemy import select

from database import (
    CATEGORIES,
    Category,
    Poi,
    SessionLocal,
    init_db,
    normalize_search,
    now_iso,
)


def validate(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError(
            "JSON phải là danh sách địa điểm không rỗng."
        )

    seen = set()

    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(
                f"Dòng {index} không phải object."
            )

        identity = row.get("id")

        if (
            not isinstance(identity, str)
            or not identity.strip()
            or identity in seen
        ):
            raise ValueError(
                f"Dòng {index}: ID thiếu hoặc trùng."
            )

        seen.add(identity)

        if (
            not isinstance(row.get("name"), str)
            or not row["name"].strip()
        ):
            raise ValueError(
                f"{identity}: thiếu tên."
            )

        if row.get("category") not in CATEGORIES:
            raise ValueError(
                f"{identity}: danh mục không hợp lệ."
            )

        for field, maximum in [
            ("latitude", 90),
            ("longitude", 180),
        ]:
            value = row.get(field)

            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or abs(value) > maximum
            ):
                raise ValueError(
                    f"{identity}: {field} không hợp lệ."
                )

        for field in [
            "coordinates_valid",
            "legacy_only",
        ]:
            if type(row.get(field)) is not bool:
                raise ValueError(
                    f"{identity}: {field} phải là true/false."
                )

    return rows


def import_places(path):
    text = Path(path).read_text(
        encoding="utf-8-sig",
    )

    rows = validate(json.loads(text))

    init_db()

    counts = {
        "inserted": 0,
        "updated": 0,
        "unchanged": 0,
    }

    with SessionLocal.begin() as session:
        for identity, name in CATEGORIES.items():
            session.merge(
                Category(
                    id=identity,
                    name=name,
                )
            )

        session.flush()

        existing = {
            poi.id: poi
            for poi in session.scalars(
                select(Poi)
            )
        }

        for row in rows:
            poi = existing.get(row["id"])

            if (
                poi is not None
                and poi.payload == row
            ):
                counts["unchanged"] += 1
                continue

            if poi is None:
                poi = Poi(id=row["id"])

                session.add(poi)

                counts["inserted"] += 1
            else:
                counts["updated"] += 1

            poi.name = row["name"]
            poi.category = row["category"]

            poi.search_text = normalize_search(
                row.get("search_text")
                or (
                    f'{row["name"]} '
                    f'{row.get("address") or ""}'
                )
            )

            poi.latitude = row["latitude"]
            poi.longitude = row["longitude"]

            poi.coordinates_valid = (
                row["coordinates_valid"]
            )

            poi.legacy_only = row["legacy_only"]
            poi.payload = row
            poi.updated_at = now_iso()

    return counts


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(
            "Cách chạy: python seed.py "
            "DUONG_DAN_PLACES_JSON"
        )

    try:
        result = import_places(sys.argv[1])

        print(
            json.dumps(
                result,
                ensure_ascii=False,
            )
        )
    except (ValueError, OSError) as exc:
        raise SystemExit(
            f"Không nhập dữ liệu: {exc}"
        ) from exc