#!/usr/bin/env python3
"""Build the My Provider Dash Manager product site into docs/.

The generated pages are committed to docs/ so GitHub Pages can serve them directly.
    python scripts/build_site.py
    python scripts/build_site.py --check       # fail when committed output is stale
    python scripts/build_site.py --og          # rebuild docs/og.png (needs Playwright)

Everything user-facing is derived from the repository: the version comes from package.json,
the 37 services and their colours from src/services.js, the category labels from src/ui.js,
and release notes from docs/CHANGELOG.md. There are no build timestamps, so output is stable.
"""

from __future__ import annotations

import argparse
import functools
import html
import http.server
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
SITE_SOURCE = ROOT / "site"
TEMPLATES = SITE_SOURCE / "templates"
STATIC = SITE_SOURCE / "static"
DOCS = ROOT / "docs"

# The single source of truth for the public site. Canonicals, Open Graph, Twitter cards,
# robots.txt, sitemap.xml and docs/CNAME are all derived from this.
SITE_URL = "https://providers.danubelabs.net"

PRODUCT = "My Provider Dash Manager"
REPO_URL = "https://github.com/FiredMosquito831/my-provider-dash-manager"
RELEASES_URL = f"{REPO_URL}/releases"
LATEST_RELEASE_URL = f"{REPO_URL}/releases/latest"
NPM_URL = "https://www.npmjs.com/package/my-provider-dash-manager"
LICENSE_URL = f"{REPO_URL}/blob/main/LICENSE"
ISSUES_URL = f"{REPO_URL}/issues"
CHANGELOG_URL = f"{REPO_URL}/blob/main/docs/CHANGELOG.md"
DESIGN_URL = f"{REPO_URL}/blob/main/DESIGN.md"
README_URL = f"{REPO_URL}#readme"

SITE_HOST = urlsplit(SITE_URL).netloc


# --------------------------------------------------------------------------- source data


def read_version() -> str:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package["version"])


def parse_services() -> list[dict[str, str]]:
    text = (ROOT / "src" / "services.js").read_text(encoding="utf-8")
    pattern = re.compile(
        r"\{\s*key:\s*'(?P<key>[^']+)',\s*name:\s*'(?P<name>[^']+)',"
        r"\s*category:\s*'(?P<category>[^']+)'.*?color:\s*'(?P<color>#[0-9a-fA-F]{3,8})'"
    )
    services = [match.groupdict() for match in pattern.finditer(text)]
    declared = len(re.findall(r"^\s*\{\s*key:", text, re.M))
    if not services or len(services) != declared:
        raise SystemExit(
            f"Could not read every service from src/services.js ({len(services)} parsed, {declared} declared)"
        )
    return services


def parse_categories() -> list[tuple[str, str]]:
    text = (ROOT / "src" / "ui.js").read_text(encoding="utf-8")
    block = re.search(r"const CATEGORIES = \[(.*?)\];", text, re.S)
    if not block:
        raise SystemExit("Could not read CATEGORIES from src/ui.js")
    categories = re.findall(r"\['([a-z]+)',\s*'([^']+)'\]", block.group(1))
    return [(key, label) for key, label in categories if key != "other"]


def group_services(services: list[dict[str, str]], categories: list[tuple[str, str]]) -> list[dict]:
    groups = []
    for key, label in categories:
        members = [service for service in services if service["category"] == key]
        if members:
            groups.append({"key": key, "label": label, "services": members})
    ungrouped = [s for s in services if s["category"] not in {k for k, _ in categories}]
    if ungrouped:
        groups.append({"key": "other", "label": "Other", "services": ungrouped})
    return groups


def parse_changelog() -> tuple[list[dict], dict]:
    text = (ROOT / "docs" / "CHANGELOG.md").read_text(encoding="utf-8")
    headings = list(re.finditer(r"^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$", text, re.M))
    releases = []
    for index, match in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        releases.append(
            {
                "version": match.group(1),
                "date": match.group(2),
                "body": text[match.end() : end].strip(),
                "url": f"{REPO_URL}/releases/tag/v{match.group(1)}",
            }
        )
    if not releases:
        raise SystemExit("Could not read releases from docs/CHANGELOG.md")
    return releases, releases[0]


