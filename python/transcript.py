"""YouTube metadata and transcript extraction.

Primary path: subtitles / auto-generated captions exposed by yt-dlp.
Optional fallback: local Whisper transcription when WHISPER_ENABLED=1.
"""

from __future__ import annotations

import glob
import html
import json
import os
import re
import threading
from typing import Any

import httpx
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

import proxies


class TranscriptError(Exception):
    """Raised when metadata or a usable transcript cannot be obtained."""


_PREFERRED_EXTS = {"json3": 0, "vtt": 1, "srv3": 2, "ttml": 3}
_WHISPER_MODELS: dict[str, Any] = {}
_WHISPER_LOCK = threading.Lock()


def _base_opts(workdir: str, cookies_file: str | None, proxy: str | None = None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 30,
        "retries": 3,
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
    }
    if cookies_file and os.path.isfile(cookies_file):
        opts["cookiefile"] = cookies_file
    if proxy:
        opts["proxy"] = proxy
    return opts


def _friendly_error(exc: Exception) -> str:
    message = proxies.error_summary(exc)
    lower = message.lower()
    if "sign in to confirm" in lower or "not a bot" in lower:
        return (
            "YouTube đang chặn máy này (xác minh bot). Hãy xuất cookies.txt từ trình duyệt "
            "và đặt đường dẫn vào YTDLP_COOKIES_FILE trong file .env, hoặc bật proxy "
            "trong Cài đặt để đổi IP tải."
        )
    if "video unavailable" in lower or "private video" in lower:
        return "Video không khả dụng hoặc đang ở chế độ riêng tư."
    if "age" in lower and "restricted" in lower:
        return "Video bị giới hạn độ tuổi. Cần cookies.txt để tải phụ đề."
    return f"Không lấy được dữ liệu video: {message}"


