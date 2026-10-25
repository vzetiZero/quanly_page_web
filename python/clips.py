"""Download a YouTube video and cut vertical highlight clips with ffmpeg."""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

import imageio_ffmpeg
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


class ClipError(Exception):
    """Raised when ffmpeg or the video download fails."""


class ClipCancelled(Exception):
    """Raised when the user cancels a download or cut."""


_FFMPEG_LOCK = threading.Lock()
_FFMPEG_EXE: str | None = None


def ffmpeg_exe() -> str:
    global _FFMPEG_EXE
    with _FFMPEG_LOCK:
        if _FFMPEG_EXE:
            return _FFMPEG_EXE

        candidates: list[str] = []
        try:
            candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
        except Exception:  # noqa: BLE001 - fall back to a system ffmpeg
            pass
        system_ffmpeg = shutil.which("ffmpeg")
        if system_ffmpeg:
            candidates.append(system_ffmpeg)

        for candidate in candidates:
            if not candidate or not os.path.isfile(candidate):
                continue
            try:
                result = subprocess.run(
                    [candidate, "-version"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    encoding="utf-8",
                    errors="replace",
                )
                if result.returncode == 0:
                    _FFMPEG_EXE = candidate
                    return candidate
            except (OSError, subprocess.SubprocessError):
                continue

        raise ClipError(
            "Không tìm thấy ffmpeg. Chạy setup.bat hoặc cài imageio-ffmpeg: "
            '".venv\\\\Scripts\\\\python.exe" -m pip install imageio-ffmpeg'
        )


def _friendly_download_error(exc: Exception) -> str:
    message = str(exc)
    lower = message.lower()
    if "sign in to confirm" in lower or "not a bot" in lower:
        return (
            "YouTube đang chặn máy này (xác minh bot). Xuất cookies.txt và đặt "
            "YTDLP_COOKIES_FILE trong .env."
        )
    if "requested format" in lower:
        return f"Không tìm được định dạng video phù hợp: {message}"
    return f"Không tải được video: {message}"


def download_video(
    url: str,
    workdir: str,
    *,
    cookies_file: str | None = None,
    max_height: int = 720,
    progress: Callable[[float, str], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> str:
    """Download the best mp4 up to max_height and return its path."""

    if cancel and cancel():
        raise ClipCancelled("Đã huỷ theo yêu cầu.")

    ffmpeg = ffmpeg_exe()
    os.makedirs(workdir, exist_ok=True)
    cancelled = False

    def hook(data: dict) -> None:
        nonlocal cancelled
        if cancel and cancel():
            cancelled = True
            raise ClipCancelled("Đã huỷ theo yêu cầu.")
        if not progress or data.get("status") != "downloading":
            return
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        done = data.get("downloaded_bytes") or 0
        if not total:
            return
        percent = min(max(done / total, 0.0), 1.0)
        speed = data.get("speed") or 0
        label = f"{percent * 100:.0f}%"
        if speed:
            label += f" · {speed / 1024 / 1024:.1f} MB/s"
        progress(percent, label)

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 4,
        "format": (
            f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/"
            f"b[height<={max_height}][ext=mp4]/"
            f"bv*[height<={max_height}]+ba/"
            f"b[height<={max_height}]/b"
        ),
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(workdir, "source.%(ext)s"),
        "ffmpeg_location": ffmpeg,
        "progress_hooks": [hook],
    }
    if cookies_file and os.path.isfile(cookies_file):
        opts["cookiefile"] = cookies_file

    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
    except ClipCancelled:
        raise
    except DownloadError as exc:
        if cancelled:
            raise ClipCancelled("Đã huỷ theo yêu cầu.") from exc
        raise ClipError(_friendly_download_error(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if cancelled or (cancel and cancel()):
            raise ClipCancelled("Đã huỷ theo yêu cầu.") from exc
        raise ClipError(_friendly_download_error(exc)) from exc

    if cancelled or (cancel and cancel()):
        raise ClipCancelled("Đã huỷ theo yêu cầu.")

    matches = sorted(Path(workdir).glob("source.*"))
    if not matches:
        raise ClipError("Tải video xong nhưng không tìm thấy file nguồn.")
    return str(matches[0])


def cut_vertical_clip(
    source: str,
    output: str,
    start: float,
    duration: float,
    *,
    vertical: bool = True,
    cancel: Callable[[], bool] | None = None,
) -> str:
    """Cut [start, start+duration] and render a 1080x1920 reel."""

    if cancel and cancel():
        raise ClipCancelled("Đã huỷ theo yêu cầu.")

    ffmpeg = ffmpeg_exe()
    os.makedirs(os.path.dirname(output), exist_ok=True)

    if vertical:
        filters = (
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,boxblur=24:2[bg];"
            "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[v]"
        )
        video_args = ["-filter_complex", filters, "-map", "[v]"]
    else:
        video_args = ["-map", "0:v:0"]

    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{max(start, 0):.3f}",
        "-i",
        source,
        "-t",
        f"{max(duration, 1):.3f}",
        *video_args,
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-movflags",
        "+faststart",
        "-shortest",
        output,
    ]

    if cancel is None:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=900,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.SubprocessError as exc:
            raise ClipError(f"ffmpeg lỗi khi cắt clip: {exc}") from exc
        returncode = result.returncode
        stderr = result.stderr or ""
    else:
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            raise ClipError(f"Không chạy được ffmpeg: {exc}") from exc

        deadline = time.time() + 900
        while process.poll() is None:
            if cancel():
                process.kill()
                try:
                    process.communicate(timeout=10)
                except subprocess.SubprocessError:
                    pass
                if os.path.isfile(output):
                    try:
                        os.remove(output)
                    except OSError:
                        pass
                raise ClipCancelled("Đã huỷ theo yêu cầu.")
            if time.time() > deadline:
                process.kill()
                try:
                    process.communicate(timeout=10)
                except subprocess.SubprocessError:
                    pass
                raise ClipError("ffmpeg cắt clip quá thời gian cho phép.")
            time.sleep(0.5)
        _, stderr = process.communicate()
        returncode = process.returncode

    if returncode != 0 or not os.path.isfile(output):
        detail = (stderr or "").strip().splitlines()
        message = detail[-1] if detail else f"exit code {returncode}"
        raise ClipError(f"ffmpeg không tạo được clip: {message}")

    if os.path.getsize(output) < 10_000:
        raise ClipError("Clip tạo ra quá nhỏ, có thể video nguồn không hợp lệ.")

    return output


def cut_clips(
    source: str,
    clips: list[dict],
    output_dir: str,
    *,
    vertical: bool = True,
    progress: Callable[[int, int, dict], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> list[str]:
    os.makedirs(output_dir, exist_ok=True)
    outputs: list[str] = []
    for index, clip in enumerate(clips):
        if cancel and cancel():
            raise ClipCancelled("Đã huỷ theo yêu cầu.")
        output = os.path.join(output_dir, f"clip-{index + 1:02d}.mp4")
        cut_vertical_clip(
            source,
            output,
            float(clip["start"]),
            float(clip["end"]) - float(clip["start"]),
            vertical=vertical,
            cancel=cancel,
        )
        outputs.append(output)
        if progress:
            progress(index + 1, len(clips), clip)
    return outputs
