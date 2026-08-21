from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .config import company_profile_digest, database_path


SCHEMA_VERSION = 2
BASELINE_VERSION = 1


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    profile_digest TEXT NOT NULL,
    state_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bizhub_migration_ledger (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_login_failures (
    failure_key TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL,
    window_started INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    legal_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS party_roles (
    party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL CHECK (role_key IN ('customer', 'supplier')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (party_id, role_key)
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    sku TEXT NOT NULL UNIQUE,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    dimension TEXT NOT NULL CHECK (dimension IN ('count','weight','volume','length','area','package','other')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    order_date TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','partially_fulfilled','fulfilled','cancelled')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
    line_no INTEGER NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    quantity TEXT NOT NULL,
    unit_price TEXT,
    UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    supplier_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    order_date TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','partially_fulfilled','fulfilled','cancelled')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    line_no INTEGER NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    quantity TEXT NOT NULL,
    unit_price TEXT,
    UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movement_kind TEXT NOT NULL CHECK (movement_kind IN ('opening','receipt','shipment','adjustment','reversal')),
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    quantity_delta TEXT NOT NULL,
    business_date TEXT NOT NULL,
    order_type TEXT CHECK (order_type IN ('sale','purchase') OR order_type IS NULL),
    order_line_id INTEGER,
    reverses_movement_id INTEGER UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_fulfillments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type TEXT NOT NULL CHECK (order_type IN ('sale','purchase')),
    order_line_id INTEGER NOT NULL,
    movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
    quantity TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_ref TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL,
    review_note TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sales_lines_order ON sales_order_lines(order_id);
CREATE INDEX IF NOT EXISTS ix_purchase_lines_order ON purchase_order_lines(order_id);
CREATE INDEX IF NOT EXISTS ix_movements_stock ON inventory_movements(product_id, unit_id, location_id);
CREATE INDEX IF NOT EXISTS ix_fulfillments_line ON order_fulfillments(order_type, order_line_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_events(created_at, id);

CREATE TRIGGER IF NOT EXISTS immutable_inventory_movements_update
BEFORE UPDATE ON inventory_movements BEGIN SELECT RAISE(ABORT, 'inventory movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_inventory_movements_delete
BEFORE DELETE ON inventory_movements BEGIN SELECT RAISE(ABORT, 'inventory movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_order_fulfillments_update
BEFORE UPDATE ON order_fulfillments BEGIN SELECT RAISE(ABORT, 'order fulfillments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_order_fulfillments_delete
BEFORE DELETE ON order_fulfillments BEGIN SELECT RAISE(ABORT, 'order fulfillments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_audit_events_update
BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_audit_events_delete
BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
"""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]

    @property
    def checksum(self) -> str:
        payload = "\n-- statement --\n".join(statement.strip() for statement in self.statements)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


BASELINE_CHECKSUM = hashlib.sha256(b"bizhub.schema.v1").hexdigest()
MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        version=2,
        name="master_data_aliases_and_external_record_updates",
        statements=(
            """
            CREATE TABLE party_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                normalized_alias TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (party_id, normalized_alias)
            )
            """,
            """
            CREATE UNIQUE INDEX ux_party_aliases_active_name
            ON party_aliases(normalized_alias) WHERE status='active'
            """,
            """
            CREATE TABLE unit_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                normalized_alias TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (unit_id, normalized_alias)
            )
            """,
            """
            CREATE UNIQUE INDEX ux_unit_aliases_active_name
            ON unit_aliases(normalized_alias) WHERE status='active'
            """,
            "ALTER TABLE external_records ADD COLUMN updated_at TEXT",
        ),
    ),
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _configure(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise RuntimeError("SQLite foreign key enforcement is unavailable")


def open_database(path: Path | None = None) -> sqlite3.Connection:
    target = (path or database_path()).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=30, isolation_level=None)
    _configure(conn)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def database(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = open_database(path)
    try:
        yield conn
    finally:
        conn.close()


def initialize_database(path: Path | None = None) -> None:
    digest = company_profile_digest()
    with database(path) as conn:
        conn.executescript(SCHEMA_SQL)
        row = conn.execute("SELECT * FROM app_state WHERE id=1").fetchone()
        now = utc_now()
        if row is None:
            conn.execute(
                "INSERT INTO app_state(id,schema_version,profile_digest,state_version,created_at,updated_at) VALUES(1,?,?,?,?,?)",
                (BASELINE_VERSION, digest, 0, now, now),
            )
            row = conn.execute("SELECT * FROM app_state WHERE id=1").fetchone()
        elif int(row["schema_version"]) < BASELINE_VERSION or int(row["schema_version"]) > SCHEMA_VERSION:
            raise RuntimeError("database schema version is unsupported")
        elif row["profile_digest"] != digest:
            raise RuntimeError("company profile does not match the database binding")
        _apply_migrations(conn, int(row["schema_version"]), now)
        quick = conn.execute("PRAGMA quick_check").fetchone()[0]
        if quick != "ok":
            raise RuntimeError(f"SQLite quick_check failed: {quick}")
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(f"SQLite foreign_key_check failed: {violations[:3]}")


def _apply_migrations(conn: sqlite3.Connection, current_version: int, now: str) -> None:
    baseline = conn.execute(
        "SELECT checksum FROM bizhub_migration_ledger WHERE version=?",
        (BASELINE_VERSION,),
    ).fetchone()
    if baseline is None:
        if current_version != BASELINE_VERSION:
            raise RuntimeError("database migration ledger is incomplete")
        conn.execute(
            "INSERT INTO bizhub_migration_ledger(version,name,checksum,applied_at) VALUES(?,?,?,?)",
            (BASELINE_VERSION, "initial_schema", BASELINE_CHECKSUM, now),
        )
    elif baseline["checksum"] != BASELINE_CHECKSUM:
        raise RuntimeError("database baseline migration checksum has drifted")

    user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if user_version == 0 and current_version == BASELINE_VERSION:
        conn.execute(f"PRAGMA user_version={BASELINE_VERSION}")
        user_version = BASELINE_VERSION
    if user_version != current_version:
        raise RuntimeError("database app_state and PRAGMA user_version disagree")

    for migration in MIGRATIONS:
        existing = conn.execute(
            "SELECT name,checksum FROM bizhub_migration_ledger WHERE version=?",
            (migration.version,),
        ).fetchone()
        if migration.version <= current_version:
            if existing is None or existing["name"] != migration.name or existing["checksum"] != migration.checksum:
                raise RuntimeError(f"database migration {migration.version} ledger has drifted")
            continue
        if migration.version != current_version + 1:
            raise RuntimeError("database migrations are not contiguous")
        try:
            conn.execute("BEGIN IMMEDIATE")
            for statement in migration.statements:
                conn.execute(statement)
            applied_at = utc_now()
            conn.execute(
                "INSERT INTO bizhub_migration_ledger(version,name,checksum,applied_at) VALUES(?,?,?,?)",
                (migration.version, migration.name, migration.checksum, applied_at),
            )
            conn.execute(
                "UPDATE app_state SET schema_version=?,updated_at=? WHERE id=1",
                (migration.version, applied_at),
            )
            conn.execute(f"PRAGMA user_version={migration.version}")
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        current_version = migration.version

    if current_version != SCHEMA_VERSION:
        raise RuntimeError("database schema migration did not reach the supported version")


def state_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT state_version FROM app_state WHERE id=1").fetchone()
    if row is None:
        raise RuntimeError("database is not initialized")
    return int(row[0])


def bump_state_version(conn: sqlite3.Connection) -> int:
    now = utc_now()
    conn.execute(
        "UPDATE app_state SET state_version=state_version+1, updated_at=? WHERE id=1",
        (now,),
    )
    return state_version(conn)