def latest_changelog_date() -> str:
    releases, _ = parse_changelog()
    return max(release["date"] for release in releases)


# --------------------------------------------------------------------------- FAQ


FAQ_ITEMS = [
    {
        "q": "Can I be signed into two accounts on the same service at once?",
        "a": "Yes. Each account gets its own Chromium storage partition, so both stay signed in simultaneously and you switch between them like tabs. Nothing is ever signed out to reach the other.",
    },
    {
        "q": "How much memory does an extra account use?",
        "a": "Roughly 125 MB of private memory per live dashboard (the figure Task Manager reports), on a ~350 MB baseline with everything asleep. The app keeps five tabs warm by default and sleeps the rest; slept tabs stay in the strip and resume on click.",
    },
    {
        "q": "Is it safe to store my passwords?",
        "a": "Saved logins are encrypted with Windows DPAPI and bound to the account and the service's own domains. A password typed on an unrelated page reached from a tab is never captured, and a saved password is never filled into a page outside the service's domains. DPAPI protects against another user on the machine, a stolen disk and casual copying; it does not protect against malware running as you, which no desktop app can. Passwords never reach the app's own UI process.",
    },
    {
        "q": "Does it work on macOS or Linux?",
        "a": "Not yet. The app and its installer are Windows-only. The architecture is cross-platform, so other operating systems stay open as future work.",
    },
    {
        "q": "How do I import passwords from Chrome or Edge?",
        "a": "Home → Import from browser reads installed Chromium browsers directly. Chrome 127 and newer lock some entries with app-bound encryption that no other app can read; export those to CSV from the browser and use Import CSV instead. Firefox always uses the CSV path. Re-importing updates passwords you have changed.",
    },
    {
        "q": "Why does SmartScreen warn me?",
        "a": "The installer is not code-signed yet, so Windows shows a warning the first time. Choose More info → Run anyway. Code signing is planned and removes the warning entirely.",
    },
    {
        "q": "Can I add a service that is not on the list?",
        "a": "Yes. Add service by URL gives any site its own rail row and isolated per-account sessions, and JSON plugin manifests can define a service plus how to read its API for status cards.",
    },
    {
        "q": "What happens to my accounts when I update?",
        "a": "Nothing is lost. Accounts, sessions, saved logins and settings live in %APPDATA%\\multi-acc-manager and survive updates and reinstalls. Updates install silently in place and relaunch the app.",
    },
    {
        "q": "Do I need Node.js to use the app?",
        "a": "Not for the app itself. The standalone Windows executable needs nothing else installed. Node.js 18+ is required only for the npx install and update route.",
    },
    {
        "q": "Does it sync between computers?",
        "a": "No. Nothing syncs anywhere: there is no server, no account and no telemetry. Accounts, sessions and saved logins stay on the one Windows machine where you sign in.",
    },
    {
        "q": "Does it support Chrome Web Store extensions?",
        "a": "No. Chrome Web Store extensions cannot run inside Electron. The app ships built-in ad-blocking and Dark Reader's engine for dark mode instead.",
    },
    {
        "q": "Is it free?",
        "a": "The app is free to use, personally and commercially. It is source-available, not open source: the licence permits use, study and verbatim redistribution, but not modified or derivative distribution. See the licence for the full terms.",
    },
    {
        "q": "What about provider terms on multiple accounts?",
        "a": "The app surfaces each provider's stance instead of hiding it. GitHub and Railway allow one account per person and the rail says so — use their organisations and workspaces instead. Other providers treat extra accounts as ordinary, tolerate separate accounts, or expect one per business. Account creation is always manual and guided; nothing is automated.",
    },
]


FAQ_LD = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
        {
            "@type": "Question",
            "name": item["q"],
            "acceptedAnswer": {"@type": "Answer", "text": item["a"]},
        }
        for item in FAQ_ITEMS
    ],
}


# --------------------------------------------------------------------------- page definitions


