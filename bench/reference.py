"""Competitor adapters. Run in disposable uv environments by run-adapters.sh, never bundled.

usage: reference.py <candidate> <cache>   (reads <cache>/manifest.json and <cache>/input/)
Each file becomes <cache>/<candidate>/<file>.json with the text, a status, the seconds (median of REPS
runs) and the input checksum. A tool that cannot start writes <candidate>/not-run.json with the reason.
"""
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPS = int(os.environ.get("BENCH_REPS", "3"))
PDF = {".pdf"}
PAGES = re.compile(r"\n*\{(\d+)\}-{48}\n*")


def need_java():
    # a stub on the PATH does not count: the runtime has to start
    if not shutil.which("java") or subprocess.run(["java", "-version"], capture_output=True).returncode:
        raise RuntimeError("no Java runtime on this host")


def load(candidate, cache):
    """Return convert(path) -> text, or raise if the tool cannot run here."""
    if candidate == "markitdown":
        from markitdown import MarkItDown
        reader = MarkItDown(enable_plugins=False)
        return lambda path: reader.convert(str(path)).text_content
    if candidate == "docling":
        from docling.document_converter import DocumentConverter
        reader = DocumentConverter()

        def convert(path):
            doc = reader.convert(str(path)).document
            if path.suffix.lower() in {".pdf", ".png", ".jpg"}:
                return "\n".join(
                    f"[p. {page}]\n{doc.export_to_markdown(page_no=page)}" for page in sorted(doc.pages)
                )
            return doc.export_to_markdown()
        return convert
    if candidate == "unstructured":
        from unstructured.partition.auto import partition

        def convert(path):
            strategy = "ocr_only" if path.suffix.lower() in {".png", ".jpg", ".jpeg"} else "auto"
            elements = partition(filename=str(path), strategy=strategy, languages=["eng", "nld"])
            lines, previous = [], None
            for element in elements:
                page = element.metadata.page_number
                if page is not None and page != previous:
                    lines.append(f"[{'slide' if path.suffix.lower() == '.pptx' else 'p.'} {page}]")
                    previous = page
                lines.append(str(element))  # the stock representation
            return "\n".join(lines)
        return convert
    if candidate == "marker":
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.output import text_from_rendered
        reader = PdfConverter(artifact_dict=create_model_dict(), config={"paginate_output": True})

        def convert(path):
            text = text_from_rendered(reader(str(path)))[0]
            return PAGES.sub(lambda m: f"\n[p. {int(m.group(1)) + 1}]\n", text)
        return convert
    if candidate == "pymupdf4llm":
        import pymupdf4llm

        def convert(path):
            chunks = pymupdf4llm.to_markdown(str(path), page_chunks=True)
            return "\n".join(f"[p. {i}]\n{c['text']}" for i, c in enumerate(chunks, 1))
        return convert
    if candidate == "opendataloader":
        need_java()
        import opendataloader_pdf

        def convert(path):
            with tempfile.TemporaryDirectory() as out:
                opendataloader_pdf.convert(input_path=[str(path)], output_dir=out, format="markdown",
                                           quiet=True, markdown_page_separator="[p. %page-number%]")
                return next(Path(out).rglob("*.md")).read_text(encoding="utf-8")
        return convert
    if candidate == "tika":
        need_java()
        jar = cache / "tika" / "tika-app.jar"
        if not jar.exists():
            raise RuntimeError("tika-app.jar is not prepared; run `npm run bench -- prepare`")

        def convert(path):
            run = subprocess.run(["java", "-jar", str(jar), "-t", str(path)], capture_output=True,
                                 timeout=110, check=True)
            return run.stdout.decode("utf-8", "replace")
        return convert
    raise RuntimeError(f"unknown candidate {candidate}")


def expired(_signum, _frame):
    raise TimeoutError("conversion exceeded 120 seconds")


def version(candidate):
    dist = {"unstructured": "unstructured", "marker": "marker-pdf", "opendataloader": "opendataloader-pdf"}
    try:
        return importlib.metadata.version(dist.get(candidate, candidate))
    except importlib.metadata.PackageNotFoundError:
        return "3.3.3" if candidate == "tika" else "unknown"


def main():
    candidate, cache = sys.argv[1], Path(sys.argv[2])
    out = cache / candidate
    out.mkdir(exist_ok=True)
    (out / "not-run.json").unlink(missing_ok=True)
    started = time.perf_counter()
    try:
        convert = load(candidate, cache)
    except Exception as error:  # a missing runtime or failed install is a result, not a skip
        (out / "not-run.json").write_text(json.dumps({"reason": f"{type(error).__name__}: {error}"}))
        print(candidate, "not-run", error, flush=True)
        return
    (out / "environment.json").write_text(json.dumps({
        "candidate": candidate,
        "version": version(candidate),
        "date": time.strftime("%Y-%m-%d", time.gmtime()),
        "python": sys.version,
        "initialization_seconds": time.perf_counter() - started,
        "packages": sorted(f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()),
    }, indent=2))
    signal.signal(signal.SIGALRM, expired)
    spec = json.loads((Path(__file__).parent / "data" / "environment.json").read_text())["candidates"]
    formats = spec[candidate]["formats"]
    for entry in json.loads((cache / "manifest.json").read_text()):
        dest = out / (entry["file"] + ".json")
        # a resumed run keeps finished files; formats outside the tool's declared list are reported as such
        if dest.exists() or (formats != "*" and Path(entry["file"]).suffix[1:].lower() not in formats):
            continue
        path = cache / "input" / entry["file"]
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        if checksum != entry["sha256"]:
            raise ValueError(f"input mismatch: {path.name}")
        result, times = dict(text="", error="", status="ok", sha256=checksum), []
        for rep in range(REPS):
            began = time.perf_counter()
            signal.alarm(120)
            try:
                text = convert(path)
                if rep == 0:
                    result["text"] = text
            except Exception as error:
                result.update(status="error", error=f"{type(error).__name__}: {error}")
                break
            finally:
                signal.alarm(0)
                times.append(time.perf_counter() - began)
        result["seconds"] = statistics.median(times)
        temp = dest.with_suffix(".tmp")
        temp.write_text(json.dumps(result))
        temp.replace(dest)
        print(candidate, path.name, result["status"], round(result["seconds"], 3), flush=True)


if __name__ == "__main__":
    main()
