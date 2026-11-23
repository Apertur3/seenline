"""Load documents for LangChain through Seenline.

Text a reader cannot see stays out of page_content's body and is listed under [Hidden in the original];
the entries also go in metadata, so a pipeline can hold back files that carry hidden instructions.

    pip install langchain-core
    python langchain_loader.py report.pdf
"""

import json
import subprocess
import sys

from langchain_core.documents import Document


def load(path: str) -> Document:
    run = subprocess.run(["npx", "-y", "seenline", "--json", "--", path], capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip())
    result = json.loads(run.stdout)
    return Document(
        page_content=result["markdown"],
        metadata={
            "source": path,
            "hidden": result["hidden"],
            "suspect": [h for h in result["hidden"] if h.get("suspect")],
        },
    )


if __name__ == "__main__":
    for path in sys.argv[1:]:
        doc = load(path)
        if doc.metadata["suspect"]:
            print(f"{path}: hidden text that reads like an instruction to an AI; held back")
            continue
        print(doc.page_content)
