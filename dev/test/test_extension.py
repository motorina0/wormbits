import json
from pathlib import Path

from wasmtime import Config, Engine, component

from lnbits.core.wasm_ext.wasm.config import parse_wasm_extension_config

EXTENSION_ROOT = Path(__file__).resolve().parents[2]


def test_multiplayer_manifest_exposes_scoped_routes_and_permissions() -> None:
    manifest = json.loads((EXTENSION_ROOT / "config.json").read_text(encoding="utf-8"))

    config = parse_wasm_extension_config("wormbits", manifest)

    assert config.name == "Worm Bits"
    assert config.extension_type == "wasm"
    assert {permission.id for permission in config.permissions} == {
        "ext.storage.read",
        "ext.storage.read_public",
        "ext.storage.write",
        "wallet.list",
        "wallet.create_invoice_public",
        "wallet.pay_invoice",
        "wallet.pay_invoice_background",
        "websocket.publish",
        "websocket.subscribe",
    }
    assert len(config.api_routes) == 11
    assert len(config.wasm.exports) == 12
    assert config.events.on_invoice_paid == "record-wormbits-payment"
    assert config.wasm.world == "wormbits"
    assert config.ui_routes[0].path == "/wormbits"
    assert config.ui_routes[0].auth == "user"
    assert config.ui_routes[1].path == "/wormbits/rooms/{room_id}"
    assert config.ui_routes[1].auth == "public"


def test_multiplayer_component_storage_and_ui_assets_are_valid() -> None:
    manifest = json.loads((EXTENSION_ROOT / "config.json").read_text(encoding="utf-8"))
    module_path = EXTENSION_ROOT / manifest["wasm"]["module"]
    entrypoint = EXTENSION_ROOT / manifest["ui_routes"][0]["entrypoint"]

    wasmtime_config = Config()
    wasmtime_config.wasm_component_model = True
    component.Component.from_file(Engine(wasmtime_config), str(module_path))

    assert entrypoint.is_file()
    assert (EXTENSION_ROOT / "static" / "game.js").is_file()
    assert (EXTENSION_ROOT / "static" / "game.bundle.js").is_file()
    assert (EXTENSION_ROOT / "static" / "lnbits-extension-sdk.js").is_file()
    assert (EXTENSION_ROOT / "static" / "simulation.js").is_file()
    assert (EXTENSION_ROOT / "static" / "assets" / "icon.png").is_file()
    assert (EXTENSION_ROOT / "storage" / "schema.json").is_file()
    assert (EXTENSION_ROOT / "storage" / "migrations" / "0001_initial.json").is_file()
    assert (EXTENSION_ROOT / "storage" / "migrations" / "0002_payments.json").is_file()
