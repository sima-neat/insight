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

import logging
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, DirCreatedEvent, DirDeletedEvent
from neat_insight.config import APPLICATIONS_DIR

class AppFolderEventHandler(FileSystemEventHandler):
    def __init__(self, app_manager):
        self.app_manager = app_manager

    def on_created(self, event):
        if isinstance(event, DirCreatedEvent):
            logging.info(f"📁 Directory created: {event.src_path}")
            self.app_manager.refresh_apps()

    def on_deleted(self, event):
        if isinstance(event, DirDeletedEvent):
            logging.info(f"🗑️ Directory deleted: {event.src_path}")
            self.app_manager.refresh_apps()

    def on_moved(self, event):
        if event.is_directory:
            logging.info(f"🔁 Directory renamed/moved: {event.src_path} → {event.dest_path}")
            self.app_manager.refresh_apps()

def start_app_watcher(app_manager, app_dir=APPLICATIONS_DIR):
    event_handler = AppFolderEventHandler(app_manager)
    app_manager.refresh_apps()
    observer = Observer()
    observer.schedule(event_handler, path=app_dir, recursive=False)
    observer.daemon = True
    observer.start()
    logging.info(f"👀 Watching {APPLICATIONS_DIR} for changes...")