"""FastAPI worker: video -> transcript -> Gemini article."""

from __future__ import annotations

import copy
import importlib.util
import json
import logging
import os
import random
import re
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
load_dotenv(ROOT_DIR / ".env")

from ai import AIError, generate_json, test_connection  # noqa: E402
from article import ArticleError, normalize_article  # noqa: E402
from clips import (  # noqa: E402
    ClipCancelled,
    ClipError,
    cut_clips,
    download_video,
    ffmpeg_exe,
)
from facebook import (  # noqa: E402
    FacebookCancelled,
    FacebookError,
    build_caption,
    fetch_pages,
    normalize_hashtags,
    post_comment,
    upload_reel,
    validate_token,
)
from prompts import build_article_prompt, build_clip_prompt  # noqa: E402
from transcript import (  # noqa: E402
    TranscriptError,
    fetch_metadata,
    get_transcript,
    public_metadata,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("news247us-worker")

DOWNLOAD_DIR = ROOT_DIR / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

WHISPER_ENABLED = os.getenv("WHISPER_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small").strip() or "small"
MAX_FB_SOURCE_SECONDS = int(os.getenv("FB_MAX_SOURCE_SECONDS", "7200") or 7200)
ARTICLE_COMMENT_TEASER = "There’s more to this story than it seems 👇"

_cookies_env = os.getenv("YTDLP_COOKIES_FILE", "").strip()
COOKIES_FILE = str((ROOT_DIR / _cookies_env).resolve()) if _cookies_env else None
if COOKIES_FILE and not os.path.isfile(COOKIES_FILE):
    logger.warning("YTDLP_COOKIES_FILE not found: %s", COOKIES_FILE)
    COOKIES_FILE = None

JOBS: dict[str, dict] = {}
BATCHES: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
try:
    _saved_app_config = json.loads((ROOT_DIR / "data" / "config.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    _saved_app_config = {}
JOB_WORKERS = max(1, min(8, int(_saved_app_config.get("jobWorkers") or os.getenv("JOB_WORKERS", "4") or 4)))
JOB_SLOTS = threading.Condition()
ACTIVE_JOB_SLOTS = 0
MAX_BATCH_URLS = max(1, min(100, int(os.getenv("BATCH_MAX_URLS", "40") or 40)))
EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="job")


def _run_with_job_slot(function, *args) -> None:
    global ACTIVE_JOB_SLOTS
    with JOB_SLOTS:
        while ACTIVE_JOB_SLOTS >= JOB_WORKERS:
            JOB_SLOTS.wait()
        ACTIVE_JOB_SLOTS += 1
    try:
        function(*args)
    finally:
        with JOB_SLOTS:
            ACTIVE_JOB_SLOTS -= 1
            JOB_SLOTS.notify_all()


def _set_job_workers(value: int) -> int:
    global JOB_WORKERS
    workers = max(1, min(8, int(value)))
    with JOB_SLOTS:
        JOB_WORKERS = workers
        JOB_SLOTS.notify_all()
    return workers

# 0 = thử lại không giới hạn cho tới khi AI trả về bài hợp lệ.
AI_MAX_ATTEMPTS = max(0, int(os.getenv("AI_MAX_ATTEMPTS", "0") or 0))
AI_RETRY_BASE_SECONDS = max(0.5, float(os.getenv("AI_RETRY_BASE_SECONDS", "2") or 2))
AI_RETRY_MAX_SECONDS = max(5.0, float(os.getenv("AI_RETRY_MAX_SECONDS", "45") or 45))

app = FastAPI(title="News247US Worker", version="1.0.0")


class AIConfig(BaseModel):
    baseUrl: str = ""
    apiKey: str = ""
    model: str = "gemini-2.5-flash"
    apiStyle: str = "auto"


class AnalyzeRequest(BaseModel):
    url: str
    language: str = "en"
    tone: str = "neutral"
    length: str = "standard"
    instructions: str = ""
    categories: list[dict] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    ai: AIConfig


class BatchRequest(BaseModel):
    urls: list[str] = Field(default_factory=list)
    language: str = "en"
    tone: str = "neutral"
    length: str = "standard"
    instructions: str = ""
    categories: list[dict] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    ai: AIConfig


class TranscriptRequest(BaseModel):
    url: str


class AITestRequest(BaseModel):
    ai: AIConfig


class FacebookPage(BaseModel):
    id: str
    name: str = ""
    accessToken: str = ""


class FacebookJobRequest(BaseModel):
    url: str
    pages: list[FacebookPage] = Field(default_factory=list)
    hashtags: str = ""
    clipCount: int = 5
    minSeconds: int = 45
    maxSeconds: int = 75
    vertical: bool = True
    language: str = "en"
    keepFiles: bool = False
    apiVersion: str = "v25.0"
    articleUrl: str = ""
    ai: AIConfig


class FacebookTargetRequest(BaseModel):
    accessToken: str
    apiVersion: str = "v25.0"


class JobCancelled(Exception):
    """Raised when a running job is cancelled by the user."""


def _is_cancelled(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return bool(job and job.get("cancel_requested"))


def _ensure_active(job_id: str) -> None:
    if _is_cancelled(job_id):
        raise JobCancelled("Đã huỷ theo yêu cầu.")


def _mark_cancelled(job_id: str) -> None:
    _update(
        job_id,
        status="cancelled",
        stage="cancelled",
        percent=100,
        message="Đã huỷ",
        error=None,
    )


def _validate_url(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Link video không hợp lệ.")
    return url.strip()


def _update(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job.update(fields)
            job["updated_at"] = time.time()


def _cleanup_jobs() -> None:
    cutoff = time.time() - 3 * 3600
    with JOBS_LOCK:
        stale = [key for key, job in JOBS.items() if job["updated_at"] < cutoff]
        for key in stale:
            JOBS.pop(key, None)
        if len(JOBS) > 60:
            ordered = sorted(JOBS.items(), key=lambda item: item[1]["created_at"])
            for key, _ in ordered[: len(JOBS) - 60]:
                JOBS.pop(key, None)
        stale_batches = [
            key for key, batch in BATCHES.items() if batch["created_at"] < cutoff
        ]
        for key in stale_batches:
            BATCHES.pop(key, None)
        if len(BATCHES) > 20:
            ordered_batches = sorted(BATCHES.items(), key=lambda item: item[1]["created_at"])
            for key, _ in ordered_batches[: len(BATCHES) - 20]:
                BATCHES.pop(key, None)


def _sleep_cancellable(job_id: str, seconds: float) -> None:
    end = time.time() + max(0.0, seconds)
    while True:
        _ensure_active(job_id)
        remaining = end - time.time()
        if remaining <= 0:
            break
        time.sleep(min(0.5, remaining))
    _ensure_active(job_id)


def _retry_delay(attempt: int) -> float:
    delay = AI_RETRY_BASE_SECONDS * (2 ** min(max(attempt - 1, 0), 5))
    return min(AI_RETRY_MAX_SECONDS, delay) + random.uniform(0, 1)


def _produce_article(
    job_id: str,
    payload: dict,
    clean_metadata: dict,
    transcript: dict,
    options: dict,
) -> tuple[dict, dict, int]:
    """Gọi AI + chuẩn hoá bài; thử lại tới khi có bài hợp lệ (trừ lỗi cấu hình)."""
    system, user = build_article_prompt(
        clean_metadata,
        transcript["text"],
        options,
        payload.get("categories") or [],
        payload.get("tags") or [],
    )
    attempt = 0
    while True:
        _ensure_active(job_id)
        attempt += 1
        try:
            raw, ai_meta = generate_json(
                payload["ai"],
                system,
                user,
                temperature=0.7,
                max_tokens=8192,
            )
            article = normalize_article(
                raw,
                clean_metadata,
                options,
                payload.get("categories") or [],
                payload.get("tags") or [],
            )
            if attempt > 1:
                logger.info("Job %s produced article after %s AI attempts", job_id, attempt)
            return article, ai_meta, attempt
        except ArticleError as exc:
            error: Exception = exc
        except AIError as exc:
            if not getattr(exc, "retryable", True):
                _update(job_id, attempt=attempt)
                raise
            error = exc

        if AI_MAX_ATTEMPTS and attempt >= AI_MAX_ATTEMPTS:
            _update(job_id, attempt=attempt)
            raise error
        delay = _retry_delay(attempt)
        logger.warning(
            "Job %s AI attempt %s failed (%ss): %s", job_id, attempt, int(delay), error
        )
        _update(
            job_id,
            attempt=attempt,
            stage="analyze",
            percent=50,
            message=(
                f"AI chưa trả bài hợp lệ (lần {attempt}: {str(error)[:140]}). "
                f"Thử lại sau {int(delay)}s..."
            ),
        )
        _sleep_cancellable(job_id, delay)


def _create_article_job(
    url: str, payload: dict, *, batch_id: str = "", index: int = 0
) -> str:
    job_id = uuid.uuid4().hex
    now = time.time()
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "type": "article",
            "url": url,
            "batchId": batch_id,
            "index": index,
            "status": "queued",
            "stage": "queued",
            "percent": 0,
            "message": "Đang xếp hàng...",
            "created_at": now,
            "updated_at": now,
            "cancel_requested": False,
            "attempt": 0,
            "metadata": None,
            "transcript": None,
            "result": None,
            "error": None,
        }
    EXECUTOR.submit(_run_with_job_slot, _run_job, job_id, payload)
    return job_id


def _run_job(job_id: str, payload: dict) -> None:
    workdir = tempfile.mkdtemp(prefix="job-", dir=str(DOWNLOAD_DIR))
    options = {
        "language": payload.get("language", "en"),
        "tone": payload.get("tone", "neutral"),
        "length": payload.get("length", "standard"),
        "instructions": payload.get("instructions", ""),
    }
    try:
        _ensure_active(job_id)
        _update(
            job_id,
            status="running",
            stage="metadata",
            percent=4,
            message="Đang lấy thông tin video...",
        )
        metadata = fetch_metadata(payload["url"], workdir, COOKIES_FILE)
        _ensure_active(job_id)
        clean_metadata = public_metadata(metadata)
        _update(
            job_id,
            metadata=clean_metadata,
            stage="transcript",
            percent=15,
            message="Đang lấy phụ đề; nếu video không có phụ đề sẽ tự phiên âm bằng Whisper...",
        )

        transcript = get_transcript(
            payload["url"],
            metadata,
            workdir,
            whisper_enabled=WHISPER_ENABLED,
            whisper_model=WHISPER_MODEL,
            cookies_file=COOKIES_FILE,
        )
        _ensure_active(job_id)
        _update(
            job_id,
            transcript=transcript,
            stage="analyze",
            percent=50,
            message=f"Đã lấy {transcript['wordCount']} từ. AI đang phân tích...",
        )

        article, ai_meta, attempts = _produce_article(
            job_id, payload, clean_metadata, transcript, options
        )
        _ensure_active(job_id)
        _update(
            job_id,
            attempt=attempts,
            stage="write",
            percent=84,
            message="Đang hoàn thiện và kiểm tra bài viết...",
        )

        _ensure_active(job_id)
        _update(
            job_id,
            status="done",
            stage="done",
            percent=100,
            message="Hoàn tất",
            result={
                "metadata": clean_metadata,
                "transcript": transcript,
                "article": article,
                "ai": {**ai_meta, "attempts": attempts},
            },
        )
    except JobCancelled:
        logger.info("Job %s cancelled", job_id)
        _mark_cancelled(job_id)
    except (TranscriptError, AIError, ArticleError) as exc:
        logger.warning("Job %s failed: %s", job_id, exc)
        _update(job_id, status="error", stage="error", percent=100, message="Lỗi", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected job failure")
        _update(
            job_id,
            status="error",
            stage="error",
            percent=100,
            message="Lỗi",
            error=f"Lỗi không mong đợi: {exc}",
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _strip_hashtags(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"#\w+", "", text or "")).strip()


def _clip_hashtags(value) -> str:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return ""
    return normalize_hashtags(" ".join(str(item) for item in value))


def _clip_caption(clip: dict, extra_hashtags: str = "") -> str:
    combined = f"{clip.get('hashtags') or ''} {extra_hashtags or ''}".strip()
    return build_caption(clip["title"], clip["description"], combined)


def _normalize_clips(
    raw: dict,
    duration: float,
    count: int,
    min_seconds: int,
    max_seconds: int,
) -> list[dict]:
    items = raw.get("clips") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return []

    prepared: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError):
            continue
        if end <= start or duration <= 0:
            continue
        start = max(0.0, min(start, duration - 1))
        end = min(max(end, start + 1), duration)
        length = end - start
        tolerance = max(min_seconds - 10, 20)
        if length < tolerance:
            continue
        if length > max_seconds:
            end = start + max_seconds
        title = _strip_hashtags(str(item.get("title") or ""))[:140]
        description = _strip_hashtags(str(item.get("description") or ""))[:1500]
        if not title or not description:
            continue
        prepared.append(
            {
                "start": round(start, 2),
                "end": round(end, 2),
                "title": title,
                "description": description,
                "hashtags": _clip_hashtags(item.get("hashtags")),
                "reason": str(item.get("reason") or "").strip()[:300],
            }
        )

    prepared.sort(key=lambda clip: clip["start"])
    accepted: list[dict] = []
    for clip in prepared:
        if accepted and clip["start"] < accepted[-1]["end"] - 0.5:
            clip["start"] = round(accepted[-1]["end"] + 0.2, 2)
            if clip["end"] - clip["start"] < max(min_seconds - 10, 20):
                continue
        if clip["start"] >= duration - 10:
            continue
        if clip["end"] - clip["start"] > max_seconds:
            clip["end"] = round(clip["start"] + max_seconds, 2)
        accepted.append(clip)
        if len(accepted) >= count:
            break
    return accepted


def _assign_clips_to_pages(
    clips: list[dict], files: list[str], pages: list[dict]
) -> list[tuple[dict, str, dict]]:
    """Give each Page one randomly picked clip; avoid repeats while possible."""

    pool = list(zip(clips, files))
    if not pool or not pages:
        return []
    random.shuffle(pool)
    return [
        (pool[index % len(pool)][0], pool[index % len(pool)][1], page)
        for index, page in enumerate(pages)
    ]


def _run_facebook_job(job_id: str, payload: dict) -> None:
    workdir = tempfile.mkdtemp(prefix="fb-", dir=str(DOWNLOAD_DIR))
    options = {
        "language": payload.get("language", "en"),
        "clipCount": int(payload.get("clipCount") or 5),
        "minSeconds": int(payload.get("minSeconds") or 45),
        "maxSeconds": int(payload.get("maxSeconds") or 75),
    }
    pages = payload.get("pages") or []
    hashtags = payload.get("hashtags") or ""
    article_url = (payload.get("articleUrl") or "").strip()
    comment_text = (
        f"{ARTICLE_COMMENT_TEASER}\n{article_url}" if article_url else ""
    )
    api_version = payload.get("apiVersion") or "v25.0"
    posts: list[dict] = []

    try:
        _ensure_active(job_id)
        _update(
            job_id,
            status="running",
            stage="metadata",
            percent=3,
            message="Đang lấy thông tin video...",
        )
        metadata = fetch_metadata(payload["url"], workdir, COOKIES_FILE)
        _ensure_active(job_id)
        clean_metadata = public_metadata(metadata)
        duration = float(clean_metadata.get("duration") or 0)
        if duration <= 0:
            raise TranscriptError("Không xác định được thời lượng video.")
        if duration > MAX_FB_SOURCE_SECONDS:
            raise ClipError(
                f"Video dài {duration / 60:.0f} phút, vượt giới hạn "
                f"{MAX_FB_SOURCE_SECONDS // 60} phút. Dùng video ngắn hơn."
            )
        if duration < options["minSeconds"] + 5:
            raise ClipError(
                f"Video chỉ dài {duration:.0f} giây, không đủ để cắt clip "
                f"{options['minSeconds']}–{options['maxSeconds']} giây."
            )

        _update(
            job_id,
            metadata=clean_metadata,
            stage="transcript",
            percent=10,
            message="Đang lấy transcript kèm thời gian; nếu thiếu phụ đề sẽ tự phiên âm bằng Whisper...",
        )
        transcript = get_transcript(
            payload["url"],
            metadata,
            workdir,
            whisper_enabled=WHISPER_ENABLED,
            whisper_model=WHISPER_MODEL,
            cookies_file=COOKIES_FILE,
            include_segments=True,
        )
        _ensure_active(job_id)
        segments = transcript.get("segments") or []
        if not segments:
            raise TranscriptError(
                "Không có transcript theo thời gian để AI chọn đoạn highlight."
            )

        max_count = max(1, min(10, int(duration // options["minSeconds"])))
        clip_count = max(1, min(options["clipCount"], max_count))
        options["clipCount"] = clip_count

        _update(
            job_id,
            transcript={
                "wordCount": transcript.get("wordCount"),
                "source": transcript.get("source"),
            },
            stage="select",
            percent=20,
            message=f"AI đang chọn {clip_count} đoạn highlight...",
        )
        system, user = build_clip_prompt(clean_metadata, segments, options)
        raw, ai_meta = generate_json(
            payload["ai"],
            system,
            user,
            temperature=0.4,
            max_tokens=4096,
        )
        _ensure_active(job_id)
        clips = _normalize_clips(
            raw,
            duration,
            clip_count,
            options["minSeconds"],
            options["maxSeconds"],
        )
        if not clips:
            raise AIError(
                "AI không trả về đoạn clip hợp lệ. Thử lại hoặc giảm số clip."
            )

        _ensure_active(job_id)
        _update(
            job_id,
            stage="download",
            percent=30,
            clips=[
                {
                    "index": index + 1,
                    "start": clip["start"],
                    "end": clip["end"],
                    "duration": round(clip["end"] - clip["start"], 1),
                    "title": clip["title"],
                    "description": clip["description"],
                    "hashtags": clip.get("hashtags") or "",
                    "reason": clip.get("reason", ""),
                    "caption": _clip_caption(clip, hashtags),
                }
                for index, clip in enumerate(clips)
            ],
            message="Đang tải video gốc từ YouTube...",
        )

        def download_progress(fraction: float, label: str) -> None:
            _update(
                job_id,
                percent=30 + int(fraction * 25),
                message=f"Đang tải video gốc... {label}",
            )

        source = download_video(
            payload["url"],
            workdir,
            cookies_file=COOKIES_FILE,
            progress=download_progress,
            cancel=lambda: _is_cancelled(job_id),
        )

        _ensure_active(job_id)
        _update(
            job_id,
            stage="cut",
            percent=56,
            message=f"Đang cắt {len(clips)} clip dọc 9:16...",
        )

        def cut_progress(done: int, total: int, clip: dict) -> None:
            _update(
                job_id,
                percent=56 + int(done / max(total, 1) * 20),
                message=f"Đã cắt {done}/{total} clip...",
            )

        files = cut_clips(
            source,
            clips,
            os.path.join(workdir, "clips"),
            vertical=bool(payload.get("vertical", True)),
            progress=cut_progress,
            cancel=lambda: _is_cancelled(job_id),
        )
        _ensure_active(job_id)
        try:
            os.remove(source)
        except OSError:
            pass

        result_clips = []
        for index, (clip, path) in enumerate(zip(clips, files), 1):
            entry = {
                "index": index,
                "start": clip["start"],
                "end": clip["end"],
                "duration": round(clip["end"] - clip["start"], 1),
                "title": clip["title"],
                "description": clip["description"],
                "hashtags": clip.get("hashtags") or "",
                "reason": clip.get("reason", ""),
                "caption": _clip_caption(clip, hashtags),
                "fileName": os.path.basename(path),
            }
            if payload.get("keepFiles"):
                entry["fileUrl"] = "/downloads/" + Path(path).relative_to(DOWNLOAD_DIR).as_posix()
            result_clips.append(entry)

        assignments = _assign_clips_to_pages(result_clips, files, pages)
        total_uploads = len(assignments)
        completed_uploads = 0
        _update(
            job_id,
            clips=result_clips,
            stage="upload",
            percent=76 if assignments else 96,
            message=(
                f"Đang đăng 1 clip ngẫu nhiên lên {len(pages)} Page..."
                if assignments
                else "Đã tạo clip. Chưa chọn Page nên không đăng."
            ),
        )

        for position, (clip_entry, path, page) in enumerate(assignments, 1):
            _ensure_active(job_id)
            page_name = page.get("name") or page.get("id")
            _update(
                job_id,
                message=(
                    f"Đang đăng clip {clip_entry['index']} lên {page_name} "
                    f"({position}/{total_uploads})..."
                ),
            )
            try:
                posted = upload_reel(
                    page,
                    path,
                    clip_entry["caption"],
                    version=api_version,
                    on_stage=lambda stage_text, name=page_name: _update(
                        job_id, message=f"{stage_text} · {name}"
                    ),
                    cancel=lambda: _is_cancelled(job_id),
                )
                posted["clipIndex"] = clip_entry["index"]
                posted["clipTitle"] = clip_entry["title"]
                if comment_text:
                    _ensure_active(job_id)
                    _update(job_id, message=f"Đang comment link bài viết · {page_name}")
                    try:
                        posted["comment"] = post_comment(
                            page,
                            posted.get("videoId") or "",
                            comment_text,
                            version=api_version,
                        )
                    except Exception as exc:  # noqa: BLE001 - comment must not fail a posted Reel
                        posted["commentError"] = str(exc)
            except FacebookError as exc:
                posted = {
                    "ok": False,
                    "pageId": page.get("id"),
                    "pageName": page_name,
                    "clipIndex": clip_entry["index"],
                    "clipTitle": clip_entry["title"],
                    "error": str(exc),
                }
            posts.append(posted)
            completed_uploads += 1
            _update(
                job_id,
                posts=list(posts),
                percent=76 + int(completed_uploads / max(total_uploads, 1) * 24),
            )

        failed = [post for post in posts if not post.get("ok")]
        comment_failed = [post for post in posts if post.get("commentError")]
        commented = [post for post in posts if post.get("comment")]
        result = {
            "metadata": clean_metadata,
            "clips": result_clips,
            "posts": posts,
            "ai": ai_meta,
            "articleUrl": article_url,
            "pages": [
                {"id": page.get("id"), "name": page.get("name") or page.get("id")}
                for page in pages
            ],
            "postedCount": len(posts) - len(failed),
            "failedCount": len(failed),
            "commentedCount": len(commented),
            "commentFailedCount": len(comment_failed),
        }

        if posts and len(failed) == len(posts):
            _update(
                job_id,
                status="error",
                stage="error",
                percent=100,
                message="Không đăng được video lên Facebook",
                error=failed[0].get("error") or "Facebook từ chối toàn bộ video.",
                result=result,
            )
            return

        if failed:
            message = (
                f"Đã đăng {len(posts) - len(failed)}/{len(posts)} video. "
                f"{len(failed)} video lỗi."
            )
            warnings = [f"{post['pageName']}: {post.get('error')}" for post in failed]
        elif posts:
            message = f"Đã đăng {len(posts)} video lên {len(pages)} Page."
            warnings = []
        else:
            message = f"Đã tạo {len(result_clips)} clip (chưa chọn Page)."
            warnings = []

        if commented:
            message += f" Đã comment link bài viết dưới {len(commented)} Reel."
        elif not article_url and posts:
            warnings.append(
                "Chưa có link bài viết nên Reel không có comment dẫn về bài."
            )
        warnings.extend(
            f"{post['pageName']}: comment lỗi: {post.get('commentError')}"
            for post in comment_failed
        )

        _update(
            job_id,
            status="done",
            stage="done",
            percent=100,
            message=message,
            warnings=warnings,
            result=result,
        )
    except (JobCancelled, ClipCancelled, FacebookCancelled):
        logger.info("Facebook job %s cancelled", job_id)
        _mark_cancelled(job_id)
    except (TranscriptError, AIError, ClipError, FacebookError) as exc:
        logger.warning("Facebook job %s failed: %s", job_id, exc)
        _update(
            job_id,
            status="error",
            stage="error",
            percent=100,
            message="Lỗi",
            error=str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected Facebook job failure")
        _update(
            job_id,
            status="error",
            stage="error",
            percent=100,
            message="Lỗi",
            error=f"Lỗi không mong đợi: {exc}",
        )
    finally:
        if not payload.get("keepFiles"):
            shutil.rmtree(workdir, ignore_errors=True)


@app.put("/settings/concurrency")
def update_concurrency(payload: dict) -> dict:
    value = payload.get("workers")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 8:
        raise HTTPException(status_code=400, detail="Số luồng phải là số nguyên từ 1 đến 8.")
    return {"ok": True, "concurrency": _set_job_workers(value)}


@app.get("/health")
def health() -> dict:
    try:
        import yt_dlp

        ytdlp_version = getattr(yt_dlp.version, "__version__", "unknown")
    except Exception:  # noqa: BLE001
        ytdlp_version = None
    try:
        ffmpeg_exe()
        ffmpeg_ok = True
    except ClipError:
        ffmpeg_ok = False
    return {
        "ok": True,
        "service": "news247us-worker",
        "ytdlp": ytdlp_version,
        "ffmpeg": ffmpeg_ok,
        "whisper": importlib.util.find_spec("faster_whisper") is not None,
        "whisperEnabled": WHISPER_ENABLED,
        "concurrency": JOB_WORKERS,
    }


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    url = _validate_url(request.url)
    _cleanup_jobs()

    payload = {
        "url": url,
        "language": request.language,
        "tone": request.tone,
        "length": request.length,
        "instructions": request.instructions,
        "categories": request.categories,
        "tags": request.tags,
        "ai": request.ai.model_dump(),
    }
    job_id = _create_article_job(url, payload)
    return {"jobId": job_id}


@app.post("/batch")
def analyze_batch(request: BatchRequest) -> dict:
    _cleanup_jobs()

    urls: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for raw in request.urls:
        candidate = (raw or "").strip()
        if not candidate:
            continue
        try:
            candidate = _validate_url(candidate)
        except HTTPException:
            invalid.append(candidate)
            continue
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        urls.append(candidate)

    if not urls:
        raise HTTPException(status_code=400, detail="Không có link video hợp lệ trong danh sách.")
    if len(urls) > MAX_BATCH_URLS:
        raise HTTPException(
            status_code=400,
            detail=f"Mỗi lần chỉ nhận tối đa {MAX_BATCH_URLS} link (đang có {len(urls)}).",
        )

    batch_id = uuid.uuid4().hex
    items: list[dict] = []
    for index, url in enumerate(urls, 1):
        payload = {
            "url": url,
            "language": request.language,
            "tone": request.tone,
            "length": request.length,
            "instructions": request.instructions,
            "categories": request.categories,
            "tags": request.tags,
            "ai": request.ai.model_dump(),
        }
        job_id = _create_article_job(url, payload, batch_id=batch_id, index=index)
        items.append({"index": index, "url": url, "jobId": job_id})

    with JOBS_LOCK:
        BATCHES[batch_id] = {
            "id": batch_id,
            "created_at": time.time(),
            "items": items,
        }

    return {
        "batchId": batch_id,
        "total": len(items),
        "concurrency": JOB_WORKERS,
        "invalid": invalid,
        "items": items,
    }


@app.get("/batch/{batch_id}")
def get_batch(batch_id: str) -> dict:
    with JOBS_LOCK:
        batch = BATCHES.get(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="Không tìm thấy batch.")
        meta_items = list(batch["items"])

    counts = {"queued": 0, "running": 0, "done": 0, "error": 0, "cancelled": 0}
    items: list[dict] = []
    percent_total = 0.0
    for meta in meta_items:
        with JOBS_LOCK:
            job = JOBS.get(meta["jobId"])
            snapshot = copy.deepcopy(job) if job else None
        if snapshot is None:
            snapshot = {
                "id": meta["jobId"],
                "status": "error",
                "stage": "error",
                "percent": 100,
                "message": "Mất job",
                "error": "Job không còn trong bộ nhớ worker (worker có thể đã khởi động lại).",
            }
        snapshot["index"] = meta["index"]
        snapshot["url"] = meta["url"]
        status = str(snapshot.get("status") or "queued")
        if status not in counts:
            status = "queued"
        counts[status] += 1
        percent_total += float(snapshot.get("percent") or 0)
        items.append(snapshot)

    total = len(items)
    active = counts["queued"] + counts["running"]
    return {
        "id": batch_id,
        "status": "running" if active else "done",
        "total": total,
        "percent": round(percent_total / total) if total else 0,
        "counts": counts,
        "concurrency": JOB_WORKERS,
        "items": items,
    }


@app.post("/batch/{batch_id}/cancel")
def cancel_batch(batch_id: str) -> dict:
    with JOBS_LOCK:
        batch = BATCHES.get(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="Không tìm thấy batch.")

        cancelled = 0
        for meta in batch["items"]:
            job = JOBS.get(meta["jobId"])
            if not job or job.get("status") in ("done", "error", "cancelled"):
                continue
            job["cancel_requested"] = True
            job["message"] = "Đang huỷ..."
            job["updated_at"] = time.time()
            cancelled += 1

    return {
        "ok": cancelled > 0,
        "id": batch_id,
        "cancelled": cancelled,
        "message": "Đã gửi yêu cầu huỷ." if cancelled else "Không còn job nào đang chạy.",
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Không tìm thấy job.")
        return copy.deepcopy(job)


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Không tìm thấy job.")
        status = job.get("status")
        if status in ("done", "error", "cancelled"):
            return {
                "ok": False,
                "id": job_id,
                "status": status,
                "message": "Job đã kết thúc, không thể huỷ.",
            }
        job["cancel_requested"] = True
        job["message"] = "Đang huỷ..."
        job["updated_at"] = time.time()
        return {
            "ok": True,
            "id": job_id,
            "status": status,
            "message": "Đã gửi yêu cầu huỷ.",
        }


@app.post("/transcript")
def transcript_only(request: TranscriptRequest) -> dict:
    url = _validate_url(request.url)
    workdir = tempfile.mkdtemp(prefix="transcript-", dir=str(DOWNLOAD_DIR))
    try:
        metadata = fetch_metadata(url, workdir, COOKIES_FILE)
        transcript = get_transcript(
            url,
            metadata,
            workdir,
            whisper_enabled=WHISPER_ENABLED,
            whisper_model=WHISPER_MODEL,
            cookies_file=COOKIES_FILE,
        )
        return {"metadata": public_metadata(metadata), "transcript": transcript}
    except (TranscriptError, AIError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/facebook/jobs")
def facebook_job(request: FacebookJobRequest) -> dict:
    url = _validate_url(request.url)
    _cleanup_jobs()

    job_id = uuid.uuid4().hex
    now = time.time()
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "type": "facebook",
            "status": "queued",
            "stage": "queued",
            "percent": 0,
            "message": "Đang xếp hàng...",
            "created_at": now,
            "updated_at": now,
            "cancel_requested": False,
            "metadata": None,
            "transcript": None,
            "clips": [],
            "posts": [],
            "result": None,
            "error": None,
        }

    payload = request.model_dump()
    payload["url"] = url
    EXECUTOR.submit(_run_with_job_slot, _run_facebook_job, job_id, payload)
    return {"jobId": job_id}


@app.post("/facebook/test")
def facebook_test(request: FacebookTargetRequest) -> dict:
    try:
        return validate_token(request.accessToken, request.apiVersion)
    except FacebookError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/facebook/pages")
def facebook_pages(request: FacebookTargetRequest) -> dict:
    try:
        pages = fetch_pages(request.accessToken, request.apiVersion)
    except FacebookError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "pages": pages}


@app.post("/ai/test")
def ai_test(request: AITestRequest) -> dict:
    try:
        return test_connection(request.ai.model_dump())
    except AIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Lỗi kiểm tra AI: {exc}") from exc


@app.on_event("startup")
def on_startup() -> None:
    logger.info(
        "Worker ready. Whisper=%s (%s), cookies=%s",
        WHISPER_ENABLED,
        WHISPER_MODEL,
        "yes" if COOKIES_FILE else "no",
    )
