from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from bizhub.manage import backup


def test_online_backup_is_verified_and_readable(client, tmp_path: Path):
    output = tmp_path / "backups" / "test.sqlite"
    result = backup(output)
    assert result["status"] == "created"
    assert output.stat().st_mode & 0o777 == 0o600
    connection = sqlite3.connect(output)
    try:
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT username FROM admin_users WHERE id=1").fetchone()[0] == "admin"
    finally:
        connection.close()


def test_csv_rejects_wrong_header_and_negative_quantity(api):
    wrong = api(
        "post", "/api/imports/csv/preview",
        json={"resource": "unit", "source_id": "sheet", "csv_text": "code,display_name\npcs,Pieces\n"},
    )
    assert wrong.status_code == 409
    negative = api(
        "post", "/api/imports/json/preview",
        json={
            "resource": "opening_inventory",
            "source_id": "sheet",
            "records": [{
                "external_id": "opening-1", "product_id": 1, "unit_id": 1, "location_id": 1,
                "quantity_delta": "-2", "business_date": "2026-08-15", "note": "invalid opening",
            }],
        },
    )
    assert negative.status_code == 409
