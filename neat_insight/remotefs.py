import paramiko
import time
import logging
import os
import json
import stat
from neat_insight.utils import EXCLUDED_EXTENSIONS, EXCLUDED_FOLDERS, init_environment

env = init_environment()

CFG_PATH = env["NEAT_INSIGHT_DATA"] / "cfg.json"
logging.getLogger("paramiko").setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO)

def _load_remote_config():
    """Load SSH connection config from cfg.json"""
    if not os.path.exists(CFG_PATH):
        raise FileNotFoundError(f"{CFG_PATH} not found.")

    with open(CFG_PATH, "r") as f:
        config = json.load(f)

    devkit = config.get("remote-devkit")
    if not devkit:
        raise ValueError("Missing 'remote-devkit' section in config.")

    return {
        "host": devkit.get("ip"),
        "username": "root",
        "password": devkit.get("rootPassword"),
        "port": devkit.get("port", 22)
    }

def create_ssh_client():
    """
    Creates and returns a connected Paramiko SSHClient based on remote config.

    Returns:
        paramiko.SSHClient: An active SSH client ready for use.
    Raises:
        Exception: If connection fails.
    """
    creds = _load_remote_config()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(
        hostname=creds["host"],
        port=creds.get("port", 22),
        username=creds["username"],
        password=creds["password"],
        timeout=10,
        banner_timeout=5,
        look_for_keys=False,
        allow_agent=False
    )
    return ssh

class RemoteFS:
    def __init__(self):
        self.ssh = create_ssh_client()
        self.sftp = self.ssh.open_sftp()

    def exists(self, path):
        try:
            self.sftp.stat(path)
            return True
        except FileNotFoundError:
            return False

    def open(self, path, mode='r'):
        return self.sftp.open(path, mode)

    def ls(self, path, detail=True):
        """
        Lists directory contents.

        Args:
            path (str): Remote directory path.
            detail (bool): If True, returns list of dicts with metadata.

        Returns:
            list[str] or list[dict]: File names or detailed entries.
        """
        items = self.sftp.listdir_attr(path)
        if not detail:
            return [item.filename for item in items]

        result = []
        for item in items:
            full_path = os.path.join(path, item.filename)
            item_type = 'directory' if stat.S_ISDIR(item.st_mode) else 'file'
            result.append({
                'name': full_path,
                'type': item_type,
                'size': item.st_size,
                'mtime': item.st_mtime,
            })
        return result
    
    def close(self):
        try:
            self.sftp.close()
            self.ssh.close()
            logging.debug("Connections closed.")
        except Exception as e:
            logging.warning(f"Error closing connections: {e}")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

def read_remote_file(remote_path, label="file"):
    """
    Reads the entire content of a remote file via SFTP.

    Args:
        remote_path (str): Absolute path to the file on the remote host.
        label (str): Label for logging/debugging context.

    Returns:
        bytes: The full file content (binary-safe).
    """
    with RemoteFS() as rfs:
        if not rfs.exists(remote_path):
            logging.debug(f"[{label}] File not found: {remote_path}")
            return None

        file_size = rfs.sftp.stat(remote_path).st_size
        logging.debug(f"[{label}] Reading {file_size} bytes from {remote_path}")

        with rfs.open(remote_path, "rb") as f:
            return f.read(file_size)
        
def build_remote_tree(path="/data/simaai/applications"):
    """
    Recursively builds a hierarchical file tree starting from a given directory
    on a remote device via SFTP. Filters out certain files and directories.

    Args:
        path (str): The root directory path on the remote device to start the scan.

    Returns:
        dict: A nested dictionary representing the file tree structure.
    """
    with RemoteFS() as rfs:
        def _walk(current_path):
            # Initialize tree node for the current directory
            tree = {
                "name": os.path.basename(current_path),
                "path": current_path,
                "type": "directory",
                "children": []
            }

            try:
                # List directory contents with file metadata
                entries = rfs.ls(current_path, detail=True)

                # Sort entries by name for predictable ordering
                for entry in sorted(entries, key=lambda e: e["name"]):
                    name = os.path.basename(entry["name"])
                    entry_path = entry["name"]

                    # Skip 'EXCLUDED_FOLDERS' directories (commonly excluded)
                    if name in EXCLUDED_FOLDERS:
                        continue

                    # Recursively walk into subdirectories
                    if entry["type"] == "directory":
                        child = _walk(entry_path)
                        if child["children"]:
                            tree["children"].append(child)
                    else:
                        # Only include files not in the excluded extension list
                        ext = os.path.splitext(name)[1].lower()
                        if ext not in EXCLUDED_EXTENSIONS:
                            tree["children"].append({
                                "name": name,
                                "path": entry_path,
                                "type": "file"
                            })

            except Exception as e:
                # If we encounter an error (e.g., permission denied), attach it to the tree
                tree["error"] = str(e)

            return tree

        # Start recursive walk from the root path
        logging.info(f'returning remote tree starting from: {path}')
        return _walk(path)

def write_remote_file(remote_path, content):
    """
    Writes content to a remote file using RemoteFS (paramiko-based).

    Args:
        remote_path (str): Full path to the target file on the remote devkit.
        content (str): String content to write.

    Returns:
        dict: {"status": "success"} or {"error": "..."}
    """
    try:
        # Optional: validate JSON content if file has .json extension
        if remote_path.lower().endswith(".json"):
            try:
                json.loads(content)
            except json.JSONDecodeError as e:
                return {"error": f"Invalid JSON: {str(e)}"}
            
        with RemoteFS() as rfs:
            # Ensure parent directory exists
            parent = os.path.dirname(remote_path)
            try:
                rfs.sftp.stat(parent)
            except FileNotFoundError:
                rfs.sftp.mkdir(parent)

            # Atomic write: write to tmp file, then rename
            tmp_path = remote_path + ".tmp"
            with rfs.open(tmp_path, "w") as f:
                f.write(content)
                logging.info(f'writing {len(content)} bytes to {remote_path}')

            try:
                rfs.sftp.remove(remote_path)
            except FileNotFoundError:
                pass

            rfs.sftp.rename(tmp_path, remote_path)
            logging.info(f'wrote {len(content)} bytes to {remote_path}')

        return {"status": "success"}

    except Exception as e:
        return {"error": f"Remote write failed: {str(e)}"}


if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def read_and_print_file(remote_path, label):
        content = read_remote_file(remote_path, label=label)
        if content is not None:
            print(f"\n[{label}] -------- FILE CONTENT START --------")
            try:
                decoded = content.decode("utf-8")
                print(decoded.strip())
            except UnicodeDecodeError:
                print(f"[{label}] Binary file — first 64 bytes (hex): {content[:64].hex()} ...")
            print(f"[{label}] --------- FILE CONTENT END ---------")

    if __name__ == "__main__":
        tree = build_remote_tree()
        print("=== Remote File Tree Built ===")

        # Collect all file paths recursively
        def collect_files(node):
            files = []
            if node["type"] == "file":
                files.append(node["path"])
            for child in node.get("children", []):
                files.extend(collect_files(child))
            return files

        file_paths = collect_files(tree)
        print(f"Found {len(file_paths)} file(s). Reading with up to 10 threads...")

        # Use ThreadPoolExecutor to read up to 10 files in parallel
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = []
            for idx, path in enumerate(file_paths):
                label = f"file-{idx}"
                futures.append(executor.submit(read_and_print_file, path, label))

            # Optionally: wait for all to finish
            for future in as_completed(futures):
                try:
                    future.result()  # raise any exceptions
                except Exception as e:
                    print(f"[ERROR] Exception during file read: {e}")

        print("=== All file reads completed ===")
