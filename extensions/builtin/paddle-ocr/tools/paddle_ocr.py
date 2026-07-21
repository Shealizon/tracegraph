import json
import os
import sys
import tempfile
import time
from pathlib import Path

import requests
from pypdf import PdfReader, PdfWriter

JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
MODEL = "PaddleOCR-VL-1.5"
WORKSPACE = Path(os.environ["TRACEGRAPH_WORKSPACE"]).resolve()


def source(value):
    target = (WORKSPACE / str(value).replace("\\", "/").lstrip("/")).resolve()
    if WORKSPACE not in target.parents or not target.is_file():
        raise FileNotFoundError(str(value))
    return target


def page_indices(spec, total):
    selected = set()
    for raw in str(spec).split(","):
        part = raw.strip()
        if "-" in part:
            start, end = map(int, part.split("-", 1))
            selected.update(range(start - 1, end))
        else:
            selected.add(int(part) - 1)
    invalid = [index + 1 for index in selected if index < 0 or index >= total]
    if invalid:
        raise ValueError(f"pages out of range: {invalid}")
    return sorted(selected)


def selected_pdf(pdf, spec):
    reader = PdfReader(str(pdf))
    writer = PdfWriter()
    selected = page_indices(spec, len(reader.pages))
    for index in selected:
        writer.add_page(reader.pages[index])
    handle = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    handle.close()
    writer.write(handle.name)
    return Path(handle.name), [index + 1 for index in selected]


def submit(file, token):
    with file.open("rb") as handle:
        response = requests.post(
            JOB_URL,
            headers={"Authorization": f"bearer {token}"},
            data={"model": MODEL, "optionalPayload": json.dumps({
                "useDocOrientationClassify": False,
                "useDocUnwarping": False,
                "useChartRecognition": False
            })},
            files={"file": handle},
            timeout=120
        )
    response.raise_for_status()
    return response.json()["data"]["jobId"]


def wait(job_id, token):
    for _ in range(120):
        response = requests.get(f"{JOB_URL}/{job_id}", headers={"Authorization": f"bearer {token}"}, timeout=30)
        response.raise_for_status()
        data = response.json()["data"]
        if data["state"] == "done":
            return data["resultUrl"]["jsonUrl"]
        if data["state"] == "failed":
            raise RuntimeError(data.get("errorMsg", "OCR failed"))
        time.sleep(5)
    raise TimeoutError("OCR job timed out")


def fetch(url):
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    output = []
    for line in response.text.splitlines():
        if not line.strip():
            continue
        parsed = json.loads(line)
        for item in parsed["result"]["layoutParsingResults"]:
            output.append({
                "markdown": item["markdown"]["text"],
                "images": list(item["markdown"]["images"].values())
            })
    return output


def main():
    payload = json.load(sys.stdin)
    token = os.environ.get("PADDLEOCR_TOKEN", "")
    if not token:
        raise RuntimeError("PADDLEOCR_TOKEN is not configured")
    pdf = source(payload["args"]["file"])
    temporary = None
    original_pages = None
    try:
        if payload["args"].get("pages") and pdf.suffix.lower() == ".pdf":
            temporary, original_pages = selected_pdf(pdf, payload["args"]["pages"])
            pdf = temporary
        results = fetch(wait(submit(pdf, token), token))
        pages = []
        for index, result in enumerate(results):
            pages.append({
                "page": original_pages[index] if original_pages and index < len(original_pages) else index + 1,
                **result
            })
        print(json.dumps({"ok": True, "file": payload["args"]["file"], "pages": pages}, ensure_ascii=False))
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
