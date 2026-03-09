#!/usr/bin/env python3
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from string import Template


MARK_START = "<!-- START: AUTO-UPDATED LINKS -->"
MARK_END = "<!-- END: AUTO-UPDATED LINKS -->"

# 中国时区 (UTC+8)
CHINA_TZ = timezone(timedelta(hours=8))


def china_now_str() -> str:
    """Return current time string in China timezone for display."""
    return datetime.now(CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S CST")


def get_repo_context() -> tuple[str, str, str]:
    """Read owner/repo and branch from env, with strict validation."""
    repo = os.environ.get("TARGET_REPOSITORY")
    branch = os.environ.get("TARGET_BRANCH")
    if not repo or not branch:
        print("Environment variables TARGET_REPOSITORY and TARGET_BRANCH are required.", file=sys.stderr)
        sys.exit(2)
    if "/" not in repo:
        print("TARGET_REPOSITORY must be in 'owner/repo' format.", file=sys.stderr)
        sys.exit(2)
    owner, name = repo.split("/", 1)
    return owner, name, branch


def latest_sub_file(subdir: Path) -> Path | None:
    """Return the single file in latest dir (directory is cleaned per update)."""
    if not subdir.exists():
        return None
    for p in subdir.iterdir():
        if p.is_file():
            return p
    return None


def file_mtime(path: Path) -> datetime | None:
    """Return file modification time in China timezone."""
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=CHINA_TZ)
    except Exception:
        return None


def format_time(dt: datetime | None) -> str:
    """Format optional datetime to string or N/A."""
    return dt.strftime("%Y-%m-%d %H:%M:%S CST") if dt else "N/A"


def build_context(owner: str, repo: str, branch: str, root: Path) -> dict[str, str]:
    """Compute links and times for template substitution."""
    latest_dir = root / "sub/latest"
    latest_file = latest_sub_file(latest_dir)
    permanent_file = root / "sub/permanent/mihomo.yaml"
    raw_base = f"https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}"
    latest_link = f"{raw_base}/sub/latest/{latest_file.name}" if latest_file else "N/A"
    permanent_link = f"{raw_base}/sub/permanent/mihomo.yaml"

    latest_time = format_time(file_mtime(latest_file) if latest_file else None)
    permanent_time = format_time(file_mtime(permanent_file) if permanent_file.exists() else None)

    return {
        "permanent_link": permanent_link,
        "latest_link": latest_link,
        "permanent_time": permanent_time,
        "latest_time": latest_time,
        "generated_at": china_now_str(),
    }


def render_template(context: dict[str, str]) -> str:
    """Render README section from string.Template file with provided context."""
    template_path = Path(__file__).resolve().parents[1] / "templates" / "readme_section.tmpl"
    tmpl = Template(template_path.read_text(encoding="utf-8"))
    return tmpl.substitute(**context)


def update_readme(readme: Path, section: str) -> None:
    """Replace or append the auto-updated section in README."""
    text = readme.read_text(encoding="utf-8", errors="ignore") if readme.exists() else ""
    block = f"{MARK_START}\n\n{section}\n\n{MARK_END}"
    if MARK_START in text and MARK_END in text:
        pattern = re.compile(rf"{re.escape(MARK_START)}.*?{re.escape(MARK_END)}", re.S)
        new_text = pattern.sub(block, text)
    else:
        new_text = text.rstrip() + ("\n\n" if text.strip() else "") + block + "\n"
    readme.write_text(new_text, encoding="utf-8")


def main() -> int:
    """Compute context, render template, and write section into README."""
    root = Path.cwd()
    owner, repo, branch = get_repo_context()
    context = build_context(owner, repo, branch, root)
    section = render_template(context)
    update_readme(root / "README.md", section)
    print("README.md updated with subscription links and times.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
