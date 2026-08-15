from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExternalIdentity(StrictModel):
    source_id: str | None = Field(default=None, min_length=1, max_length=80)
    external_id: str | None = Field(default=None, min_length=1, max_length=160)

    @model_validator(mode="after")
    def both_or_neither(self) -> "ExternalIdentity":
        if bool(self.source_id) != bool(self.external_id):
            raise ValueError("source_id and external_id must be provided together")
        return self


class CreateParty(ExternalIdentity):
    canonical_name: str = Field(min_length=1, max_length=200)
    legal_name: str = Field(default="", max_length=240)
    roles: list[Literal["customer", "supplier"]] = Field(min_length=1, max_length=2)

    @field_validator("roles")
    @classmethod
    def unique_roles(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("roles must be unique")
        return value


class CreateProduct(ExternalIdentity):
    canonical_name: str = Field(min_length=1, max_length=160)
    sku: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    unit_id: int = Field(gt=0)

    @field_validator("sku")
    @classmethod
    def normalize_sku(cls, value: str) -> str:
        return value.strip().upper()


class CreateUnit(ExternalIdentity):
    code: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    display_name: str = Field(min_length=1, max_length=60)
    dimension: Literal["count", "weight", "volume", "length", "area", "package", "other"]

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().lower()


class CreateLocation(ExternalIdentity):
    code: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class OrderLine(StrictModel):
    product_id: int = Field(gt=0)
    unit_id: int = Field(gt=0)
    quantity: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    unit_price: Decimal | None = Field(default=None, ge=0, max_digits=24, decimal_places=8)


class CreateSalesOrder(ExternalIdentity):
    order_no: str = Field(min_length=1, max_length=80)
    customer_id: int = Field(gt=0)
    order_date: date
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    note: str = Field(default="", max_length=1000)
    lines: list[OrderLine] = Field(min_length=1, max_length=500)


class CreatePurchaseOrder(ExternalIdentity):
    order_no: str = Field(min_length=1, max_length=80)
    supplier_id: int = Field(gt=0)
    order_date: date
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    note: str = Field(default="", max_length=1000)
    lines: list[OrderLine] = Field(min_length=1, max_length=500)


class FulfillmentLine(StrictModel):
    line_id: int = Field(gt=0)
    quantity: Decimal = Field(gt=0, max_digits=24, decimal_places=8)


class ReceivePurchase(ExternalIdentity):
    order_id: int = Field(gt=0)
    location_id: int = Field(gt=0)
    business_date: date
    lines: list[FulfillmentLine] = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=1000)


class ShipSale(ExternalIdentity):
    order_id: int = Field(gt=0)
    location_id: int = Field(gt=0)
    business_date: date
    lines: list[FulfillmentLine] = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=1000)


class PostInventoryAdjustment(ExternalIdentity):
    product_id: int = Field(gt=0)
    unit_id: int = Field(gt=0)
    location_id: int = Field(gt=0)
    quantity_delta: Decimal = Field(max_digits=24, decimal_places=8)
    business_date: date
    opening: bool = False
    note: str = Field(min_length=3, max_length=1000)

    @field_validator("quantity_delta")
    @classmethod
    def non_zero(cls, value: Decimal) -> Decimal:
        if value == 0:
            raise ValueError("quantity_delta must not be zero")
        return value


class ReverseMovement(ExternalIdentity):
    movement_id: int = Field(gt=0)
    business_date: date
    note: str = Field(min_length=3, max_length=1000)


class CancelOrder(ExternalIdentity):
    order_type: Literal["sale", "purchase"]
    order_id: int = Field(gt=0)
    note: str = Field(min_length=3, max_length=1000)


ActionName = Literal[
    "create_party",
    "create_product",
    "create_unit",
    "create_location",
    "create_sales_order",
    "create_purchase_order",
    "receive_purchase",
    "ship_sale",
    "post_inventory_adjustment",
    "reverse_movement",
    "cancel_order",
]


ACTION_MODELS: dict[str, type[StrictModel]] = {
    "create_party": CreateParty,
    "create_product": CreateProduct,
    "create_unit": CreateUnit,
    "create_location": CreateLocation,
    "create_sales_order": CreateSalesOrder,
    "create_purchase_order": CreatePurchaseOrder,
    "receive_purchase": ReceivePurchase,
    "ship_sale": ShipSale,
    "post_inventory_adjustment": PostInventoryAdjustment,
    "reverse_movement": ReverseMovement,
    "cancel_order": CancelOrder,
}


class ActionPreviewRequest(StrictModel):
    action: ActionName
    data: dict


class ActionApplyRequest(ActionPreviewRequest):
    preview_token: str = Field(min_length=70, max_length=4096)
    review_note: str = Field(min_length=3, max_length=1000)


ImportResource = Literal[
    "party",
    "product",
    "unit",
    "location",
    "opening_inventory",
    "sales_order",
    "purchase_order",
]


class ImportPreviewRequest(StrictModel):
    resource: ImportResource
    source_id: str = Field(min_length=1, max_length=80)
    records: list[dict] = Field(min_length=1, max_length=5000)


class ImportApplyRequest(ImportPreviewRequest):
    preview_token: str = Field(min_length=70, max_length=8192)
    review_note: str = Field(min_length=3, max_length=1000)


class CsvImportPreviewRequest(StrictModel):
    resource: ImportResource
    source_id: str = Field(min_length=1, max_length=80)
    csv_text: str = Field(min_length=1, max_length=10_000_000)
