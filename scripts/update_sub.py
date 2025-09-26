#!/usr/bin/env python3
import argparse
import random
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import yaml  # type: ignore
except Exception as e:
    print("PyYAML is required but not installed. Please install PyYAML.", file=sys.stderr)
    sys.exit(2)


def clean_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for entry in path.iterdir():
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink(missing_ok=True)
        except Exception:
            shutil.rmtree(entry, ignore_errors=True)


def download_yaml_with_retries(url: str, max_attempts: int) -> bytes | None:
    import urllib.request
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
        except Exception:
            data = b""

        if data:
            try:
                yaml.safe_load(data)
                return data
            except Exception as e:
                print(f"YAML parse failed: {e}")

        if attempt < max_attempts:
            print("Retrying in 3 seconds...")
            time.sleep(3)

    return None



def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch YAML content with retries and write to sub/ based on UTC hour policy")
    parser.add_argument("--source-url", required=True, help="Source URL (secret injected via env)")
    parser.add_argument("--max-attempts", type=int, default=3, help="Max retry attempts (default: 3)")
    args = parser.parse_args()

    now = datetime.now()
    hour = now.hour
    base = Path("sub")
    latest_dir = base / "latest"
    permanent_dir = base / "permanent"
    update_permanent = (hour % 8 == 0)

    # 准备最新文件路径（清理与写入在获取数据后执行）
    latest_file = latest_dir / f"{random.randint(10_000_000, 99_999_999)}.yaml"

    # 首先获取数据
    data = download_yaml_with_retries(args.source_url, args.max_attempts)
    if not data:
        print(f"Failed to obtain valid YAML after {args.max_attempts} attempts. Exiting without update.", file=sys.stderr)
        return 1

    # 写入最新文件（先清理 latest 目录，再写入）
    clean_directory(latest_dir)
    latest_dir.mkdir(parents=True, exist_ok=True)
    latest_file.write_bytes(data)

    # 根据条件写入永久订阅
    if update_permanent:
        clean_directory(permanent_dir)
        permanent_dir.mkdir(parents=True, exist_ok=True)
        permanent_file = permanent_dir / "mihomo.yaml"
        permanent_file.write_bytes(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
