import fnmatch
import mimetypes
import os
import stat
import tarfile
import threading
import time
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file


workspace_bp = Blueprint("workspace", __name__)

TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024
TEXT_SNIFF_LIMIT = 4096
INDEX_TTL_SEC = 3.0
MAX_SEARCH_RESULTS = 200
ARCHIVE_SEPARATOR = "::"

IGNORE_NAMES = {
    ".cache",
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".svn",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
IGNORE_PATTERNS = {
    "*.egg-info",
}

CODE_EXTENSIONS = {
    ".bash",
    ".c",
    ".cc",
    ".cfg",
    ".cmake",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".cu",
    ".cuh",
    ".go",
    ".h",
    ".hh",
    ".hpp",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".lua",
    ".m",
    ".md",
    ".mm",
    ".php",
    ".proto",
    ".py",
    ".rs",
    ".scala",
    ".sh",
    ".sql",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
CODE_FILENAMES = {
    ".babelrc",
    ".clang-format",
    ".clang-tidy",
    ".dockerignore",
    ".editorconfig",
    ".env",
    ".gitattributes",
    ".gitignore",
    ".gitmodules",
    ".npmrc",
    ".prettierrc",
    ".pylintrc",
    "brewfile",
    "cmakelists.txt",
    "containerfile",
    "dockerfile",
    "gemfile",
    "jenkinsfile",
    "justfile",
    "makefile",
    "manifest.in",
    "procfile",
    "rakefile",
    "vagrantfile",
}
CODE_FILENAME_PREFIXES = (
    ".env.",
    "containerfile.",
    "dockerfile.",
    "makefile.",
)
MODEL_EXTENSIONS = {
    ".lm",
    ".mlir",
    ".onnx",
    ".pb",
    ".tflite",
}
IMAGE_EXTENSIONS = {
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
}

TEXT_BYTES = frozenset(b"\n\r\t\f\b" + bytes(range(32, 127)))


def _workspace_root() -> Path:
    workspace = Path("/workspace")
    if workspace.exists() and workspace.is_dir():
        return workspace.resolve()
    return Path.cwd().resolve()


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _should_ignore(path: Path) -> bool:
    name = path.name
    if name in IGNORE_NAMES:
        return True
    return any(fnmatch.fnmatch(name, pattern) for pattern in IGNORE_PATTERNS)


def _relative_path(path: Path, root: Path) -> str:
    rel = path.relative_to(root).as_posix()
    return "" if rel == "." else rel


def _resolve_workspace_path(rel_path: str = "") -> Path:
    root = _workspace_root()
    candidate = (root / (rel_path or "")).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("Path is outside the workspace root.")
    return candidate


def _is_mpk_archive_name(name: str) -> bool:
    return name.lower().endswith("_mpk.tar.gz")


def _is_mpk_archive_path(path: Path) -> bool:
    return path.is_file() and _is_mpk_archive_name(path.name)


def _split_virtual_path(rel_path: str):
    if ARCHIVE_SEPARATOR not in rel_path:
        return rel_path, ""
    archive_rel, member_path = rel_path.split(ARCHIVE_SEPARATOR, 1)
    return archive_rel, _clean_archive_member_path(member_path)


def _clean_archive_member_path(member_path: str) -> str:
    parts = []
    for part in member_path.replace("\\", "/").split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            raise ValueError("Archive path is outside the package root.")
        parts.append(part)
    return "/".join(parts)


def _archive_display_path(archive_rel: str, member_path: str = "") -> str:
    if not member_path:
        return archive_rel
    return f"{archive_rel}{ARCHIVE_SEPARATOR}{member_path}"


def _resolve_archive_path(rel_path: str):
    archive_rel, member_path = _split_virtual_path(rel_path)
    archive_path = _resolve_workspace_path(archive_rel)
    if not archive_path.exists():
        raise FileNotFoundError("Path not found.")
    if not _is_mpk_archive_path(archive_path):
        raise NotADirectoryError("Path is not an MPK package.")
    return archive_path, archive_rel, member_path


def _safe_tar_members(archive_path: Path):
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            try:
                clean_name = _clean_archive_member_path(member.name)
            except ValueError:
                continue
            if not clean_name:
                continue
            yield member, clean_name


def _workspace_kind_for_name(name: str, is_dir: bool = False, mode=None) -> str:
    if is_dir:
        return "folder"

    clean_name = Path(name).name.lower()
    ext = Path(clean_name).suffix.lower()
    if ext in MODEL_EXTENSIONS:
        return "model"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if clean_name in CODE_FILENAMES or any(clean_name.startswith(prefix) for prefix in CODE_FILENAME_PREFIXES):
        return "code"
    if ext in CODE_EXTENSIONS:
        return "code"

    mime_type, _ = mimetypes.guess_type(clean_name)
    if mime_type and mime_type.startswith("text/"):
        return "text"

    if mode is not None and mode & stat.S_IXUSR:
        return "executable"

    return "binary"


def _workspace_kind(path: Path) -> str:
    if _is_mpk_archive_path(path):
        return "archive"

    kind = _workspace_kind_for_name(path.name, is_dir=path.is_dir())
    if kind != "binary":
        return kind

    if _looks_like_text_file(path):
        return "text"

    try:
        mode = path.stat().st_mode
        if mode & stat.S_IXUSR:
            return "executable"
    except OSError:
        # If metadata cannot be read (e.g., permissions/race), fall back to binary.
        return "binary"

    return "binary"


def _looks_like_text_file(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            data = handle.read(TEXT_SNIFF_LIMIT)
    except OSError:
        return False

    if not data:
        return True
    if b"\x00" in data:
        return False

    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        pass

    non_text = sum(1 for byte in data if byte not in TEXT_BYTES)
    return non_text / len(data) < 0.08


def _node_for(path: Path, root: Path):
    try:
        st = path.stat()
    except OSError:
        return None

    node_type = "folder" if path.is_dir() or _is_mpk_archive_path(path) else "file"
    return {
        "name": path.name or root.name,
        "path": _relative_path(path, root),
        "type": node_type,
        "kind": _workspace_kind(path),
        "size": 0 if path.is_dir() else st.st_size,
        "mtime": st.st_mtime,
    }


def _node_sort_group(node) -> int:
    if node["type"] == "folder" and node["kind"] != "archive":
        return 0
    if node["kind"] == "archive":
        return 1
    return 2


def _archive_member_node(archive_rel: str, member_path: str, member, is_dir: bool = False):
    name = member_path.rsplit("/", 1)[-1]
    kind = _workspace_kind_for_name(name, is_dir=is_dir, mode=getattr(member, "mode", None))
    return {
        "name": name,
        "path": _archive_display_path(archive_rel, member_path),
        "type": "folder" if is_dir else "file",
        "kind": kind,
        "size": 0 if is_dir else getattr(member, "size", 0),
        "mtime": getattr(member, "mtime", 0),
        "virtual": True,
    }


class WorkspaceIndex:
    def __init__(self):
        self._lock = threading.Lock()
        self._root = None
        self._built_at = 0.0
        self._items = []

    def items(self):
        root = _workspace_root()
        now = time.monotonic()
        with self._lock:
            if self._root != root or now - self._built_at > INDEX_TTL_SEC:
                self._items = self._scan(root)
                self._root = root
                self._built_at = now
            return list(self._items)

    def _scan(self, root: Path):
        items = []
        for current, dirs, files in os.walk(root):
            current_path = Path(current)
            dirs[:] = sorted(
                [name for name in dirs if not _should_ignore(current_path / name)],
                key=str.lower,
            )

            for file_name in sorted(files, key=str.lower):
                path = current_path / file_name
                if _should_ignore(path):
                    continue
                node = _node_for(path, root)
                if node:
                    node["basename"] = file_name.lower()
                    node["path_lc"] = node["path"].lower()
                    items.append(node)
        return items


workspace_index = WorkspaceIndex()


@workspace_bp.get("/api/workspace/root")
def workspace_root():
    root = _workspace_root()
    workspace_dir = Path("/workspace")
    has_workspace_dir = workspace_dir.exists() and root == workspace_dir.resolve()
    return {
        "name": root.name or str(root),
        "path": str(root),
        "hasWorkspaceDir": has_workspace_dir,
    }


@workspace_bp.get("/api/workspace/tree")
def workspace_tree():
    rel_path = request.args.get("path", "")
    if ARCHIVE_SEPARATOR in rel_path:
        return _workspace_archive_tree(rel_path)

    try:
        folder = _resolve_workspace_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)

    if not folder.exists():
        return _json_error("Path not found.", 404)
    if _is_mpk_archive_path(folder):
        return _workspace_archive_tree(rel_path)
    if not folder.is_dir():
        return _json_error("Path is not a folder.", 400)

    root = _workspace_root()
    nodes = []
    try:
        children = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as exc:
        return _json_error(str(exc), 500)

    for child in children:
        if _should_ignore(child):
            continue
        node = _node_for(child, root)
        if node:
            nodes.append(node)

    return {"path": _relative_path(folder, root), "children": nodes}


def _workspace_archive_tree(rel_path: str):
    try:
        archive_path, archive_rel, prefix = _resolve_archive_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except (NotADirectoryError, tarfile.TarError) as exc:
        return _json_error(str(exc), 400)

    prefix_with_slash = f"{prefix}/" if prefix else ""
    children = {}
    try:
        for member, member_path in _safe_tar_members(archive_path):
            if prefix and member_path == prefix:
                continue
            if prefix and not member_path.startswith(prefix_with_slash):
                continue

            rest = member_path[len(prefix_with_slash):] if prefix else member_path
            if not rest:
                continue
            child_name = rest.split("/", 1)[0]
            child_path = f"{prefix_with_slash}{child_name}" if prefix else child_name
            is_dir = "/" in rest or member.isdir()

            existing = children.get(child_path)
            if existing and existing["type"] == "folder":
                continue
            children[child_path] = _archive_member_node(archive_rel, child_path, member, is_dir=is_dir)
    except tarfile.TarError as exc:
        return _json_error(str(exc), 400)
    except OSError as exc:
        return _json_error(str(exc), 500)

    sorted_children = sorted(children.values(), key=lambda node: (_node_sort_group(node), node["name"].lower()))
    return {
        "path": _archive_display_path(archive_rel, prefix),
        "archive": archive_rel,
        "children": sorted_children,
    }


def _score_match(query: str, item) -> int:
    basename = item["basename"]
    path_lc = item["path_lc"]
    if basename == query:
        return 1000
    if basename.startswith(query):
        return 800
    if query in basename:
        return 600
    if path_lc.startswith(query):
        return 400
    if query in path_lc:
        return 250
    return 0


@workspace_bp.get("/api/workspace/search")
def workspace_search():
    query = request.args.get("q", "").strip().lower()
    kind = request.args.get("kind", "").strip().lower()
    if not query:
        return {"matches": []}

    matches = []
    for item in workspace_index.items():
        if kind and item["kind"] != kind:
            continue
        score = _score_match(query, item)
        if score <= 0:
            continue
        clean = {key: value for key, value in item.items() if key not in {"basename", "path_lc"}}
        clean["score"] = score
        matches.append(clean)

    matches.sort(key=lambda item: (-item["score"], item["path"].lower()))
    return {"matches": matches[:MAX_SEARCH_RESULTS]}


@workspace_bp.get("/api/workspace/file-info")
def workspace_file_info():
    rel_path = request.args.get("path", "")
    if ARCHIVE_SEPARATOR in rel_path:
        return _workspace_archive_file_info(rel_path)

    try:
        path = _resolve_workspace_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)

    if not path.exists():
        return _json_error("Path not found.", 404)
    node = _node_for(path, _workspace_root())
    if not node:
        return _json_error("Unable to stat path.", 500)
    return node


def _find_archive_member(archive, member_path: str):
    for member in archive.getmembers():
        try:
            clean_name = _clean_archive_member_path(member.name)
        except ValueError:
            continue
        if clean_name == member_path:
            return member, clean_name
    return None, ""


def _workspace_archive_file_info(rel_path: str):
    try:
        archive_path, archive_rel, member_path = _resolve_archive_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except (NotADirectoryError, tarfile.TarError) as exc:
        return _json_error(str(exc), 400)

    if not member_path:
        return _json_error("Path is an MPK package folder.", 400)

    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            member, clean_name = _find_archive_member(archive, member_path)
            if not member:
                return _json_error("Archive member not found.", 404)
            return _archive_member_node(archive_rel, clean_name, member, is_dir=member.isdir())
    except tarfile.TarError as exc:
        return _json_error(str(exc), 400)
    except OSError as exc:
        return _json_error(str(exc), 500)


@workspace_bp.get("/api/workspace/raw")
def workspace_raw_file():
    rel_path = request.args.get("path", "")
    try:
        path = _resolve_workspace_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)

    if not path.exists():
        return _json_error("Path not found.", 404)
    if not path.is_file():
        return _json_error("Path is not a file.", 400)

    node = _node_for(path, _workspace_root())
    if not node:
        return _json_error("Unable to stat file.", 500)
    if node["kind"] != "image":
        return _json_error("Raw preview is only available for image files.", 400)

    return send_file(path, conditional=True, max_age=0)


