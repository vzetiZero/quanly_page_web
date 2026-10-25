"""Prompt builders for turning a video transcript into a newsroom article."""

from __future__ import annotations

LANGUAGE_NAMES = {
    "en": "English",
    "vi": "Vietnamese",
}

TONE_GUIDE = {
    "neutral": "neutral, factual and engaging, like a wire-service story with a human touch",
    "dramatic": "tense and vivid, but still factual and never sensationalist or misleading",
    "analytical": "measured and analytical, explaining context, legal or social implications",
}

LENGTH_RANGE = {
    "short": (450, 600),
    "standard": (750, 1000),
    "long": (1100, 1500),
}

MAX_TRANSCRIPT_CHARS = 42000

SYSTEM_PROMPT = """You are a senior editor for News247US, a US news site focused on true crime, police news and viral human-interest stories.
You turn a raw video transcript into an accurate, original, publishable news article.

Hard rules:
1. Use ONLY facts present in the provided metadata and transcript. Never invent names, ages, locations, dates, charges, verdicts, quotes or statistics.
2. When the source is unclear or a claim is unverified, attribute it carefully: "according to the clip", "in the video", "as described by the narrator".
3. Do not copy long passages verbatim. Rewrite in clean newsroom prose. Keep any direct quote to one or two sentences.
4. Never add an <iframe>, <img>, <script>, <style>, <h1> or a video embed. The publishing system adds the video and cover image.
5. Output a single valid JSON object. No markdown fences, no commentary before or after the JSON.

Editorial structure:
- Headline: specific and accurate, 55-70 characters, no ALL CAPS, no clickbait such as "you won't believe".
- Opening paragraph: 2-3 sentences covering who, what, when and why it matters.
- 3-5 subheads. Format every subhead EXACTLY as:
  <p><span style="font-size: 18pt;"><strong>Subhead text</strong></span></p>
- Body paragraphs of 2-4 sentences. Include at least one short direct quote from the transcript inside <blockquote>...</blockquote>, with attribution in the surrounding sentence.
- Closing paragraph that puts the story in context without moralizing.
- Do not use markdown. Only simple HTML tags: p, span, strong, em, blockquote, ul, ol, li, br.
"""


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "..."


def build_article_prompt(
    metadata: dict,
    transcript_text: str,
    options: dict,
    categories: list[dict] | None = None,
) -> tuple[str, str]:
    language = options.get("language", "en")
    language_name = LANGUAGE_NAMES.get(language, "English")
    tone = options.get("tone", "neutral")
    tone_text = TONE_GUIDE.get(tone, TONE_GUIDE["neutral"])
    length = options.get("length", "standard")
    low, high = LENGTH_RANGE.get(length, LENGTH_RANGE["standard"])
    instructions = (options.get("instructions") or "").strip() or "None."
    category_names = [c.get("name", "") for c in (categories or []) if c.get("name")]
    category_line = ", ".join(category_names) if category_names else "not provided"

    duration = metadata.get("duration")
    if isinstance(duration, (int, float)) and duration > 0:
        minutes, seconds = divmod(int(duration), 60)
        duration_text = f"{minutes}m {seconds:02d}s"
    else:
        duration_text = "unknown"

    user_prompt = f"""VIDEO METADATA
Title: {metadata.get('title') or 'Unknown'}
Channel: {metadata.get('channel') or 'Unknown'}
Published: {metadata.get('upload_date') or 'Unknown'}
Duration: {duration_text}
URL: {metadata.get('webpage_url') or ''}
Description: {_clip(metadata.get('description') or '', 2500)}

SITE CATEGORIES (choose one name exactly, or an empty string): {category_line}

OUTPUT OPTIONS
Language: {language_name}
Tone: {tone_text}
Target length: {low}-{high} words
Extra instructions from the editor: {instructions}

TRANSCRIPT
{_clip(transcript_text, MAX_TRANSCRIPT_CHARS)}

Return a single JSON object with exactly these keys:
{{
  "title": "headline, 55-70 characters",
  "permalink": "short-kebab-case-slug-in-english",
  "seo_description": "meta description, 140-160 characters",
  "tags": ["4 to 8 short English tags"],
  "category": "one of the site categories above, or empty string",
  "key_points": ["3 to 5 factual bullet points"],
  "quotes": ["1 to 3 short direct quotes from the transcript"],
  "content_html": "full article body as HTML, without h1, img or iframe"
}}
"""
    return SYSTEM_PROMPT, user_prompt


def build_test_prompt() -> tuple[str, str]:
    system = "You are a health-check endpoint. Answer with JSON only."
    user = 'Return exactly this JSON object: {"ok": true, "message": "pong"}'
    return system, user


CLIP_SYSTEM_PROMPT = """You are a short-form video editor who turns long YouTube videos into Facebook Reels.
You receive a timestamped transcript. Pick the strongest self-contained moments and write the post copy.

Hard rules:
1. Use ONLY facts from the transcript. Never invent names, places, charges, quotes or outcomes.
2. Every clip must be 45-75 seconds long and must make sense without the rest of the video.
3. Clips must not overlap and must be ordered by start time.
4. Each title must be 40-80 characters, specific, and must NOT contain hashtags.
5. Each description must be 2-4 factual sentences that hook the viewer, without hashtags.
6. Output a single valid JSON object. No markdown fences, no commentary.
"""

MAX_TIMED_TRANSCRIPT_CHARS = 60000


def _format_timed_segments(segments: list[dict], limit: int) -> str:
    lines: list[str] = []
    used = 0
    for segment in segments or []:
        start = float(segment.get("start") or 0)
        minutes, seconds = divmod(int(start), 60)
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        line = f"[{minutes:02d}:{seconds:02d}] {text}"
        if used + len(line) > limit:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def build_clip_prompt(
    metadata: dict,
    segments: list[dict],
    options: dict,
) -> tuple[str, str]:
    language = options.get("language", "en")
    language_name = LANGUAGE_NAMES.get(language, "English")
    count = int(options.get("clipCount") or 5)
    min_seconds = int(options.get("minSeconds") or 45)
    max_seconds = int(options.get("maxSeconds") or 75)

    duration = metadata.get("duration")
    if isinstance(duration, (int, float)) and duration > 0:
        minutes, seconds = divmod(int(duration), 60)
        duration_text = f"{minutes}m {seconds:02d}s ({int(duration)} seconds)"
    else:
        duration_text = "unknown"

    timed_text = _format_timed_segments(segments, MAX_TIMED_TRANSCRIPT_CHARS)

    user_prompt = f"""VIDEO METADATA
Title: {metadata.get('title') or 'Unknown'}
Channel: {metadata.get('channel') or 'Unknown'}
Duration: {duration_text}
URL: {metadata.get('webpage_url') or ''}
Description: {_clip(metadata.get('description') or '', 1200)}

TASK
Choose exactly {count} non-overlapping highlight clips. Each clip must be between
{min_seconds} and {max_seconds} seconds long. Prefer complete stories, strong hooks,
conflict, reveals or emotional peaks. Do not start in the middle of a sentence.

Write all titles and descriptions in {language_name}.

TIMESTAMPED TRANSCRIPT
{timed_text}

Return a single JSON object with exactly this shape:
{{
  "clips": [
    {{
      "start": 0,
      "end": 60,
      "title": "specific 40-80 character title without hashtags",
      "description": "2-4 factual sentences without hashtags",
      "reason": "why this moment works in one short sentence"
    }}
  ]
}}
"""
    return CLIP_SYSTEM_PROMPT, user_prompt
