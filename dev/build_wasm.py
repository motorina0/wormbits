from pathlib import Path

from wasmtime import wat2wasm

EXTENSION_ROOT = Path(__file__).resolve().parents[1]
SOURCE = EXTENSION_ROOT / "wasm" / "module.wat"
OUTPUT = EXTENSION_ROOT / "wasm" / "module.wasm"


def main() -> None:
    OUTPUT.write_bytes(wat2wasm(SOURCE.read_text(encoding="utf-8")))
    print(f"Built {OUTPUT.relative_to(EXTENSION_ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
