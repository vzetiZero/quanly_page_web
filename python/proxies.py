"""Bể proxy cho các request tải YouTube bằng yt-dlp.

Danh sách proxy nằm trong ``data/proxies.txt`` (mỗi dòng một proxy), cấu hình
bật/tắt nằm trong ``data/proxies.json`` do giao diện web ghi. Mỗi lần tải sẽ lấy
proxy kế tiếp trong danh sách; proxy bị YouTube chặn hoặc không kết nối được sẽ
tạm nghỉ để vòng luân phiên bỏ qua.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("NEWS247_DATA_DIR") or (ROOT_DIR / "data"))
LIST_PATH = DATA_DIR / "proxies.txt"
SETTINGS_PATH = DATA_DIR / "proxies.json"

DEFAULT_COOLDOWN = 1800
NETWORK_COOLDOWN = 300
MAX_ATTEMPTS = 3
SUPPORTED_SCHEMES = ("http", "https", "socks4", "socks5", "socks5h")

# Lỗi YouTube coi IP là bot / bị chặn tạm thời.
_BLOCK_SIGNALS = (
    "sign in to confirm",
    "confirm you're not a bot",
    "confirm you\u2019re not a bot",
    "not a bot",
    "http error 429",
    "too many requests",
    "unusual traffic",
    "ip address is blocked",
)
# Lỗi kết nối tới proxy: đổi proxy ngay nhưng cho nghỉ ngắn hơn lỗi bị chặn.
_NETWORK_SIGNALS = (
    "proxyerror",
    "proxy error",
    "unable to connect to proxy",
    "tunnel connection failed",
    "connection refused",
    "actively refused",
    "no connection could be made",
    "winerror 10061",
    "connection reset",
    "connection aborted",
    "remote end closed connection",
    "failed to establish a new connection",
    "network is unreachable",
    "timed out",
    "timeout",
    "temporary failure in name resolution",
    "getaddrinfo failed",
)
_CREDENTIALS_RE = re.compile(r"(?i)((?:https?|socks[45]h?)://)[^@\s/]+@")

_lock = threading.Lock()
_cursor = 0
_blocked: dict[str, float] = {}
_proxies: list[dict] = []
_errors: list[dict] = []
_settings = {"enabled": False, "cooldownSeconds": DEFAULT_COOLDOWN}
_list_signature = None
_settings_signature = None


def parse_proxy(line: str) -> tuple[dict | None, str | None]:
    """Đọc một dòng proxy.

    Trả về (proxy, error):
        (None, None) : dòng trống hoặc chú thích -> bỏ qua
        (dict, None) : dòng hợp lệ
        (None, str)  : dòng sai định dạng, kèm lý do
    """
    raw = (line or "").strip().lstrip("\ufeff")
    if not raw or raw.startswith("#") or raw.startswith("//"):
        return None, None

    body = raw
    scheme = "http"
    if "://" in body:
        candidate, remainder = body.split("://", 1)
        candidate = candidate.lower()
        if candidate in SUPPORTED_SCHEMES:
            scheme, body = candidate, remainder
        else:
            body = raw

    username = password = ""
    host_port = None

    if "@" in body:
        credentials, tail = body.rsplit("@", 1)
        tail_parts = tail.split(":")
        if len(tail_parts) == 2 and tail_parts[1].strip().isdigit():
            host_port = tail
            if ":" in credentials:
                username, password = credentials.split(":", 1)
            else:
                username = credentials

    if host_port is not None:
        host, port = host_port.split(":")
    else:
        parts = body.split(":")
        if len(parts) >= 4 and parts[1].strip().isdigit():
            host, port, username, password = (
                parts[0],
                parts[1],
                parts[2],
                ":".join(parts[3:]),
            )
        elif len(parts) >= 2:
            host, port = parts[0], parts[1]
        else:
            return None, "Thiếu cổng (port)"

    host = host.strip()
    port = port.strip()
    if not host:
        return None, "Thiếu địa chỉ IP"
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        return None, f"Cổng không hợp lệ: {port}"

    return {
        "scheme": scheme,
        "host": host,
        "port": int(port),
        "username": username.strip(),
        "password": password,
    }, None


def proxy_url(proxy: dict) -> str:
    """URL đầy đủ để truyền vào option ``proxy`` của yt-dlp."""
    scheme = proxy.get("scheme") or "http"
    username = proxy.get("username") or ""
    password = proxy.get("password") or ""
    auth = ""
    if username:
        auth = f"{quote(str(username), safe='')}:{quote(str(password), safe='')}@"
    return f"{scheme}://{auth}{proxy['host']}:{proxy['port']}"


def redact_credentials(message: str) -> str:
    """Che user/pass trong URL proxy trước khi trả lỗi ra giao diện."""
    return _CREDENTIALS_RE.sub(r"\1***@", message or "")


def error_summary(exc: Exception, limit: int = 500) -> str:
    """Dòng lỗi gọn để hiện trên UI, bỏ traceback và che thông tin proxy."""
    text = redact_credentials(str(exc)).strip()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("ERROR:") or line.startswith("WARNING:"):
            return line[:limit]
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return (first or exc.__class__.__name__)[:limit]


def classify_error(message: str) -> str | None:
    """Phân loại lỗi để quyết định có xoay proxy hay không."""
    lower = (message or "").lower()
    if any(signal in lower for signal in _BLOCK_SIGNALS):
        return "block"
    if any(signal in lower for signal in _NETWORK_SIGNALS):
        return "network"
    return None


def _signature(path: Path):
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _load_settings_locked() -> None:
    global _settings, _settings_signature
    signature = _signature(SETTINGS_PATH)
    if signature == _settings_signature:
        return
    _settings_signature = signature
    settings = {"enabled": False, "cooldownSeconds": DEFAULT_COOLDOWN}
    if signature is not None:
        try:
            stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            stored = {}
        if isinstance(stored, dict):
            settings["enabled"] = bool(stored.get("enabled"))
            try:
                cooldown = int(stored.get("cooldownSeconds") or DEFAULT_COOLDOWN)
            except (TypeError, ValueError):
                cooldown = DEFAULT_COOLDOWN
            settings["cooldownSeconds"] = max(60, min(7200, cooldown))
    _settings = settings


def _load_list_locked() -> None:
    global _proxies, _errors, _cursor, _list_signature
    signature = _signature(LIST_PATH)
    if signature == _list_signature:
        return
    _list_signature = signature
    proxies: list[dict] = []
    errors: list[dict] = []
    if signature is not None:
        try:
            lines = LIST_PATH.read_text(encoding="utf-8-sig").splitlines()
        except OSError:
            lines = []
        for number, line in enumerate(lines, 1):
            proxy, error = parse_proxy(line)
            if proxy is not None:
                proxies.append(proxy)
            elif error is not None:
                errors.append({"line": number, "reason": error})
    _proxies = proxies
    _errors = errors
    _cursor = 0
    _blocked.clear()


def _reload_locked() -> None:
    _load_settings_locked()
    _load_list_locked()


def next_proxy() -> str | None:
    """Proxy kế tiếp chưa tạm nghỉ; None khi proxy đang tắt hoặc danh sách rỗng."""
    global _cursor
    with _lock:
        _reload_locked()
        if not _settings["enabled"] or not _proxies:
            return None
        now = time.monotonic()
        total = len(_proxies)
        for _ in range(total):
            proxy = _proxies[_cursor % total]
            _cursor += 1
            url = proxy_url(proxy)
            if _blocked.get(url, 0.0) <= now:
                return url
        if not _blocked:
            return proxy_url(_proxies[_cursor % total])
        # Tất cả đang tạm nghỉ: mở lại proxy hết hạn sớm nhất để job không kẹt.
        stale = min(_blocked, key=_blocked.get)
        _blocked.pop(stale, None)
        return stale


def mark_blocked(url: str, kind: str = "block") -> None:
    """Cho proxy vừa lỗi tạm nghỉ; lỗi kết nối nghỉ ngắn hơn lỗi bị YouTube chặn."""
    if not url:
        return
    with _lock:
        _reload_locked()
        cooldown = _settings["cooldownSeconds"]
        if kind == "network":
            cooldown = min(NETWORK_COOLDOWN, cooldown)
        _blocked[url] = time.monotonic() + cooldown


def mark_ok(url: str) -> None:
    """Proxy vừa dùng được: bỏ khỏi danh sách tạm nghỉ."""
    if not url:
        return
    with _lock:
        _blocked.pop(url, None)


def blocked_count() -> int:
    with _lock:
        now = time.monotonic()
        for url in [key for key, until in _blocked.items() if until <= now]:
            _blocked.pop(url, None)
        return len(_blocked)


def status() -> dict:
    """Trạng thái cho health/UI; không trả địa chỉ proxy hay mật khẩu."""
    with _lock:
        _reload_locked()
        now = time.monotonic()
        blocked = sum(1 for until in _blocked.values() if until > now)
        return {
            "enabled": _settings["enabled"],
            "count": len(_proxies),
            "blocked": blocked,
            "cooldownSeconds": _settings["cooldownSeconds"],
            "errors": [dict(item) for item in _errors[:20]],
        }


def reset_blocks() -> int:
    """Bỏ toàn bộ tạm nghỉ (dùng khi người dùng muốn thử lại ngay)."""
    with _lock:
        count = len(_blocked)
        _blocked.clear()
    return count


def run_ytdlp(action):
    """Chạy một thao tác yt-dlp với proxy xoay vòng khi bị chặn.

    ``action(proxy_url)`` nhận URL proxy hoặc None. Lỗi bị chặn/kết nối sẽ đánh
    dấu proxy vừa dùng và thử lại bằng proxy kế tiếp, tối đa ``MAX_ATTEMPTS``.
    """
    with _lock:
        _reload_locked()
        has_pool = bool(_settings["enabled"] and _proxies)
        total = len(_proxies)
    attempts = 1 if not has_pool else min(MAX_ATTEMPTS, max(1, total))

    last_error: Exception | None = None
    for _ in range(attempts):
        proxy = next_proxy()
        try:
            result = action(proxy)
        except Exception as exc:  # noqa: BLE001 - phân loại lỗi proxy
            if not proxy:
                raise
            kind = classify_error(str(exc))
            if kind is None:
                raise
            mark_blocked(proxy, kind)
            last_error = exc
            continue
        if proxy:
            mark_ok(proxy)
        return result

    if last_error is not None:
        raise last_error
    raise RuntimeError("Không có proxy khả dụng.")
