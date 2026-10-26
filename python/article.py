"""Normalisation and sanitising of the AI-generated article."""

from __future__ import annotations

import difflib
import re
import unicodedata

import bleach
from bleach.css_sanitizer import CSSSanitizer


class ArticleError(Exception):
    pass


ALLOWED_TAGS = [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "span",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h2",
    "h3",
    "a",
]
ALLOWED_ATTRIBUTES = {
    "span": ["style"],
    "p": ["style"],
    "a": ["href", "title"],
}
CSS_SANITIZER = CSSSanitizer(
    allowed_css_properties=[
        "font-size",
        "font-weight",
        "font-style",
        "text-align",
        "color",
        "line-height",
    ]
)


def slugify(text: str, max_len: int = 80) -> str:
    value = (text or "").strip().lower().replace("đ", "d")
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value[:max_len].strip("-")


def _plain(html_text: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        bleach.clean(html_text or "", tags=[], attributes={}, strip=True),
    ).strip()


def _sanitize_html(raw: str) -> str:
    content = raw or ""
    content = re.sub(r"<script\b[^>]*>.*?</script>", "", content, flags=re.I | re.S)
    content = re.sub(r"<style\b[^>]*>.*?</style>", "", content, flags=re.I | re.S)
    content = re.sub(r"<iframe\b[^>]*>.*?</iframe>", "", content, flags=re.I | re.S)
    content = re.sub(r"<img\b[^>]*>", "", content, flags=re.I)
    content = re.sub(r"<h1\b[^>]*>(.*?)</h1>", r"\1", content, flags=re.I | re.S)

    def heading_to_style(match: re.Match) -> str:
        text = match.group(1).strip()
        return (
            '<p><span style="font-size: 18pt;"><strong>'
            f"{text}"
            "</strong></span></p>"
        )

    content = re.sub(r"<h2\b[^>]*>(.*?)</h2>", heading_to_style, content, flags=re.I | re.S)

    cleaned = bleach.clean(
        content,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=["http", "https"],
        strip=True,
        strip_comments=True,
        css_sanitizer=CSS_SANITIZER,
    )
    cleaned = re.sub(r"<p>\s*(<br\s*/?>)?\s*</p>", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    if cleaned and "<p" not in cleaned.lower():
        paragraphs = [part.strip() for part in re.split(r"\n{2,}", _plain(cleaned)) if part.strip()]
        cleaned = "".join(f"<p>{bleach.clean(p, tags=[], strip=True)}</p>" for p in paragraphs)
    return cleaned


def _clean_tag(tag: str) -> str:
    tag = re.sub(r"^#+", "", str(tag or "")).strip()
    tag = re.sub(r"\s+", " ", tag)
    return tag[:40]


TAG_STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "about",
    "into",
    "over",
}


def _tag_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", slugify(text, max_len=120))


def _tag_words(text: str) -> list[str]:
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(text or ""))
    return [
        word.lower()
        for word in re.split(r"[^A-Za-z0-9]+", spaced)
        if len(word) >= 3
    ]


def _match_existing_tag(tag: str, entries: list[tuple[str, str, str]]) -> str:
    """Map one AI-written tag to the closest tag that exists on the site."""
    folded = tag.casefold()
    key = _tag_key(tag)
    for name, name_key, compact in entries:
        if folded == name_key or key == compact:
            return name

    if len(key) >= 4:
        contained = {
            name
            for name, _, compact in entries
            if len(compact) >= 4 and (key in compact or compact in key)
        }
        if len(contained) == 1:
            return contained.pop()

    close = difflib.get_close_matches(
        key, [compact for _, _, compact in entries], n=1, cutoff=0.88
    )
    if close:
        for name, _, compact in entries:
            if compact == close[0]:
                return name
    return ""


def _context_tags(text: str, available: list[str], limit: int) -> list[str]:
    """Pick site tags whose every word appears in the article text."""
    haystack = " " + re.sub(r"[^a-z0-9]+", " ", _plain(text).lower()) + " "
    scored: list[tuple[int, int, str]] = []
    for name in available:
        words = [word for word in _tag_words(name) if word not in TAG_STOPWORDS]
        if not words:
            continue
        if all(f" {word} " in haystack for word in words):
            scored.append((len(words), 0, name))
    scored.sort(reverse=True)
    return [name for _, _, name in scored[:limit]]


