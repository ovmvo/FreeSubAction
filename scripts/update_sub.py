#!/usr/bin/env python3
import argparse
import json
import os
import random
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path


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


def download_with_retries(url: str, max_attempts: int) -> bytes | None:
    """下载数据，返回原始字节"""
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
            if data:
                return data
        except Exception:
            pass

        if attempt < max_attempts:
            print("Retrying in 3 seconds...")
            time.sleep(3)

    return None


def post_multipart(
    url: str,
    fields: dict[str, str],
    file_field: str,
    file_name: str,
    file_data: bytes,
    file_content_type: str = "application/octet-stream",
    timeout: int = 30,
) -> bytes:
    boundary = f"----SubShareAction{uuid.uuid4().hex}"
    body = bytearray()

    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")

    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_name}"\r\n'.encode("utf-8")
    )
    body.extend(f"Content-Type: {file_content_type}\r\n\r\n".encode("utf-8"))
    body.extend(file_data)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    request = urllib.request.Request(
        url=url,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def upload_to_telegram(
    bot_token: str,
    chat_id: str,
    file_name: str,
    file_data: bytes,
    caption: str,
    max_attempts: int,
) -> bool:
    telegram_url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
    fields = {"chat_id": chat_id}
    if caption:
        fields["caption"] = caption

    for attempt in range(1, max_attempts + 1):
        try:
            response_data = post_multipart(
                url=telegram_url,
                fields=fields,
                file_field="document",
                file_name=file_name,
                file_data=file_data,
                file_content_type="application/x-yaml",
            )
            payload = json.loads(response_data.decode("utf-8", errors="replace"))
            if payload.get("ok"):
                return True
            print(
                f"Telegram API returned error: {payload.get('description', 'unknown error')}",
                file=sys.stderr,
            )
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            print(f"Telegram upload HTTP {exc.code}: {response_body}", file=sys.stderr)
        except Exception as exc:
            print(f"Telegram upload attempt {attempt} failed: {exc}", file=sys.stderr)

        if attempt < max_attempts:
            print("Retrying Telegram upload in 3 seconds...")
            time.sleep(3)

    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch YAML content with retries and write to sub/ based on UTC hour policy")
    parser.add_argument("--source-url", required=True, help="Source URL (secret injected via env)")
    parser.add_argument("--max-attempts", type=int, default=3, help="Max retry attempts (default: 3)")
    parser.add_argument(
        "--tg-bot-token",
        default=os.getenv("TG_BOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN", ""),
        help="Telegram bot token (required for upload, can use TG_BOT_TOKEN env)",
    )
    parser.add_argument(
        "--tg-chat-id",
        default=os.getenv("TG_CHAT_ID") or os.getenv("TG_CHANNEL_ID") or os.getenv("TELEGRAM_CHAT_ID", ""),
        help="Telegram chat/channel ID (required for upload, can use TG_CHAT_ID env)",
    )
    parser.add_argument(
        "--tg-caption",
        default=os.getenv("TG_CAPTION", ""),
        help="Telegram caption for uploaded file (optional, default uses node count)",
    )
    args = parser.parse_args()

    now = datetime.now()
    hour = now.hour
    base = Path("sub")
    latest_dir = base / "latest"
    permanent_dir = base / "permanent"
    update_permanent = (hour % 8 == 0)

    # 模板文件路径
    script_dir = Path(__file__).parent
    template_path = script_dir.parent / "templates" / "mihomo.yaml"
    
    if not template_path.exists():
        print(f"Template file not found: {template_path}", file=sys.stderr)
        return 1

    # 准备最新文件路径（清理与写入在获取数据后执行）
    latest_file = latest_dir / f"{random.randint(10_000_000, 99_999_999)}.yaml"

    # 首先获取数据
    downloaded_data = download_with_retries(args.source_url, args.max_attempts)
    if not downloaded_data:
        print(f"Failed to download data after {args.max_attempts} attempts. Exiting without update.", file=sys.stderr)
        return 1
    node_count = max(len(downloaded_data.splitlines()) - 1, 0)

    # 将下载的数据追加到模板末尾
    template_content = template_path.read_bytes()
    merged_data = template_content.rstrip() + b"\n\n" + downloaded_data

    # 写入最新文件（先清理 latest 目录，再写入）
    clean_directory(latest_dir)
    latest_dir.mkdir(parents=True, exist_ok=True)
    latest_file.write_bytes(merged_data)

    # 写入 latest 后调用 Telegram Bot 上传到频道
    if not args.tg_bot_token or not args.tg_chat_id:
        print("Telegram upload requires both tg bot token and tg chat id.", file=sys.stderr)
        return 1

    tg_caption = args.tg_caption.strip() or f"节点更新,共 {node_count} 个可用节点"
    uploaded = upload_to_telegram(
        bot_token=args.tg_bot_token,
        chat_id=args.tg_chat_id,
        file_name=latest_file.name,
        file_data=merged_data,
        caption=tg_caption,
        max_attempts=args.max_attempts,
    )
    if not uploaded:
        print("Telegram upload failed after retries.", file=sys.stderr)
        return 1

    # 根据条件写入永久订阅
    if update_permanent:
        clean_directory(permanent_dir)
        permanent_dir.mkdir(parents=True, exist_ok=True)
        permanent_file = permanent_dir / "mihomo.yaml"
        permanent_file.write_bytes(merged_data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
