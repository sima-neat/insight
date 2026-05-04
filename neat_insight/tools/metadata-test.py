import sys
from pathlib import Path

if __name__ == "__main__" and (not globals().get("__package__")):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from neat_insight.tools.metadata_test import main


if __name__ == "__main__":
    main()
