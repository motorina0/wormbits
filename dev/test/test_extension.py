import json
from pathlib import Path

from wasmtime import Config, Engine, component

from lnbits.core.wasm_ext.wasm.config import parse_wasm_extension_config

EXTENSION_ROOT = Path(__file__).resolve().parents[2]


def test_phase_one_manifest_is_permission_free_and_loadable() -> None:
    manifest = json.loads((EXTENSION_ROOT / "config.json").read_text(encoding="utf-8"))

    config = parse_wasm_extension_config("wormbits", manifest)

    assert config.name == "Worm Bits"
    assert config.extension_type == "wasm"
    assert config.permissions == []
    assert config.api_routes == []
    assert config.wasm.exports == []
    assert config.ui_routes[0].path == "/wormbits"
    assert config.ui_routes[0].auth == "user"


def test_phase_one_component_and_ui_assets_are_valid() -> None:
    manifest = json.loads((EXTENSION_ROOT / "config.json").read_text(encoding="utf-8"))
    module_path = EXTENSION_ROOT / manifest["wasm"]["module"]
    entrypoint = EXTENSION_ROOT / manifest["ui_routes"][0]["entrypoint"]

    wasmtime_config = Config()
    wasmtime_config.wasm_component_model = True
    component.Component.from_file(Engine(wasmtime_config), str(module_path))

    assert entrypoint.is_file()
    assert (EXTENSION_ROOT / "static" / "game.js").is_file()
    assert (EXTENSION_ROOT / "static" / "game.bundle.js").is_file()
    assert (EXTENSION_ROOT / "static" / "simulation.js").is_file()
    assert (EXTENSION_ROOT / "static" / "assets" / "icon.png").is_file()
