"""Facebook Graph API client for Page Reels + Page discovery."""

from __future__ import annotations

import os
import time
from typing import Any, Callable

import httpx

DEFAULT_VERSION = "v25.0"
REQUIRED_PERMISSIONS = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
]


class FacebookError(Exception):
    """Raised when Graph API rejects a request or the token is unusable."""


class FacebookCancelled(Exception):
    """Raised when the user cancels an upload."""


def _base(version: str | None) -> str:
    version = (version or DEFAULT_VERSION).strip() or DEFAULT_VERSION
    return f"https://graph.facebook.com/{version}"


def _error_detail(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return response.text[:400]
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        message = error.get("message") or str(error)
        code = error.get("code")
        subcode = error.get("error_subcode")
        extra = []
        if code:
            extra.append(f"code={code}")
        if subcode:
            extra.append(f"subcode={subcode}")
        return f"{message} ({', '.join(extra)})" if extra else str(message)
    if isinstance(data, dict) and data.get("message"):
        return str(data["message"])
    return str(data)[:400]


def _raise_for_graph(response: httpx.Response, action: str) -> dict:
    if response.status_code < 400:
        try:
            data = response.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    detail = _error_detail(response)
    if response.status_code in (401, 403):
        raise FacebookError(
            f"{action}: token bị từ chối hoặc thiếu quyền (HTTP {response.status_code}). "
            f"Cần pages_show_list, pages_read_engagement, pages_manage_posts. Chi tiết: {detail}"
        )
    if response.status_code == 429:
        raise FacebookError(f"{action}: Facebook giới hạn tần suất. Thử lại sau. Chi tiết: {detail}")
    raise FacebookError(f"{action}: HTTP {response.status_code} — {detail}")


def validate_token(access_token: str, version: str | None = None) -> dict:
    token = (access_token or "").strip()
    if not token:
        raise FacebookError("Chưa nhập Facebook user access token.")

    with httpx.Client(timeout=30) as client:
        me = _raise_for_graph(
            client.get(
                f"{_base(version)}/me",
                params={"access_token": token, "fields": "id,name"},
            ),
            "Kiểm tra token",
        )
        perms = _raise_for_graph(
            client.get(
                f"{_base(version)}/me/permissions",
                params={"access_token": token},
            ),
            "Kiểm tra quyền",
        )

    granted = sorted(
        {
            item.get("permission")
            for item in perms.get("data", [])
            if isinstance(item, dict)
            and item.get("status") == "granted"
            and item.get("permission")
        }
    )
    missing = [perm for perm in REQUIRED_PERMISSIONS if perm not in granted]
    return {
        "ok": True,
        "user": {"id": me.get("id"), "name": me.get("name")},
        "granted": granted,
        "missing": missing,
    }


def _fetch_pages_edge(
    client: httpx.Client,
    url: str,
    token: str,
    *,
    fields: str,
    limit: int = 100,
) -> list[dict]:
    items: list[dict] = []
    params: dict[str, Any] = {"access_token": token, "fields": fields, "limit": limit}
    next_url: str | None = url
    for _ in range(20):
        if not next_url:
            break
        response = client.get(next_url, params=params)
        data = _raise_for_graph(response, "Tải danh sách Page")
        items.extend(item for item in data.get("data", []) if isinstance(item, dict))
        next_url = (data.get("paging") or {}).get("next")
        params = {}
    return items


def fetch_pages(access_token: str, version: str | None = None) -> list[dict]:
    token = (access_token or "").strip()
    if not token:
        raise FacebookError("Chưa nhập Facebook user access token.")

    fields = "id,name,access_token,tasks,category"
    pages: dict[str, dict] = {}

    with httpx.Client(timeout=45) as client:
        for page in _fetch_pages_edge(
            client, f"{_base(version)}/me/accounts", token, fields=fields
        ):
            page_id = str(page.get("id") or "")
            if not page_id or not page.get("access_token"):
                continue
            pages[page_id] = {
                "id": page_id,
                "name": page.get("name") or page_id,
                "accessToken": page.get("access_token") or "",
                "tasks": page.get("tasks") or [],
                "category": page.get("category") or "",
            }

        try:
            businesses = _fetch_pages_edge(
                client,
                f"{_base(version)}/me/businesses",
                token,
                fields="id,name",
                limit=50,
            )
        except FacebookError:
            businesses = []

        for business in businesses:
            business_id = str(business.get("id") or "")
            if not business_id:
                continue
            for edge in ("owned_pages", "client_pages"):
                try:
                    items = _fetch_pages_edge(
                        client,
                        f"{_base(version)}/{business_id}/{edge}",
                        token,
                        fields=fields,
                    )
                except FacebookError:
                    continue
                for page in items:
                    page_id = str(page.get("id") or "")
                    if not page_id or not page.get("access_token"):
                        continue
                    pages.setdefault(
                        page_id,
                        {
                            "id": page_id,
                            "name": page.get("name") or page_id,
                            "accessToken": page.get("access_token") or "",
                            "tasks": page.get("tasks") or [],
                            "category": page.get("category") or "",
                        },
                    )

    return sorted(pages.values(), key=lambda item: item["name"].lower())


def _normalize_hashtags(value: str) -> str:
    tokens: list[str] = []
    for raw in (value or "").replace("\n", " ").split():
        token = raw.strip().lstrip("#")
        token = "".join(ch for ch in token if ch.isalnum() or ch == "_")
        if token and token not in tokens:
            tokens.append(token)
    return " ".join(f"#{token}" for token in tokens)


def build_caption(title: str, description: str, hashtags: str = "") -> str:
    tags = _normalize_hashtags(hashtags)
    headline = (title or "").strip()
    if tags:
        headline = f"{headline} {tags}".strip()
    body = (description or "").strip()
    if headline and body:
        return f"{headline}\n\n{body}"
    return headline or body


def upload_reel(
    page: dict,
    video_path: str,
    caption: str,
    *,
    version: str | None = None,
    poll_timeout: int = 240,
    on_stage: Callable[[str], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> dict:
    """Publish one Reel via /{page-id}/video_reels start -> upload -> finish."""

    page_id = str(page.get("id") or "")
    token = (page.get("accessToken") or page.get("access_token") or "").strip()
    if not page_id or not token:
        raise FacebookError("Thiếu Page ID hoặc Page Access Token.")
    if not os.path.isfile(video_path):
        raise FacebookError(f"Không tìm thấy file clip: {video_path}")

    def ensure_active() -> None:
        if cancel and cancel():
            raise FacebookCancelled("Đã huỷ theo yêu cầu.")

    ensure_active()

    def stage(message: str) -> None:
        if on_stage:
            on_stage(message)

    base = _base(version)
    size = os.path.getsize(video_path)
    if size <= 0:
        raise FacebookError("File clip rỗng.")

    with httpx.Client(timeout=120) as client:
        ensure_active()
        stage("Đang tạo phiên upload Reels")
        start = _raise_for_graph(
            client.post(
                f"{base}/{page_id}/video_reels",
                data={"access_token": token, "upload_phase": "start"},
            ),
            "Bắt đầu upload Reels",
        )
        video_id = str(start.get("video_id") or start.get("id") or "")
        upload_url = str(start.get("upload_url") or "")
        if not video_id or not upload_url:
            raise FacebookError(f"Facebook không trả về video_id/upload_url: {start}")

        stage("Đang tải file clip lên Facebook")
        ensure_active()
        with open(video_path, "rb") as handle:
            binary = handle.read()
        try:
            upload_response = client.post(
                upload_url,
                content=binary,
                headers={
                    "Authorization": f"OAuth {token}",
                    "offset": "0",
                    "file_size": str(size),
                    "Content-Type": "application/octet-stream",
                },
                timeout=900,
            )
        except httpx.HTTPError as exc:
            raise FacebookError(f"Tải clip lên Facebook thất bại: {exc}") from exc
        _raise_for_graph(upload_response, "Tải clip lên Facebook")

        stage("Đang publish Reels")
        ensure_active()
        finish = _raise_for_graph(
            client.post(
                f"{base}/{page_id}/video_reels",
                data={
                    "access_token": token,
                    "upload_phase": "finish",
                    "video_id": video_id,
                    "video_state": "PUBLISHED",
                    "description": caption,
                },
            ),
            "Publish Reels",
        )

        permalink = str(finish.get("permalink_url") or "")
        post_id = str(finish.get("post_id") or finish.get("id") or "")
        status_text = ""
        deadline = time.time() + max(poll_timeout, 30)
        while time.time() < deadline:
            time.sleep(5)
            ensure_active()
            stage("Đang chờ Facebook xử lý video")
            try:
                status = _raise_for_graph(
                    client.get(
                        f"{base}/{video_id}",
                        params={
                            "access_token": token,
                            "fields": "status,permalink_url",
                        },
                    ),
                    "Kiểm tra trạng thái Reels",
                )
            except FacebookError:
                break
            raw_status = status.get("status")
            if isinstance(raw_status, dict):
                status_text = str(
                    raw_status.get("video_status")
                    or raw_status.get("status")
                    or ""
                )
            else:
                status_text = str(raw_status or status.get("video_status") or "")
            permalink = str(status.get("permalink_url") or permalink)
            if status_text.lower() in {"ready", "complete", "completed", "published", "processed"}:
                break

        base_permalink = permalink or f"https://www.facebook.com/reel/{video_id}"
        return {
            "ok": True,
            "pageId": page_id,
            "pageName": page.get("name") or page_id,
            "videoId": video_id,
            "postId": post_id,
            "permalinkUrl": base_permalink,
            "status": status_text or "unknown",
        }