def fetch_metadata(url: str, workdir: str, cookies_file: str | None = None) -> dict:
    def extract(proxy: str | None) -> dict:
        with YoutubeDL(_base_opts(workdir, cookies_file, proxy)) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = proxies.run_ytdlp(extract)
    except DownloadError as exc:
        raise TranscriptError(_friendly_error(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface a readable message to the UI
        raise TranscriptError(_friendly_error(exc)) from exc

    if not info:
        raise TranscriptError("Không đọc được thông tin video.")

    if info.get("entries"):
        entries = [entry for entry in info["entries"] if entry]
        if not entries:
            raise TranscriptError("Playlist không có video nào.")
        info = entries[0]

    upload_date = info.get("upload_date") or ""
    if len(upload_date) == 8 and upload_date.isdigit():
        upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

    video_id = info.get("id") or ""
    thumbnail = info.get("thumbnail") or ""
    if not thumbnail and video_id:
        thumbnail = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

    return {
        "id": video_id,
        "title": info.get("title") or "Untitled video",
        "channel": info.get("channel") or info.get("uploader") or "",
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "upload_date": upload_date,
        "duration": info.get("duration") or 0,
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "description": (info.get("description") or "")[:4000],
        "thumbnail": thumbnail,
        "webpage_url": info.get("webpage_url") or url,
        "tags": [t for t in (info.get("tags") or []) if t][:15],
        "is_live": bool(info.get("is_live")),
        # Private keys used by get_transcript(); stripped before being sent to clients.
        "_subtitles": info.get("subtitles") or {},
        "_automatic_captions": info.get("automatic_captions") or {},
    }


def public_metadata(info: dict) -> dict:
    return {key: value for key, value in info.items() if not key.startswith("_")}


def _pick_subtitle(info: dict) -> tuple[str, bool] | None:
    manual = info.get("_subtitles") or info.get("subtitles") or {}
    automatic = info.get("_automatic_captions") or info.get("automatic_captions") or {}

    def score(lang: str, is_auto: bool) -> tuple[int, str]:
        code = lang.lower()
        if code in ("en", "en-us", "en-gb", "en-orig"):
            rank = 0
        elif code.startswith("en"):
            rank = 1
        elif code in ("vi", "vi-vn"):
            rank = 2
        elif code.startswith("vi"):
            rank = 3
        else:
            rank = 10
        return (rank + (5 if is_auto else 0), code)

    candidates: list[tuple[str, bool]] = []
    for lang in manual:
        if "live_chat" not in lang:
            candidates.append((lang, False))
    for lang in automatic:
        if "live_chat" not in lang and lang not in manual:
            candidates.append((lang, True))

    if not candidates:
        return None
    return min(candidates, key=lambda item: score(*item))


def _clean_text(text: str) -> str:
    text = html.unescape(text or "")
    text = text.replace("\u200b", "").replace("\xa0", " ")
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if re.fullmatch(r"[\[\(（].{0,40}[\]\)）]", text):
        return ""
    if re.fullmatch(r"[>\-\s]+", text):
        return ""
    return text


def _dedupe(cues: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    out: list[tuple[int, int, str]] = []
    for start, duration, raw in cues:
        text = _clean_text(raw)
        if not text:
            continue
        if out and text == out[-1][2]:
            continue
        if out and len(text) < 25 and out[-1][2].endswith(text):
            continue
        out.append((start, duration, text))
    return out


def _join_cues(cues: list[tuple[int, int, str]]) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    last_end: int | None = None
    for start, duration, text in cues:
        if (
            current
            and last_end is not None
            and start - last_end > 3000
            and sum(len(part) for part in current) > 260
        ):
            paragraphs.append(" ".join(current))
            current = []
        current.append(text)
        last_end = start + max(duration or 0, 0)
    if current:
        paragraphs.append(" ".join(current))
    joined = "\n\n".join(paragraphs)
    return re.sub(r"[ \t]+", " ", joined).strip()


def _group_cues(
    cues: list[tuple[int, int, str]], target_ms: int = 12000
) -> list[dict]:
    """Group subtitle cues into readable timed segments for the clip prompt."""
    segments: list[dict] = []
    current: list[tuple[int, int, str]] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        start = current[0][0]
        end = current[-1][0] + max(current[-1][1], 0)
        text = re.sub(r"\s+", " ", " ".join(item[2] for item in current)).strip()
        if text and end > start:
            segments.append(
                {
                    "start": round(start / 1000, 2),
                    "end": round(end / 1000, 2),
                    "text": text,
                }
            )
        current = []

    for start, duration, text in cues:
        if current:
            gap = start - (current[-1][0] + max(current[-1][1], 0))
            spoken = start + max(duration, 0) - current[0][0]
            chars = sum(len(item[2]) for item in current)
            if gap > 2500 or spoken >= target_ms or chars >= 260:
                flush()
        current.append((start, duration, text))
    flush()
    return segments


def _parse_timestamp(value: str) -> int:
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return 0
    if len(numbers) == 3:
        hours, minutes, seconds = numbers
    elif len(numbers) == 2:
        hours, minutes, seconds = 0, numbers[0], numbers[1]
    else:
        hours, minutes, seconds = 0, 0, numbers[0]
    return int((hours * 3600 + minutes * 60 + seconds) * 1000)


def _parse_json3(body: str) -> list[tuple[int, int, str]]:
    data = json.loads(body)
    cues: list[tuple[int, int, str]] = []
    for event in data.get("events", []):
        segments = event.get("segs") or []
        text = "".join(segment.get("utf8", "") for segment in segments)
        text = _clean_text(text)
        if text:
            cues.append(
                (
                    int(event.get("tStartMs") or 0),
                    int(event.get("dDurationMs") or 0),
                    text,
                )
            )
    return cues


def _parse_vtt(body: str) -> list[tuple[int, int, str]]:
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    cues: list[tuple[int, int, str]] = []
    current_text: list[str] = []
    start = 0
    duration = 0

    def flush() -> None:
        nonlocal current_text
        if current_text:
            text = _clean_text(" ".join(current_text))
            if text:
                cues.append((start, duration, text))
        current_text = []

    for raw_line in body.split("\n"):
        line = raw_line.strip().lstrip("\ufeff")
        if not line:
            flush()
            continue
        if line.startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue
        if "-->" in line:
            flush()
            left, _, right = line.partition("-->")
            start = _parse_timestamp(left.split()[0] if left.split() else "0")
            end_token = right.split()[0] if right.split() else "0"
            duration = max(_parse_timestamp(end_token) - start, 0)
            continue
        if line.isdigit():
            continue
        current_text.append(line)
    flush()
    return cues


def _format_list(info: dict, lang: str, is_auto: bool) -> list[dict]:
    if is_auto:
        group = info.get("_automatic_captions") or info.get("automatic_captions") or {}
    else:
        group = info.get("_subtitles") or info.get("subtitles") or {}
    formats = group.get(lang) or []
    return sorted(formats, key=lambda item: _PREFERRED_EXTS.get(item.get("ext", ""), 9))


def _fetch_direct(formats: list[dict]) -> list[tuple[int, int, str]]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        )
    }
    for fmt in formats:
        ext = fmt.get("ext")
        url = fmt.get("url")
        if ext not in ("json3", "vtt") or not url:
            continue
        try:
            response = httpx.get(url, headers=headers, timeout=30, follow_redirects=True)
            if response.status_code != 200 or not response.text.strip():
                continue
            cues = _parse_json3(response.text) if ext == "json3" else _parse_vtt(response.text)
            if cues:
                return cues
        except (httpx.HTTPError, ValueError):
            continue
    return []


def _download_subs_via_ytdlp(
    url: str,
    info: dict,
    workdir: str,
    lang: str,
    is_auto: bool,
    cookies_file: str | None,
) -> list[tuple[int, int, str]]:
    def download(proxy: str | None) -> None:
        opts = _base_opts(workdir, cookies_file, proxy)
        opts.update(
            {
                "skip_download": True,
                "writesubtitles": not is_auto,
                "writeautomaticsub": is_auto,
                "subtitleslangs": [lang],
                "subtitlesformat": "json3/vtt/best",
            }
        )
        with YoutubeDL(opts) as ydl:
            ydl.download([url])

    try:
        proxies.run_ytdlp(download)
    except DownloadError:
        return []

    video_id = info.get("id") or ""
    pattern = os.path.join(workdir, f"{video_id}*")
    files = sorted(glob.glob(pattern))
    for path in [p for p in files if p.endswith(".json3")]:
        try:
            cues = _parse_json3(open(path, encoding="utf-8").read())
            if cues:
                return cues
        except (OSError, ValueError):
            continue
    for path in [p for p in files if p.endswith(".vtt")]:
        try:
            cues = _parse_vtt(open(path, encoding="utf-8").read())
            if cues:
                return cues
        except (OSError, ValueError):
            continue
    return []


def _get_whisper_model(name: str):
    with _WHISPER_LOCK:
        if name not in _WHISPER_MODELS:
            from faster_whisper import WhisperModel

            _WHISPER_MODELS[name] = WhisperModel(name, device="cpu", compute_type="int8")
        return _WHISPER_MODELS[name]


def _transcribe_with_whisper(
    url: str,
    workdir: str,
    model_name: str,
    cookies_file: str | None,
) -> tuple[str, str, list[dict]]:
    try:
        import faster_whisper  # noqa: F401
    except ImportError as exc:
        raise TranscriptError(
            "Video không có phụ đề và Whisper chưa được cài. Chạy: "
            '".venv\\Scripts\\python.exe" -m pip install faster-whisper '
            "(hoặc tắt WHISPER_ENABLED)."
        ) from exc

    audio_opts = {
        "skip_download": False,
        "format": "bestaudio/best",
        "outtmpl": os.path.join(workdir, "audio.%(ext)s"),
    }

    def download_audio(proxy: str | None) -> None:
        opts = _base_opts(workdir, cookies_file, proxy)
        opts.update(audio_opts)
        with YoutubeDL(opts) as ydl:
            ydl.download([url])

    try:
        proxies.run_ytdlp(download_audio)
    except DownloadError as exc:
        raise TranscriptError(_friendly_error(exc)) from exc

    audio_files = sorted(glob.glob(os.path.join(workdir, "audio.*")))
    if not audio_files:
        raise TranscriptError("Không tải được audio để chạy Whisper.")
    audio_path = audio_files[0]

    try:
        model = _get_whisper_model(model_name)
        segments, detected = model.transcribe(audio_path, vad_filter=True)
        pieces: list[str] = []
        timed: list[dict] = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            pieces.append(text)
            timed.append(
                {
                    "start": round(float(segment.start), 2),
                    "end": round(float(segment.end), 2),
                    "text": text,
                }
            )
    except Exception as exc:  # noqa: BLE001
        raise TranscriptError(f"Whisper lỗi: {exc}") from exc

    text = re.sub(r"\s+", " ", " ".join(pieces)).strip()
    if not text:
        raise TranscriptError("Whisper không nhận dạng được lời nói trong video.")
    return text, getattr(detected, "language", "") or "", timed


def get_transcript(
    url: str,
    info: dict,
    workdir: str,
    whisper_enabled: bool = False,
    whisper_model: str = "small",
    cookies_file: str | None = None,
    include_segments: bool = False,
) -> dict:
    choice = _pick_subtitle(info)
    if choice:
        lang, is_auto = choice
        formats = _format_list(info, lang, is_auto)
        cues = _fetch_direct(formats)
        if not cues:
            cues = _download_subs_via_ytdlp(url, info, workdir, lang, is_auto, cookies_file)
        cues = _dedupe(cues)
        text = _join_cues(cues)
        if len(text.split()) >= 10:
            result = {
                "text": text,
                "language": lang,
                "source": "auto" if is_auto else "manual",
                "wordCount": len(text.split()),
                "cueCount": len(cues),
            }
            if include_segments:
                result["segments"] = _group_cues(cues)
            return result

    if whisper_enabled:
        text, detected_language, timed = _transcribe_with_whisper(
            url, workdir, whisper_model, cookies_file
        )
        result = {
            "text": text,
            "language": detected_language or "unknown",
            "source": "whisper",
            "wordCount": len(text.split()),
            "cueCount": len(timed),
        }
        if include_segments:
            result["segments"] = timed
        return result

    raise TranscriptError(
        "Video không có phụ đề khả dụng. Bật WHISPER_ENABLED=1 và cài faster-whisper "
        "để tự động phiên âm từ audio."
    )
