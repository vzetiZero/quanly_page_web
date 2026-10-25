"""Minimal Gemini client that supports both Google native and OpenAI-compatible APIs."""

from __future__ import annotations

import json
import re
import time
from typing import Any
from urllib.parse import quote

import httpx

DEFAULT_GOOGLE_BASE = "https://generativelanguage.googleapis.com"
DEFAULT_MODEL = "gemini-2.5-flash"


class AIError(Exception):
    """Raised when the configured LLM endpoint fails or returns unusable data."""


def resolve_style(ai: dict) -> str:
    style = (ai.get("apiStyle") or "auto").strip().lower()
    if style in ("google", "openai"):
        return style
    base = (ai.get("baseUrl") or DEFAULT_GOOGLE_BASE).lower()
    return "google" if "generativelanguage.googleapis.com" in base else "openai"


def _google_url(base: str, model: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/v1beta"):
        base = base[: -len("/v1beta")]
    elif base.endswith("/v1"):
        base = base[: -len("/v1")]
    model = model.removeprefix("models/")
    return f"{base}/v1beta/models/{quote(model, safe='')}:generateContent"


def _openai_url(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _error_detail(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return response.text[:400]
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or error)
    if isinstance(data, dict) and data.get("message"):
        return str(data["message"])
    return json.dumps(data)[:400]


def parse_json_text(text: str) -> dict:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except ValueError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        candidate = cleaned[start : end + 1]
        candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except ValueError:
            pass
    raise AIError("AI không trả về JSON hợp lệ. Thử lại hoặc đổi model.")


def _google_payload(system: str, user: str, temperature: float, max_tokens: int) -> dict:
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        },
    }


def _openai_payload(
    model: str, system: str, user: str, temperature: float, max_tokens: int, json_mode: bool
) -> dict:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def _extract_google_text(data: dict) -> str:
    parts: list[str] = []
    for candidate in data.get("candidates") or []:
        content = candidate.get("content") or {}
        for part in content.get("parts") or []:
            if part.get("thought"):
                continue
            if part.get("text"):
                parts.append(part["text"])
    if parts:
        return "".join(parts)
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise AIError(f"Gemini chặn nội dung (lý do: {block}).")
    finish = (data.get("candidates") or [{}])[0].get("finishReason")
    raise AIError(f"Gemini không trả về nội dung (finishReason: {finish or 'unknown'}).")


def _extract_openai_text(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise AIError("Endpoint AI không trả về lựa chọn nào.")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    if not content:
        raise AIError("Endpoint AI trả về nội dung rỗng.")
    return str(content)


def generate_json(
    ai: dict,
    system: str,
    user: str,
    temperature: float = 0.7,
    max_tokens: int = 8192,
    timeout: float = 240.0,
) -> tuple[dict, dict]:
    """Return (parsed_json, meta) where meta has model/style/latency/usage."""
    api_key = (ai.get("apiKey") or "").strip()
    if not api_key:
        raise AIError("Chưa cấu hình API key cho Gemini/LLM. Mở Cài đặt để nhập.")

    base = (ai.get("baseUrl") or DEFAULT_GOOGLE_BASE).strip()
    model = (ai.get("model") or DEFAULT_MODEL).strip().removeprefix("models/")
    style = resolve_style(ai)
    started = time.time()

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if style == "google":
        url = _google_url(base, model)
        headers["x-goog-api-key"] = api_key
        payload = _google_payload(system, user, temperature, max_tokens)
    else:
        url = _openai_url(base)
        headers["Authorization"] = f"Bearer {api_key}"
        payload = _openai_payload(model, system, user, temperature, max_tokens, True)

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, headers=headers, json=payload)

            # Some gateways reject response_format; retry once as plain chat.
            if (
                style == "openai"
                and response.status_code == 400
                and "response_format" in response.text.lower()
            ):
                payload = _openai_payload(
                    model, system, user, temperature, max_tokens, False
                )
                response = client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise AIError(
            "Hết thời gian chờ AI. Video/transcript có thể quá dài hoặc endpoint chậm."
        ) from exc
    except httpx.HTTPError as exc:
        raise AIError(f"Không kết nối được endpoint AI: {exc}") from exc

    if response.status_code >= 400:
        detail = _error_detail(response)
        if response.status_code in (401, 403):
            raise AIError(
                f"API key bị từ chối (HTTP {response.status_code}). "
                "Kiểm tra key và Base URL/kiểu API trong Cài đặt. Chi tiết: " + detail
            )
        if response.status_code == 404:
            raise AIError(
                f"Không tìm thấy endpoint/model (HTTP 404). Kiểm tra Base URL và tên model. "
                f"Chi tiết: {detail}"
            )
        raise AIError(f"AI trả về lỗi HTTP {response.status_code}: {detail}")

    try:
        data = response.json()
    except ValueError as exc:
        raise AIError("Endpoint AI trả về dữ liệu không phải JSON.") from exc

    text = _extract_google_text(data) if style == "google" else _extract_openai_text(data)
    parsed = parse_json_text(text)
    meta = {
        "model": model,
        "style": style,
        "latencyMs": int((time.time() - started) * 1000),
        "usage": data.get("usageMetadata") or data.get("usage") or {},
    }
    return parsed, meta


def test_connection(ai: dict) -> dict:
    from prompts import build_test_prompt

    system, user = build_test_prompt()
    parsed, meta = generate_json(
        ai, system, user, temperature=0.0, max_tokens=128, timeout=60.0
    )
    return {
        "ok": bool(parsed.get("ok")),
        "message": parsed.get("message", "pong"),
        "model": meta["model"],
        "style": meta["style"],
        "latencyMs": meta["latencyMs"],
    }
