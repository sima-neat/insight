# Copyright (c) 2025 SiMa.ai
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import os
import json
from pathlib import Path
from neat_insight.config import APPLICATIONS_DIR
from neat_insight.remote_devkit import is_remote_devkit_configured
from neat_insight.remotefs import read_remote_file
from neat_insight.remotefs import RemoteFS

class AppManager:
    def __init__(self, appdir=APPLICATIONS_DIR):
        self.apps = {}
        self.apps_dir = appdir

    def refresh_apps(self):
        if is_remote_devkit_configured():
            self._refresh_remote_apps()
        else:
            self._refresh_local_apps()

    def _refresh_local_apps(self):
        apps_dir = Path(self.apps_dir)
        if not apps_dir.exists() or not apps_dir.is_dir():
            print(f"⚠️ Applications directory not found: {apps_dir}")
            return

        new_apps = {}
        for entry in apps_dir.iterdir():
            if entry.is_dir():
                manifest_path = entry / "manifest.json"
                if manifest_path.exists():
                    try:
                        with open(manifest_path) as f:
                            manifest = json.load(f)
                        new_apps[entry.name] = manifest
                    except Exception as e:
                        print(f"❌ Failed to load manifest from {manifest_path}: {e}")

        self.apps = new_apps

    def _refresh_remote_apps(self):
        try:
            self.apps = {}
            apps_dir = APPLICATIONS_DIR

            with RemoteFS() as rfs:
                if not rfs.exists(apps_dir):
                    print(f"⚠️ Remote applications directory not found: {apps_dir}")
                    return

                entries = rfs.ls(apps_dir, detail=True)

                for entry in sorted(entries, key=lambda e: e["name"]):
                    if entry["type"] != "directory":
                        continue

                    app_dir_path = entry["name"]
                    manifest_path = os.path.join(app_dir_path, "manifest.json")

                    if rfs.exists(manifest_path):
                        try:
                            with rfs.open(manifest_path, "r") as f:
                                manifest = json.load(f)
                            app_name = os.path.basename(app_dir_path)
                            self.apps[app_name] = manifest
                        except Exception as e:
                            print(f"❌ Failed to load remote manifest from {manifest_path}: {e}")

        except Exception as e:
            print(f"❌ Failed to refresh remote apps: {e}")
            self.apps = {}

    def get_available_apps(self):
        return list(self.apps.keys())

    def get_app_config(self, app_name):
        if is_remote_devkit_configured():
            return self._get_remote_app_config(app_name)
        else:
            return self._get_local_app_config(app_name)

    def _get_local_app_config(self, app_name):
        app_path = Path(self.apps_dir) / app_name / "manifest.json"
        if app_path.exists():
            try:
                with open(app_path) as f:
                    return json.load(f)
            except Exception as e:
                print(f"❌ Failed to read manifest for {app_name}: {e}")
        else:
            print(f"⚠️ Manifest not found for local app: {app_name}")
        return None

    def _get_remote_app_config(self, app_name):
        try:
            manifest_path = f"{APPLICATIONS_DIR}/{app_name}/manifest.json"
            app_config = read_remote_file(manifest_path, label=f"remote app {app_name}")
            return json.loads(app_config)
        except Exception as e:
            print(f"❌ Failed to read remote manifest for {app_name}: {e}")
        return None