def page_definitions(version: str, service_count: int) -> list[dict]:
    common_keywords = [
        "multi-account manager",
        "isolated browser sessions",
        "Windows desktop app",
        "account switcher",
        "My Provider Dash Manager",
    ]
    return [
        {
            "slug": "index",
            "filename": "index.html",
            "template": "home.html",
            "nav": "Home",
            "title": "My Provider Dash Manager — every account in one window",
            "description": f"Free Windows desktop app that keeps many accounts per service signed in at once, each in an isolated Chromium session. {service_count} services, ad-blocking, dark mode.",
            "keywords": common_keywords
            + ["multiple accounts Vercel", "multiple Google accounts", "multiple GitHub accounts", "session isolation"],
            "heading": "Every account. One window.",
        },
        {
            "slug": "features",
            "filename": "features.html",
            "template": "features.html",
            "nav": "Features",
            "title": "Features — My Provider Dash Manager",
            "description": "Isolated accounts and sessions, a DPAPI-encrypted password manager, API status cards, silent updates, ad-blocking, dark mode and service plugins.",
            "keywords": common_keywords
            + ["password manager import", "per-account proxy", "ad-blocking", "dark mode", "silent updates", "service plugins"],
            "heading": "Built around identities, not tabs.",
        },
        {
            "slug": "install",
            "filename": "install.html",
            "template": "install.html",
            "nav": "Install",
            "title": "Install on Windows — My Provider Dash Manager",
            "description": "Install My Provider Dash Manager on Windows 10 or 11 with npx my-provider-dash-manager or the GitHub Releases installer. Requirements, updates and CLI.",
            "keywords": common_keywords
            + ["install npx", "Windows installer", "Electron app", "node 18", "GitHub Releases"],
            "heading": "From zero to every account, in one command.",
        },
        {
            "slug": "security",
            "filename": "security.html",
            "template": "security.html",
            "nav": "Security",
            "title": "Security and privacy — My Provider Dash Manager",
            "description": "How session isolation, Windows DPAPI and origin-bound saved logins work — and what they do not protect against. Local-first, no telemetry, no account.",
            "keywords": common_keywords
            + ["DPAPI", "Windows security", "local-first", "no telemetry", "password encryption", "origin-bound credentials"],
            "heading": "Private by architecture, honest about limits.",
        },
        {
            "slug": "faq",
            "filename": "faq.html",
            "template": "faq.html",
            "nav": "FAQ",
            "title": "FAQ — My Provider Dash Manager",
            "description": "Answers about multiple accounts per service, memory use, saved passwords, importing from browsers, SmartScreen, updates and custom services.",
            "keywords": common_keywords
            + ["multi-account FAQ", "Google accounts", "password import", "SmartScreen", "Windows app"],
            "heading": "Questions, answered plainly.",
        },
        {
            "slug": "changelog",
            "filename": "changelog.html",
            "template": "changelog.html",
            "nav": "Changelog",
            "title": "Changelog and links — My Provider Dash Manager",
            "description": "Release notes and links for My Provider Dash Manager, generated from the repository changelog, with every documented version and the current download.",
            "keywords": common_keywords + ["changelog", "release notes", "npm package", "source available"],
            "heading": "What changed, and where to find it.",
        },
        {
            "slug": "404",
            "filename": "404.html",
            "template": "404.html",
            "nav": "",
            "title": "Page not found — My Provider Dash Manager",
            "description": "The page you requested is not in this account. Links to the product site, features, install guide, security and FAQ.",
            "keywords": common_keywords + ["page not found"],
            "heading": "This account is not open.",
        },
    ]


# --------------------------------------------------------------------------- templating helpers


def inline_markdown(text: str) -> str:
    text = html.escape(text.strip(), quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


def release_body_html(body: str) -> str:
    """Render the small subset of Markdown used by CHANGELOG.md."""
    output: list[str] = []
    paragraph: list[str] = []
    items: list[str] = []
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            output.append("<ul>" + "".join(f"<li>{inline_markdown(item)}</li>" for item in items) + "</ul>")
            items.clear()
            in_list = False

    def close_paragraph() -> None:
        if paragraph:
            output.append("<p>" + inline_markdown(" ".join(paragraph)) + "</p>")
            paragraph.clear()

    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if not line:
            close_list()
            close_paragraph()
            continue
        if line.startswith("### "):
            close_list()
            close_paragraph()
            output.append(f"<h3>{inline_markdown(line[4:])}</h3>")
            continue
        if line.startswith("- "):
            close_paragraph()
            if not in_list:
                in_list = True
            items.append(line[2:])
            continue
        if line.startswith("  ") and in_list and items:
            items[-1] += " " + line.strip()
            continue
        close_list()
        paragraph.append(line.strip())

    close_list()
    close_paragraph()
    return "\n".join(output)


def make_environment() -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)),
        autoescape=select_autoescape(("html", "xml")),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["inline_md"] = inline_markdown
    return env


