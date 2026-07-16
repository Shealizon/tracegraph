import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter

TOKEN_RE = re.compile(r"[A-Za-z0-9_]{2,}|[\u3400-\u9fff]")
WORKSPACE = Path(os.environ["PAPER_GRAPH_WORKSPACE"]).resolve()
OUTPUT = Path(os.environ["PAPER_GRAPH_OUTPUT"]).resolve()
DATA = Path(os.environ["PAPER_GRAPH_EXTENSION_DATA"]).resolve()


def inside(root, value):
    target = (root / str(value).replace("\\", "/").lstrip("/")).resolve()
    if target != root and root not in target.parents:
        raise ValueError("path escapes workspace")
    return target


def source(value):
    target = inside(WORKSPACE, value)
    if not target.is_file():
        raise FileNotFoundError(str(value))
    return target


def destination(value, default):
    requested = str(value or default).replace("\\", "/").lstrip("/")
    name = Path(requested).name
    target = inside(OUTPUT, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target, f"generated/{name}"


def artifact(target, workspace_path, mime="application/pdf"):
    return {"path": target.name, "workspacePath": workspace_path, "name": target.name, "type": mime}


def pages(spec, total):
    if not spec or str(spec).lower() == "all":
        return list(range(total))
    selected = set()
    for raw in str(spec).split(","):
        part = raw.strip()
        if "-" in part:
            start, end = map(int, part.split("-", 1))
            if start > end:
                raise ValueError(f"descending page range: {part}")
            selected.update(range(start - 1, end))
        else:
            selected.add(int(part) - 1)
    invalid = [index + 1 for index in selected if index < 0 or index >= total]
    if invalid:
        raise ValueError(f"pages out of range 1-{total}: {invalid}")
    return sorted(selected)


def texts(pdf, page_spec="all"):
    reader = PdfReader(str(pdf))
    result = []
    for index in pages(page_spec, len(reader.pages)):
        text = reader.pages[index].extract_text() or ""
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        result.append({"page": index + 1, "text": text})
    return result, len(reader.pages)


def sha256(pdf):
    digest = hashlib.sha256()
    with pdf.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tokenize(text):
    return [token.lower() for token in TOKEN_RE.findall(text)]


def chunks(page, text):
    output = []
    for paragraph in [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]:
        words = paragraph.split()
        if len(words) <= 140 and len(paragraph) <= 1200:
            output.append({"page": page, "text": paragraph})
        elif len(words) > 1:
            for start in range(0, len(words), 110):
                piece = " ".join(words[start:start + 140])
                if piece:
                    output.append({"page": page, "text": piece})
                if start + 140 >= len(words):
                    break
        else:
            for start in range(0, len(paragraph), 750):
                output.append({"page": page, "text": paragraph[start:start + 900]})
                if start + 900 >= len(paragraph):
                    break
    return output


def build_index(pdf):
    DATA.mkdir(parents=True, exist_ok=True)
    digest = sha256(pdf)
    index_path = DATA / f"{digest[:24]}.json"
    if index_path.is_file():
        data = json.loads(index_path.read_text(encoding="utf-8"))
        if data.get("sha256") == digest:
            return data, True
    page_values, total = texts(pdf)
    all_chunks = []
    low = []
    for item in page_values:
        if len(re.sub(r"\s", "", item["text"])) < 30:
            low.append(item["page"])
        all_chunks.extend(chunks(item["page"], item["text"]))
    data = {"schema": 1, "sha256": digest, "name": pdf.name, "pages": total, "low_text_pages": low, "chunks": all_chunks}
    index_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data, False


def search_index(data, query, top_k):
    documents = [tokenize(item["text"]) for item in data["chunks"]]
    if not documents:
        return []
    df = Counter()
    for tokens in documents:
        df.update(set(tokens))
    avg = sum(map(len, documents)) / len(documents)
    terms = set(tokenize(query))
    scored = []
    for index, tokens in enumerate(documents):
        frequencies = Counter(tokens)
        score = 0.0
        for term in terms:
            frequency = frequencies.get(term, 0)
            if not frequency:
                continue
            idf = math.log(1 + (len(documents) - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * frequency * 2.5 / (frequency + 1.5 * (0.25 + 0.75 * len(tokens) / max(avg, 1)))
        if score > 0:
            scored.append((score, index))
    scored.sort(reverse=True)
    return [
        {"page": data["chunks"][index]["page"], "chunk_id": index, "score": round(score, 4), "text": data["chunks"][index]["text"]}
        for score, index in scored[:top_k]
    ]


def image_bytes(image, opacity):
    from PIL import Image
    with Image.open(image) as value:
        rgba = value.convert("RGBA")
        if opacity < 1:
            rgba.putalpha(rgba.getchannel("A").point(lambda alpha: round(alpha * opacity)))
        buffer = BytesIO()
        rgba.save(buffer, "PNG")
        return buffer.getvalue(), rgba.width, rgba.height


def execute(action, args):
    if action == "info":
        pdf = source(args["file"])
        reader = PdfReader(str(pdf))
        meta = reader.metadata or {}
        return {"file": args["file"], "pages": len(reader.pages), "size_bytes": pdf.stat().st_size, "metadata": {key[1:].lower(): str(value) for key, value in meta.items()}}
    if action == "extract_text":
        values, total = texts(source(args["file"]), args.get("pages", "all"))
        low = [item["page"] for item in values if len(re.sub(r"\s", "", item["text"])) < 30]
        return {"file": args["file"], "pageCount": total, "pages": values, "low_text_pages": low}
    if action in ("parse", "search"):
        data, cached = build_index(source(args["file"]))
        if action == "parse":
            return {"file": args["file"], "pages": data["pages"], "chunks": len(data["chunks"]), "low_text_pages": data["low_text_pages"], "cached": cached}
        return {"file": args["file"], "query": args["query"], "results": search_index(data, args["query"], max(1, min(20, int(args.get("top_k", 5)))))}
    if action == "render":
        import fitz
        pdf = source(args["file"])
        document = fitz.open(str(pdf))
        selected = pages(args.get("pages", "all"), len(document))
        artifacts = []
        for index in selected:
            target, workspace_path = destination(f"{pdf.stem}-page-{index + 1:03d}.png", "")
            document[index].get_pixmap(dpi=max(72, min(600, int(args.get("dpi", 200)))), alpha=False).save(str(target))
            artifacts.append(artifact(target, workspace_path, "image/png"))
        document.close()
        return {"pages": [index + 1 for index in selected], "artifacts": artifacts}
    if action == "merge":
        files = [source(value) for value in args["files"]]
        target, workspace_path = destination(args.get("output"), "merged.pdf")
        writer = PdfWriter()
        for pdf in files:
            for page in PdfReader(str(pdf)).pages:
                writer.add_page(page)
        writer.write(str(target))
        return {"pages": len(writer.pages), "sources": len(files), "artifacts": [artifact(target, workspace_path)]}
    if action in ("extract_pages", "rotate", "remove_pages"):
        pdf = source(args["file"])
        reader = PdfReader(str(pdf))
        selected = set(pages(args.get("pages", "all"), len(reader.pages)))
        default = {"extract_pages": "extracted.pdf", "rotate": "rotated.pdf", "remove_pages": "pages-removed.pdf"}[action]
        target, workspace_path = destination(args.get("output"), default)
        writer = PdfWriter()
        for index, page in enumerate(reader.pages):
            if action == "extract_pages" and index not in selected:
                continue
            if action == "remove_pages" and index in selected:
                continue
            if action == "rotate" and index in selected:
                page.rotate(int(args["angle"]))
            writer.add_page(page)
        if not writer.pages:
            raise ValueError("output PDF would contain no pages")
        writer.write(str(target))
        return {"pages": len(writer.pages), "artifacts": [artifact(target, workspace_path)]}
    if action == "split":
        reader = PdfReader(str(source(args["file"])))
        artifacts = []
        for index, page in enumerate(reader.pages, 1):
            target, workspace_path = destination(f"page-{index:03d}.pdf", "")
            writer = PdfWriter()
            writer.add_page(page)
            writer.write(str(target))
            artifacts.append(artifact(target, workspace_path))
        return {"pages": len(artifacts), "artifacts": artifacts}
    if action == "insert_pages":
        target_reader = PdfReader(str(source(args["file"])))
        source_reader = PdfReader(str(source(args["source"])))
        position = int(args["position"]) - 1
        if position < 0 or position > len(target_reader.pages):
            raise ValueError("insert position out of range")
        selected = pages(args.get("pages", "all"), len(source_reader.pages))
        target, workspace_path = destination(args.get("output"), "pages-inserted.pdf")
        writer = PdfWriter()
        for index in range(len(target_reader.pages) + 1):
            if index == position:
                for page_index in selected:
                    writer.add_page(source_reader.pages[page_index])
            if index < len(target_reader.pages):
                writer.add_page(target_reader.pages[index])
        writer.write(str(target))
        return {"pages": len(writer.pages), "inserted": len(selected), "artifacts": [artifact(target, workspace_path)]}
    if action in ("add_image", "watermark"):
        import fitz
        pdf = source(args["file"])
        image = source(args["image"])
        target, workspace_path = destination(args.get("output"), "image-added.pdf" if action == "add_image" else "watermarked.pdf")
        document = fitz.open(str(pdf))
        opacity = float(args.get("opacity", 1 if action == "add_image" else 0.2))
        stream, pixel_width, pixel_height = image_bytes(image, opacity)
        targets = [int(args.get("page", 1)) - 1] if action == "add_image" else list(range(len(document)))
        for index in targets:
            if index < 0 or index >= len(document):
                raise ValueError("page out of range")
            page = document[index]
            if action == "add_image":
                width = float(args.get("width", min(page.rect.width * 0.4, pixel_width)))
                x, y = float(args.get("x", 0)), float(args.get("y", 0))
            else:
                width = page.rect.width * float(args.get("width_ratio", 0.45))
                x = (page.rect.width - width) / 2
                y = (page.rect.height - width * pixel_height / pixel_width) / 2
            height = width * pixel_height / pixel_width
            rect = fitz.Rect(x, y, x + width, y + height)
            if not page.rect.contains(rect):
                raise ValueError("image rectangle falls outside page")
            page.insert_image(rect, stream=stream, overlay=True)
        document.save(str(target), garbage=4, deflate=True)
        count = len(document)
        document.close()
        return {"pages": count, "artifacts": [artifact(target, workspace_path)]}
    if action == "create_text":
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfgen import canvas
        text = str(args.get("text", ""))
        if not text and args.get("source"):
            text = source(args["source"]).read_text(encoding="utf-8")
        if not text:
            raise ValueError("text or source is required")
        target, workspace_path = destination(args.get("output"), "document.pdf")
        pdf = canvas.Canvas(str(target), pagesize=A4)
        pdf.setTitle(str(args.get("title", "Document")))
        width, height = A4
        cjk = bool(re.search(r"[\u3400-\u9fff]", text))
        font = "STSong-Light" if cjk else "Helvetica"
        if cjk:
            pdfmetrics.registerFont(UnicodeCIDFont(font))
        pdf.setFont(font, 10.5)
        y = height - 54
        for line in text.splitlines():
            line_width = 48 if cjk else 82
            for start in range(0, max(1, len(line)), line_width):
                if y < 70:
                    pdf.showPage()
                    pdf.setFont(font, 10.5)
                    y = height - 54
                pdf.drawString(54, y, line[start:start + line_width])
                y -= 15
        pdf.save()
        return {"pages": len(PdfReader(str(target)).pages), "artifacts": [artifact(target, workspace_path)]}
    raise ValueError(f"unknown action: {action}")


def main():
    payload = json.load(sys.stdin)
    try:
        result = execute(payload["action"], payload.get("args", {}))
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        raise


if __name__ == "__main__":
    main()
