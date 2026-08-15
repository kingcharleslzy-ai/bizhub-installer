from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class CompanyProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = Field(default=1, ge=1, le=1)
    profile_id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=64)
    legal_name: str = Field(min_length=1, max_length=160)
    display_name: str = Field(min_length=1, max_length=80)
    brand_mark: str = Field(min_length=1, max_length=6)
    timezone: str = Field(min_length=1, max_length=80)
    currency: str = Field(pattern=r"^[A-Z]{3}$")

    @field_validator("legal_name", "display_name", "brand_mark", "timezone")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_timezone(self) -> "CompanyProfile":
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return self

    def public_payload(self) -> dict[str, object]:
        return self.model_dump()


def _path_from_env(name: str, default: str) -> Path:
    return Path(os.getenv(name, default)).expanduser().resolve()


@lru_cache(maxsize=1)
def company_profile() -> CompanyProfile:
    path = _path_from_env("BIZHUB_COMPANY_CONFIG", "/config/company.json")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"company config is unavailable or invalid: {path}") from exc
    return CompanyProfile.model_validate(payload)


def company_profile_digest(profile: CompanyProfile | None = None) -> str:
    source = (profile or company_profile()).model_dump(mode="json")
    canonical = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def database_path() -> Path:
    return _path_from_env("BIZHUB_DATABASE_PATH", "/data/bizhub.db")


def secret_key() -> bytes:
    path = _path_from_env("BIZHUB_SECRET_KEY_FILE", "/config/secret-key")
    try:
        value = path.read_bytes().strip()
    except OSError as exc:
        raise RuntimeError(f"secret key is unavailable: {path}") from exc
    if len(value) < 32:
        raise RuntimeError("secret key must contain at least 32 bytes")
    return value


def cookie_secure() -> bool:
    return os.getenv("BIZHUB_COOKIE_SECURE", "1").strip().lower() not in {"0", "false", "no"}


def static_dir() -> Path:
    return _path_from_env("BIZHUB_STATIC_DIR", str(Path(__file__).with_name("static")))
