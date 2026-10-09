#!/usr/bin/env python3
"""Prepare a same-origin updater manifest from signed GitHub release assets."""
import argparse
import json
import pathlib
import re
import shutil
from urllib.parse import quote, urlparse

parser = argparse.ArgumentParser()
parser.add_argument("--release-dir", type=pathlib.Path, required=True)
parser.add_argument("--output-dir", type=pathlib.Path, required=True)
parser.add_argument("--base-url", required=True)
args = parser.parse_args()
base = args.base_url.rstrip("/")
url = urlparse(base)
if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment or url.path:
    parser.error("base-url must be an HTTPS origin without credentials, path or query")
manifest = json.loads((args.release_dir / "latest.json").read_text(encoding="utf-8"))
version = manifest["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
    parser.error("invalid release version")
installers = list(args.release_dir.glob(f"*_{version}_x64-setup.exe"))
if len(installers) != 1:
    parser.error("exactly one signed NSIS x64 installer is required")
installer = installers[0]
signature = installer.with_name(installer.name + ".sig").read_text(encoding="utf-8").strip()
if not signature:
    parser.error("missing installer signature")
destination = args.output_dir / "assets" / version
destination.mkdir(parents=True, exist_ok=True)
for asset in (installer, installer.with_name(installer.name + ".sig")):
    target = destination / asset.name
    if asset.resolve() != target.resolve():
        shutil.copy2(asset, target)
manifest["platforms"] = {"windows-x86_64": {
    "signature": signature,
    "url": f"{base}/updates/assets/{quote(version)}/{quote(installer.name)}",
}}
args.output_dir.mkdir(parents=True, exist_ok=True)
temporary = args.output_dir / "latest.json.tmp"
temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
temporary.replace(args.output_dir / "latest.json")
print(f"Prepared signed Windows update {version}")