def _read_text_preview(path: Path):
    with path.open("rb") as handle:
        data = handle.read(TEXT_PREVIEW_LIMIT + 1)
    return _decode_text_preview(data)


def _decode_text_preview(data: bytes):
    truncated = len(data) > TEXT_PREVIEW_LIMIT
    if truncated:
        data = data[:TEXT_PREVIEW_LIMIT]
    if b"\x00" in data:
        raise UnicodeDecodeError("binary", data, 0, 1, "NUL byte found")
    text = data.decode("utf-8", errors="replace")
    return text, truncated


@workspace_bp.get("/api/workspace/file")
def workspace_file():
    rel_path = request.args.get("path", "")
    if ARCHIVE_SEPARATOR in rel_path:
        return _workspace_archive_file(rel_path)

    try:
        path = _resolve_workspace_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)

    if not path.exists():
        return _json_error("Path not found.", 404)
    if not path.is_file():
        return _json_error("Path is not a file.", 400)

    node = _node_for(path, _workspace_root())
    if not node:
        return _json_error("Unable to stat file.", 500)

    if node["kind"] not in {"code", "text"}:
        return {
            **node,
            "content": "",
            "truncated": False,
            "previewAvailable": node["kind"] == "image",
        }

    try:
        content, truncated = _read_text_preview(path)
    except UnicodeDecodeError:
        return {
            **node,
            "content": "",
            "truncated": False,
            "previewAvailable": False,
            "kind": "binary",
        }
    except OSError as exc:
        return _json_error(str(exc), 500)

    return {
        **node,
        "content": content,
        "truncated": truncated,
        "previewAvailable": True,
    }


