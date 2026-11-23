"""Read documents for LlamaIndex through Seenline.

Text a reader cannot see stays out of the body and is listed under [Hidden in the original]. Metadata holds
counts only, so it stays small enough for vector stores; the full entries are in Seenline's --json output.

    pip install llama-index-core
    python llamaindex_reader.py report.pdf
"""

import json
import subprocess
import sys

from llama_index.core import Document


def read(path: str) -> Document:
    run = subprocess.run(["npx", "-y", "seenline", "--json", "--", path], capture_output=True, text=True)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip())
    result = json.loads(run.stdout)
    return Document(
        text=result["markdown"],
        metadata={
            "source": path,
            "hidden": len(result["hidden"]),
            "suspect": sum(1 for h in result["hidden"] if h.get("suspect")),
        },
    )


if __name__ == "__main__":
    docs = [read(path) for path in sys.argv[1:]]
    for doc in docs:
        print(doc.metadata)