def software_jsonld(version: str, service_count: int) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": PRODUCT,
        "alternateName": "mpdm",
        "url": SITE_URL + "/",
        "description": "A free Windows desktop app that keeps many accounts per cloud and web service signed in at the same time, each in its own fully isolated Chromium session, switchable like browser tabs but built around accounts instead of pages.",
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "Multi-account manager",
        "operatingSystem": "Windows 10, Windows 11",
        "softwareVersion": version,
        "downloadUrl": LATEST_RELEASE_URL,
        "installUrl": LATEST_RELEASE_URL,
        "codeRepository": REPO_URL,
        "isAccessibleForFree": True,
        "license": LICENSE_URL,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "featureList": [
            "Fully isolated persistent Chromium session per account",
            f"{service_count} services built in, plus any site by URL",
            "One window with a left account rail and per-account tabs on top",
            "Built-in ad-blocking driven by EasyList",
            "Dark mode powered by Dark Reader",
            "Saved logins encrypted with Windows DPAPI and origin-bound",
            "Import passwords from Chrome, Edge, Brave, Vivaldi, Opera or CSV",
            "Choose which login autofills per account",
            "Optional read-only API tokens for live status cards",
            "Per-account proxy support",
            "Silent in-place auto-updates from GitHub Releases",
        ],
        "screenshot": [
            {
                "@type": "ImageObject",
                "url": f"{SITE_URL}/screenshots/home.png",
                "caption": "Home with the account rail and one card per account",
            },
            {
                "@type": "ImageObject",
                "url": f"{SITE_URL}/screenshots/services.png",
                "caption": "The service picker grouped by category, the Updates panel and saved logins",
            },
            {
                "@type": "ImageObject",
                "url": f"{SITE_URL}/screenshots/navigation.png",
                "caption": "An account tab open with back, forward, reload, dashboard and the address bar",
            },
        ],
    }


def breadcrumb_jsonld(page: dict) -> dict:
    elements = [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE_URL + "/"},
    ]
    if page["slug"] != "index":
        elements.append(
            {
                "@type": "ListItem",
                "position": 2,
                "name": page["nav"] or page["heading"],
                "item": f"{SITE_URL}/{page['filename']}",
            }
        )
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": elements}


def canonical_for(page: dict) -> str:
    if page["slug"] == "index":
        return SITE_URL + "/"
    return f"{SITE_URL}/{page['filename']}"