def _workspace_archive_file(rel_path: str):
    try:
        archive_path, archive_rel, member_path = _resolve_archive_path(rel_path)
    except ValueError as exc:
        return _json_error(str(exc), 403)
    except FileNotFoundError as exc:
        return _json_error(str(exc), 404)
    except (NotADirectoryError, tarfile.TarError) as exc:
        return _json_error(str(exc), 400)

    if not member_path:
        return _json_error("Path is an MPK package folder.", 400)

    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            member, clean_name = _find_archive_member(archive, member_path)
            if not member:
                return _json_error("Archive member not found.", 404)
            if not member.isfile():
                return _json_error("Archive member is not a file.", 400)

            node = _archive_member_node(archive_rel, clean_name, member)
            if node["kind"] not in {"code", "text"}:
                return {
                    **node,
                    "content": "",
                    "truncated": False,
                    "previewAvailable": False,
                }

            handle = archive.extractfile(member)
            if handle is None:
                return _json_error("Archive member is not readable.", 400)
            data = handle.read(TEXT_PREVIEW_LIMIT + 1)
            content, truncated = _decode_text_preview(data)
            return {
                **node,
                "content": content,
                "truncated": truncated,
                "previewAvailable": True,
            }
    except UnicodeDecodeError:
        node = {
            "name": Path(member_path).name,
            "path": rel_path,
            "type": "file",
            "kind": "binary",
            "size": 0,
            "mtime": 0,
            "virtual": True,
            "content": "",
            "truncated": False,
            "previewAvailable": False,
        }
        return node
    except tarfile.TarError as exc:
        return _json_error(str(exc), 400)
    except OSError as exc:
        return _json_error(str(exc), 500)