def _resolve_tags(
    raw_tags: list[str],
    site_tags: list[str] | None,
    context_text: str,
    limit: int = 5,
) -> list[str]:
    """Keep only tags that exist on the site; never leave AI-invented tags."""
    available = [str(tag).strip() for tag in (site_tags or []) if str(tag).strip()]
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw_tags:
        tag = _clean_tag(item)
        key = tag.casefold()
        if tag and key not in seen:
            seen.add(key)
            cleaned.append(tag)

    if not available:
        return cleaned[:limit]

    entries = [
        (name, name.casefold(), _tag_key(name))
        for name in available
        if _tag_key(name)
    ]
    resolved: list[str] = []
    chosen: set[str] = set()
    for tag in cleaned:
        match = _match_existing_tag(tag, entries)
        if match and match.casefold() not in chosen:
            chosen.add(match.casefold())
            resolved.append(match)
        if len(resolved) >= limit:
            return resolved

    if len(resolved) < min(2, limit):
        for candidate in _context_tags(context_text, available, limit):
            if candidate.casefold() in chosen:
                continue
            chosen.add(candidate.casefold())
            resolved.append(candidate)
            if len(resolved) >= min(2, limit):
                break
    return resolved[:limit]


def _match_category(value: str, categories: list[dict]) -> tuple[str, int | None]:
    if not value:
        return "", None
    target = slugify(value)
    for category in categories or []:
        name = str(category.get("name") or "")
        if slugify(name) == target:
            return name, category.get("id")
    for category in categories or []:
        name = str(category.get("name") or "")
        normalized = slugify(name)
        if normalized and (normalized in target or target in normalized):
            return name, category.get("id")
    return "", None


def normalize_article(
    raw: dict,
    metadata: dict,
    options: dict,
    categories: list[dict] | None = None,
    site_tags: list[str] | None = None,
) -> dict:
    warnings: list[str] = []
    categories = categories or []

    title = re.sub(r"\s+", " ", str(raw.get("title") or metadata.get("title") or "")).strip()
    title = title.strip("\"'“”")
    if not title:
        raise ArticleError("AI không tạo được tiêu đề.")
    if len(title) > 110:
        title = title[:107].rsplit(" ", 1)[0] + "..."
        warnings.append("Tiêu đề quá dài và đã được rút gọn.")

    content = _sanitize_html(str(raw.get("content_html") or ""))
    word_count = len(_plain(content).split())
    if not content or word_count < 50:
        raise ArticleError("AI trả về nội dung bài viết rỗng hoặc quá ngắn.")
    if word_count < 250:
        warnings.append(f"Bài viết khá ngắn ({word_count} từ). Cân nhắc viết lại dài hơn.")

    seo = re.sub(r"\s+", " ", str(raw.get("seo_description") or "")).strip()
    if len(seo) > 160:
        seo = seo[:157].rsplit(" ", 1)[0] + "..."
    if len(seo) < 70:
        fallback = _plain(content)
        seo = fallback[:157].rsplit(" ", 1)[0] + "..."
        warnings.append("Mô tả SEO được tạo tự động từ nội dung.")

    permalink = slugify(str(raw.get("permalink") or title))
    if not permalink:
        raise ArticleError("Không tạo được permalink.")
    if len(permalink) > 75:
        permalink = permalink[:75].strip("-")

    raw_tags = raw.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = re.split(r"[,;]", raw_tags)
    tags = _resolve_tags(
        list(raw_tags),
        site_tags,
        f"{title}\n{_plain(content)[:6000]}",
    )

    category, category_id = _match_category(str(raw.get("category") or ""), categories)
    if not category:
        warnings.append("AI không chọn được danh mục khớp với website.")

    def _string_list(value, limit: int) -> list[str]:
        if isinstance(value, str):
            value = [value]
        result = []
        for item in value or []:
            text = re.sub(r"\s+", " ", str(item or "")).strip()
            if text:
                result.append(text)
            if len(result) >= limit:
                break
        return result

    return {
        "title": title,
        "permalink": permalink,
        "seo_description": seo,
        "tags": tags,
        "category": category,
        "category_id": category_id,
        "key_points": _string_list(raw.get("key_points"), 5),
        "quotes": _string_list(raw.get("quotes"), 3),
        "content_html": content,
        "word_count": word_count,
        "language": options.get("language", "en"),
        "warnings": warnings,
    }