def page_context(page: dict, pages: list[dict], version: str, releases: list[dict], service_count: int) -> dict:
    jsonld: list[dict] = [software_jsonld(version, service_count)]
    if page["slug"] != "404":
        jsonld.append(breadcrumb_jsonld(page))
    if page["slug"] == "faq":
        jsonld.append(FAQ_LD)

    return {
        "page": {
            **page,
            "canonical": canonical_for(page),
            "og_image": f"{SITE_URL}/og.png",
        },
        "pages": pages,
        "site_url": SITE_URL,
        "site_host": SITE_HOST,
        "product": PRODUCT,
        "version": version,
        "repo_url": REPO_URL,
        "releases_url": RELEASES_URL,
        "latest_release_url": LATEST_RELEASE_URL,
        "npm_url": NPM_URL,
        "license_url": LICENSE_URL,
        "issues_url": ISSUES_URL,
        "changelog_url": CHANGELOG_URL,
        "design_url": DESIGN_URL,
        "readme_url": README_URL,
        "faq": FAQ_ITEMS,
        "releases": releases,
        "jsonld": json.dumps(jsonld, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"),
    }


# --------------------------------------------------------------------------- output


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    return struct.unpack(">II", data[16:24])


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


TEXT_OUTPUT_SUFFIXES = {".html", ".xml", ".txt", ".css", ".js", ".svg"}
TEXT_OUTPUT_NAMES = {"CNAME", ".nojekyll"}


def comparable_output(path: Path, data: bytes) -> bytes:
    """Normalise line endings for text output so a Windows CRLF checkout still passes --check."""
    is_text = path.suffix in TEXT_OUTPUT_SUFFIXES or path.name in TEXT_OUTPUT_NAMES
    return data.replace(b"\r\n", b"\n") if is_text else data


def copy_static(out_dir: Path) -> list[str]:
    generated = []
    for source in sorted(STATIC.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(STATIC).as_posix()
        destination = out_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        generated.append(relative)
    return generated


def build(out_dir: Path, version: str, services: list[dict], groups: list[dict], releases: list[dict]) -> list[str]:
    env = make_environment()
    pages = page_definitions(version, len(services))
    generated: list[str] = []

    out_dir.mkdir(parents=True, exist_ok=True)
    generated.extend(copy_static(out_dir))

    latest = releases[0]
    common = {
        "services": services,
        "service_count": len(services),
        "service_groups": groups,
        "latest_release": latest,
        "latest_release_html": release_body_html(latest["body"]),
        "release_date": latest["date"],
    }

    for page in pages:
        context = page_context(page, pages, version, releases, len(services))
        context.update(common)
        rendered = env.get_template(page["template"]).render(**context)
        write_text(out_dir / page["filename"], rendered)
        generated.append(page["filename"])

    # GitHub Pages configuration and discovery files.
    write_text(out_dir / "CNAME", SITE_HOST + "\n")
    generated.append("CNAME")
    write_text(out_dir / ".nojekyll", "")
    generated.append(".nojekyll")

    write_text(
        out_dir / "robots.txt",
        "User-agent: *\nAllow: /\n\nSitemap: " + SITE_URL + "/sitemap.xml\n",
    )
    generated.append("robots.txt")

    sitemap_pages = [page for page in pages if page["slug"] != "404"]
    lastmod = latest_changelog_date()
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for page in sitemap_pages:
        priority = "1.0" if page["slug"] == "index" else "0.8" if page["slug"] in {"features", "install"} else "0.6"
        sitemap.extend(
            [
                "  <url>",
                f"    <loc>{html.escape(canonical_for(page), quote=True)}</loc>",
                f"    <lastmod>{lastmod}</lastmod>",
                "    <changefreq>monthly</changefreq>",
                f"    <priority>{priority}</priority>",
                "  </url>",
            ]
        )
    sitemap.append("</urlset>")
    write_text(out_dir / "sitemap.xml", "\n".join(sitemap) + "\n")
    generated.append("sitemap.xml")

    return sorted(set(generated))


# --------------------------------------------------------------------------- Open Graph image


def generate_og(destination: Path, version: str, service_count: int) -> None:
    """Render site/templates/og.html through a local HTTP server and screenshot it at 1200x630."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise SystemExit(
            "Open Graph generation needs Playwright: python -m pip install playwright && "
            "python -m playwright install chromium"
        ) from error

    env = make_environment()
    markup = env.get_template("og.html").render(
        product=PRODUCT,
        version=version,
        service_count=service_count,
        site_host=SITE_HOST,
    )
    fd, tmp_name = tempfile.mkstemp(prefix=".og-preview-", suffix=".html", dir=ROOT)
    os.close(fd)
    tmp = Path(tmp_name)
    tmp.write_text(markup, encoding="utf-8", newline="\n")

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:  # noqa: A002 - stdlib signature
            pass

    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/{tmp.name}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
            page.goto(url, wait_until="networkidle")
            page.wait_for_function(
                "() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)"
            )
            page.screenshot(path=str(destination), full_page=False)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        tmp.unlink(missing_ok=True)

    width, height = png_size(destination)
    if (width, height) != (1200, 630):
        raise SystemExit(f"Open Graph image is {width}x{height}; expected 1200x630")


# --------------------------------------------------------------------------- validation / check


def validate_html(out_dir: Path, pages: list[dict]) -> list[str]:
    """Check internal links and required SEO tags in a freshly built tree."""
    from html.parser import HTMLParser

    errors: list[str] = []
    all_files = {path.relative_to(out_dir).as_posix() for path in out_dir.rglob("*") if path.is_file()}

    class LinkParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.targets: list[str] = []

        def handle_starttag(self, tag: str, attrs) -> None:
            for name, value in attrs:
                if name in {"href", "src"} and value:
                    self.targets.append(value)

    for page in pages:
        path = out_dir / page["filename"]
        markup = path.read_text(encoding="utf-8")
        for required in (
            "<title>",
            'name="description"',
            'rel="canonical"',
            'property="og:image"',
            'name="twitter:card"',
            'type="application/ld+json"',
        ):
            if required not in markup:
                errors.append(f"{page['filename']}: missing {required}")
        for placeholder in ("Lorem ipsum", "REPLACE_ME", "{{", "{%"):
            if placeholder in markup:
                errors.append(f"{page['filename']}: leftover placeholder {placeholder!r}")

        parser = LinkParser()
        parser.feed(markup)
        for target in parser.targets:
            if target.startswith(("http://", "https://", "mailto:", "#", "data:")):
                continue
            clean = target.split("#", 1)[0].split("?", 1)[0]
            if not clean:
                continue
            if clean.startswith("/"):
                relative = clean.lstrip("/")
            else:
                relative = (path.parent.relative_to(out_dir) / clean).as_posix()
            normalized = Path(relative).as_posix()
            if normalized.startswith("../"):
                errors.append(f"{page['filename']}: link escapes site root: {target}")
            elif normalized not in all_files:
                errors.append(f"{page['filename']}: broken internal link {target}")

    return errors


def check_output(version: str, services: list[dict], groups: list[dict], releases: list[dict]) -> int:
    pages = page_definitions(version, len(services))
    with tempfile.TemporaryDirectory(prefix="mpdm-site-check-") as temp:
        temp_dir = Path(temp)
        generated = build(temp_dir, version, services, groups, releases)
        stale = []
        for relative in generated:
            built = temp_dir / relative
            committed = DOCS / relative
            if not committed.exists() or comparable_output(committed, committed.read_bytes()) != comparable_output(built, built.read_bytes()):
                stale.append(relative)
        # Screenshots are real app captures, not generated output. Copy them into the temporary
        # tree so the link checker can resolve the page references.
        for screenshot in (DOCS / "screenshots").glob("*.png"):
            destination = temp_dir / "screenshots" / screenshot.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(screenshot, destination)
        html_errors = validate_html(temp_dir, pages)
    errors = [f"stale or missing: docs/{path}" for path in stale]
    errors.extend(html_errors)

    for screenshot in ("home.png", "services.png", "navigation.png"):
        path = DOCS / "screenshots" / screenshot
        if not path.exists():
            errors.append(f"missing screenshot: docs/screenshots/{screenshot}")

    og = DOCS / "og.png"
    if not og.exists():
        errors.append("missing: docs/og.png (run python scripts/build_site.py --og)")
    else:
        try:
            if png_size(og) != (1200, 630):
                errors.append(f"docs/og.png is {png_size(og)[0]}x{png_size(og)[1]}; expected 1200x630")
        except ValueError as error:
            errors.append(str(error))

    if errors:
        print("Site check failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"Site output is up to date ({len(pages)} pages, {len(services)} services, v{version}).")
    return 0


# --------------------------------------------------------------------------- CLI


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the My Provider Dash Manager product site.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="build to a temporary directory and fail if docs/ is stale or assets are missing",
    )
    parser.add_argument(
        "--og",
        action="store_true",
        help="also rebuild docs/og.png from the local Open Graph HTML mock (requires Playwright)",
    )
    args = parser.parse_args()

    version = read_version()
    services = parse_services()
    categories = parse_categories()
    groups = group_services(services, categories)
    releases, latest = parse_changelog()

    if args.check:
        if args.og:
            parser.error("--check does not write files; run --og separately")
        return check_output(version, services, groups, releases)

    DOCS.mkdir(parents=True, exist_ok=True)
    generated = build(DOCS, version, services, groups, releases)
    if args.og:
        generate_og(DOCS / "og.png", version, len(services))
        generated.append("og.png")

    errors = validate_html(DOCS, page_definitions(version, len(services)))
    if errors:
        print("Built site has errors:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"Built {len(generated)} files into docs/ — {len(services)} services, v{version}, latest release {latest['version']} ({latest['date']}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
