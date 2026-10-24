import errno
import io
import json
import os
import tempfile
import unittest
import unittest.mock as mock
import zipfile
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module
from neat_insight import mediasrc
from neat_insight.mediamtx import PathInfo


def zip_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def external_path(index: int) -> PathInfo:
    return PathInfo(name=f"src{index}", ready=True, since="2026-09-16T13:09:59Z", source_type="rtspSession",
                    source_id=f"ext-{index}", protocol="rtsp", address="172.19.0.1", query="",
                    codec="h264", bytes_received=10, readers=[])


class UploadFixture(unittest.TestCase):
    """A temp media dir and slot file, with ffmpeg optimisation, MediaMTX and the stream launcher patched out."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.sources_file = self.root / "media_sources.json"
        self.sources_file.write_text("[]", encoding="utf-8")
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        mediasrc.pipeline_registry.clear()
        self.addCleanup(mediasrc.pipeline_registry.clear)

        self.mtx = mock.Mock()
        self.mtx.snapshot.return_value = {}
        old_pull_registry = app_module.pull_registry
        app_module.pull_registry = app_module.pull_sources.PullRegistry()
        self.addCleanup(setattr, app_module, "pull_registry", old_pull_registry)

        patches = {
            "MEDIA_DIR": self.media_dir,
            "MEDIA_SRC_DATA_FILE": self.sources_file,
            "RENDITIONS_INDEX_FILE": self.root / "renditions.json",
            "mediamtx_client": self.mtx,
        }
        for name, value in patches.items():
            patcher = mock.patch.object(app_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Optimising needs ffprobe and ffmpeg; its own tests live with the optimiser.
        optimize = mock.patch.object(app_module, "_optimize_media_files", side_effect=lambda root: iter(()))
        self.optimize = optimize.start()
        self.addCleanup(optimize.stop)
        codec = mock.patch.object(app_module, "_source_media_codec", return_value="h264")
        codec.start()
        self.addCleanup(codec.stop)
        self.stop_stream = self._patch("stop_media_stream")
        self.start_stream = self._patch("start_media_stream", return_value=(True, None, 101))
        self.remove_renditions = self._patch_attr(app_module.renditions, "remove_source", return_value=[])

    def _patch(self, name, **kwargs):
        return self._patch_attr(app_module, name, **kwargs)

    def _patch_attr(self, target, name, **kwargs):
        patcher = mock.patch.object(target, name, **kwargs)
        mock_object = patcher.start()
        self.addCleanup(patcher.stop)
        return mock_object

    def write_slots(self, *slots):
        self.sources_file.write_text(json.dumps(list(slots)), encoding="utf-8")

    def slot(self, index):
        return app_module.load_sources()[index - 1]

    def upload(self, name, content, **fields):
        data = {"file": (io.BytesIO(content), name), **fields}
        response = self.client.post("/api/upload/media", data=data, content_type="multipart/form-data")
        # What a WSGI server does once it has sent the body; the staging folder goes with it.
        response.get_data()
        response.close()
        return response

    def media_listing(self):
        return sorted(str(path.relative_to(self.media_dir)) for path in self.media_dir.rglob("*"))


class UploadValidationTests(UploadFixture):
    def test_upload_without_file_is_400(self):
        response = self.client.post("/api/upload/media", data={}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "No file provided."})

    def test_upload_with_empty_filename_is_400(self):
        response = self.upload("", b"x")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "No file provided."})

    def test_name_without_usable_characters_is_400(self):
        response = self.upload("日本語", b"x")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "The file name has no usable characters."})
        self.assertEqual(self.media_listing(), [])

    def test_unknown_on_conflict_is_400_even_without_a_clash(self):
        response = self.upload("clip.mp4", b"x", on_conflict="overwrite")
        self.assertEqual(response.status_code, 400)
        self.assertIn("on_conflict", response.get_json()["error"])
        self.assertEqual(self.media_listing(), [])

    def test_new_file_is_saved_with_the_existing_progress_lines(self):
        response = self.upload("clip.mp4", b"new")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/plain")
        self.assertEqual(
            response.get_data(as_text=True).splitlines(),
            [f"Uploaded to {self.media_dir / 'clip.mp4'}", "Upload complete."],
        )
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"new")
        self.optimize.assert_called_once_with(self.media_dir / "clip.mp4")

    def test_target_outside_the_media_root_is_refused(self):
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"outside")
        (self.media_dir / "clip.mp4").symlink_to(outside)
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(outside.read_bytes(), b"outside")


class UploadFileClashTests(UploadFixture):
    def setUp(self):
        super().setUp()
        (self.media_dir / "clip.mp4").write_bytes(b"old")

    def test_clash_without_on_conflict_is_409_and_saves_nothing(self):
        response = self.upload("clip.mp4", b"new")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(
            response.get_json(),
            {"error": "A file with this name exists.", "conflict": {"existing": "clip.mp4", "suggested": "clip_2.mp4"}},
        )
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"old")
        self.assertEqual(self.media_listing(), ["clip.mp4"])
        self.optimize.assert_not_called()

    def test_explicit_ask_is_the_same_409(self):
        self.assertEqual(self.upload("clip.mp4", b"new", on_conflict="ask").status_code, 409)

    def test_suggestion_skips_names_that_are_taken(self):
        (self.media_dir / "clip_2.mp4").write_bytes(b"two")
        conflict = self.upload("clip.mp4", b"new").get_json()["conflict"]
        self.assertEqual(conflict["suggested"], "clip_3.mp4")

    def test_keep_both_saves_name_2(self):
        response = self.upload("clip.mp4", b"new", on_conflict="keep_both")
        self.assertEqual(response.status_code, 200)
        lines = response.get_data(as_text=True).splitlines()
        self.assertEqual(lines, [f"Uploaded to {self.media_dir / 'clip_2.mp4'}", "Upload complete."])
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"old")
        self.assertEqual((self.media_dir / "clip_2.mp4").read_bytes(), b"new")

    def test_keep_both_without_a_clash_keeps_the_plain_name(self):
        self.upload("other.mp4", b"new", on_conflict="keep_both")
        self.assertEqual(self.media_listing(), ["clip.mp4", "other.mp4"])

    def test_replace_overwrites_and_leaves_no_staging_files(self):
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Upload complete.", response.get_data(as_text=True))
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"new")
        self.assertEqual(self.media_listing(), ["clip.mp4"])

    def test_replace_forgets_the_renditions_of_the_old_content(self):
        self.upload("clip.mp4", b"new", on_conflict="replace")
        self.remove_renditions.assert_called_once_with(
            app_module.RENDITIONS_INDEX_FILE, self.media_dir, "clip.mp4"
        )

    def test_new_file_forgets_no_renditions(self):
        self.upload("other.mp4", b"new", on_conflict="replace")
        self.remove_renditions.assert_not_called()

    def test_a_name_taken_by_a_simultaneous_upload_is_never_overwritten(self):
        real_link = os.link

        def link_after_a_competitor(source, destination):
            Path(destination).write_bytes(b"competitor")  # saved between the clash check and the move
            return real_link(source, destination)

        for fields in ({}, {"on_conflict": "keep_both"}):
            with self.subTest(fields=fields), mock.patch.object(app_module.os, "link", link_after_a_competitor):
                response = self.upload("fresh.mp4", b"new", **fields)
                lines = response.get_data(as_text=True).splitlines()
                self.assertEqual(lines, ["Failed to save upload: a file with this name was added meanwhile."])
                self.assertEqual((self.media_dir / "fresh.mp4").read_bytes(), b"competitor")
                (self.media_dir / "fresh.mp4").unlink()
                self.assertEqual(self.media_listing(), ["clip.mp4"])

    def test_without_hard_links_the_upload_still_lands(self):
        for code in (errno.EPERM, errno.EXDEV, errno.ENOTSUP, errno.EMLINK):
            with self.subTest(errno=errno.errorcode[code]):
                with mock.patch.object(app_module.os, "link", side_effect=OSError(code, "no hard links")):
                    response = self.upload("fresh.mp4", b"new")
                self.assertEqual(
                    response.get_data(as_text=True).splitlines(),
                    [f"Uploaded to {self.media_dir / 'fresh.mp4'}", "Upload complete."],
                )
                self.assertEqual((self.media_dir / "fresh.mp4").read_bytes(), b"new")
                self.assertEqual(self.media_listing(), ["clip.mp4", "fresh.mp4"])
                (self.media_dir / "fresh.mp4").unlink()

    def test_without_hard_links_a_name_taken_meanwhile_is_still_refused(self):
        real_open = os.open

        def open_after_a_competitor(path, flags, *args):
            if Path(path) == self.media_dir / "fresh.mp4":
                Path(path).write_bytes(b"competitor")  # saved between the clash check and the move
            return real_open(path, flags, *args)

        with mock.patch.object(app_module.os, "link", side_effect=OSError(errno.EPERM, "no hard links")), \
                mock.patch.object(app_module.os, "open", open_after_a_competitor):
            response = self.upload("fresh.mp4", b"new")
        self.assertEqual(
            response.get_data(as_text=True).splitlines(),
            ["Failed to save upload: a file with this name was added meanwhile."],
        )
        self.assertEqual((self.media_dir / "fresh.mp4").read_bytes(), b"competitor")

    def test_without_hard_links_a_failed_move_leaves_no_empty_reservation(self):
        with mock.patch.object(app_module.os, "link", side_effect=OSError(errno.EPERM, "no hard links")), \
                mock.patch.object(app_module.os, "replace", side_effect=OSError("disk went away")):
            response = self.upload("fresh.mp4", b"new")
        self.assertEqual(response.get_data(as_text=True).splitlines(), ["Failed to save upload: disk went away"])
        self.assertEqual(self.media_listing(), ["clip.mp4"])

    def test_other_link_errors_are_reported_not_worked_around(self):
        with mock.patch.object(app_module.os, "link", side_effect=OSError(errno.ENOSPC, "No space left")):
            response = self.upload("fresh.mp4", b"new")
        self.assertIn("Failed to save upload: ", response.get_data(as_text=True))
        self.assertEqual(self.media_listing(), ["clip.mp4"])

    def test_stale_staging_folders_are_swept_and_nothing_else(self):
        (self.media_dir / ".upload-dead").mkdir()
        (self.media_dir / ".upload-dead" / "clip.mp4").write_bytes(b"half")
        (self.media_dir / ".hidden-other").mkdir()
        app_module._remove_stale_upload_stages()
        self.assertEqual(self.media_listing(), [".hidden-other", "clip.mp4"])

    def test_replacing_a_folder_with_a_file_is_refused(self):
        (self.media_dir / "folder.mp4").mkdir()
        response = self.upload("folder.mp4", b"new", on_conflict="replace")
        self.assertEqual(response.status_code, 400)
        self.assertTrue((self.media_dir / "folder.mp4").is_dir())


class ReplaceRestartsSlotsTests(UploadFixture):
    def setUp(self):
        super().setUp()
        (self.media_dir / "clip.mp4").write_bytes(b"old")
        (self.media_dir / "other.mp4").write_bytes(b"other")

    def seed_slots(self):
        playing = {"type": "file", "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}
        self.write_slots(
            {"index": 3, **playing},
            {"index": 4, **{**playing, "state": "stopped"}},
            {"index": 5, **{**playing, "file": "other.mp4"}},
            {"index": 6, **{**playing, "type": "webcam"}},
        )

    def test_replace_overwrites_and_restarts_slots_streaming_the_file(self):
        self.seed_slots()
        content_when_started = []
        self.start_stream.side_effect = lambda *args, **kwargs: (
            content_when_started.append(Path(args[1]).read_bytes()) or (True, None, 101)
        )

        response = self.upload("clip.mp4", b"new", on_conflict="replace")

        lines = response.get_data(as_text=True).splitlines()
        self.assertEqual(lines[-2:], ["Restarted src3.", "Upload complete."])
        self.assertEqual(lines.count("Restarted src3."), 1)
        self.assertFalse([line for line in lines if line.startswith("Error:")])
        self.stop_stream.assert_called_once_with(3)
        self.start_stream.assert_called_once()
        self.assertEqual(self.start_stream.call_args.args[0], 3)
        self.assertEqual(content_when_started, [b"new"], "the slot starts on the replaced content")
        self.assertEqual(self.slot(3)["state"], "playing")

    def test_only_slots_streaming_the_file_are_touched(self):
        self.seed_slots()
        before = {index: self.slot(index) for index in (4, 5, 6)}
        self.upload("clip.mp4", b"new", on_conflict="replace")
        for index, slot in before.items():
            self.assertEqual(self.slot(index), slot, f"src{index}")

    def test_slots_are_stopped_before_the_file_changes_and_started_after_the_renditions_go(self):
        self.seed_slots()
        events = []
        self.stop_stream.side_effect = lambda index: events.append(("stop", (self.media_dir / "clip.mp4").read_bytes()))
        self.remove_renditions.side_effect = lambda *args: events.append(("renditions", None)) or []
        self.start_stream.side_effect = lambda *args, **kwargs: events.append(("start", None)) or (True, None, 101)

        self.upload("clip.mp4", b"new", on_conflict="replace")

        self.assertEqual(events, [("stop", b"old"), ("renditions", None), ("start", None)])

    def test_restart_waits_for_the_optimised_file(self):
        self.seed_slots()
        events = []

        def optimise(root):
            events.append("optimise")
            return iter(())

        self.optimize.side_effect = optimise
        self.start_stream.side_effect = lambda *args, **kwargs: events.append("start") or (True, None, 101)
        self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertEqual(events, ["optimise", "start"])

    def test_a_failed_restart_prints_a_warning_line_and_the_upload_still_completes(self):
        self.seed_slots()
        self.start_stream.return_value = (False, "ffmpeg exploded", None)
        with self.assertLogs(level="WARNING"):
            response = self.upload("clip.mp4", b"new", on_conflict="replace")
        lines = response.get_data(as_text=True).splitlines()
        self.assertIn("Could not restart src3: ffmpeg exploded", lines)
        self.assertFalse([line for line in lines if line.startswith("Error:")], "Error: means the response failed")
        self.assertEqual(lines[-1], "Upload complete.")
        self.assertEqual(self.slot(3)["state"], "stopped")

    def test_a_restart_that_raises_is_reported_and_does_not_end_the_stream(self):
        self.seed_slots()
        self.start_stream.side_effect = RuntimeError("no mediamtx")
        with self.assertLogs(level="WARNING"):
            lines = self.upload("clip.mp4", b"new", on_conflict="replace").get_data(as_text=True).splitlines()
        self.assertIn("Could not restart src3: no mediamtx", lines)
        self.assertEqual(lines[-1], "Upload complete.")

    def test_an_externally_held_slot_is_never_touched(self):
        self.write_slots({"index": 3, "type": "file", "file": "clip.mp4", "state": "playing",
                          "transport": "rtsp", "codec": "h264"})
        self.mtx.snapshot.return_value = {"src3": external_path(3)}
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertNotIn("src3", response.get_data(as_text=True))
        self.stop_stream.assert_not_called()
        self.start_stream.assert_not_called()

    def test_a_pulled_slot_is_never_touched(self):
        self.write_slots({"index": 3, "type": "file", "file": "clip.mp4", "state": "playing",
                          "transport": "rtsp", "codec": "h264"})
        app_module.pull_registry.put(app_module.pull_sources.PullRecord(
            index=3, url="rtsp://cam.local/stream", scheme="rtsp", host="cam.local", path="/stream", started_at=0.0))
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertNotIn("src3", response.get_data(as_text=True))
        self.stop_stream.assert_not_called()
        self.start_stream.assert_not_called()

    def test_a_slot_reassigned_during_the_upload_is_left_alone(self):
        self.seed_slots()

        def reassign(root):
            slots = app_module.load_sources()
            slots[2]["file"] = "other.mp4"
            app_module.save_sources(slots)
            app_module._bump_slot(3)  # what the assign route does
            return iter(())

        self.optimize.side_effect = reassign
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertNotIn("src3", response.get_data(as_text=True))
        self.start_stream.assert_not_called()
        self.assertEqual(self.slot(3)["file"], "other.mp4")

    def test_a_slot_stopped_by_someone_during_the_upload_is_not_restarted(self):
        self.seed_slots()
        self.optimize.side_effect = lambda root: app_module._bump_slot(3) or iter(())
        response = self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertNotIn("src3", response.get_data(as_text=True))
        self.start_stream.assert_not_called()

    def test_slots_restart_when_the_client_goes_away_mid_stream(self):
        self.seed_slots()
        response = self.client.post(
            "/api/upload/media",
            data={"file": (io.BytesIO(b"new"), "clip.mp4"), "on_conflict": "replace"},
            content_type="multipart/form-data",
            buffered=False,
        )
        first = next(iter(response.response))
        self.assertTrue(first.decode().startswith("Uploaded to "))
        self.start_stream.assert_not_called()
        response.close()  # what the server does on a broken pipe
        self.start_stream.assert_called_once()
        self.assertEqual(self.slot(3)["state"], "playing")

    def test_slots_already_stopped_restart_when_stopping_another_raises(self):
        playing = {"type": "file", "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}
        self.write_slots({"index": 3, **playing}, {"index": 7, **playing})
        stops = []

        def stop(index):
            stops.append(index)
            if index == 7:
                raise RuntimeError("mediamtx went away")

        self.stop_stream.side_effect = stop
        with self.assertRaises(RuntimeError):
            self.upload("clip.mp4", b"new", on_conflict="replace")
        self.assertEqual(stops, [3, 7])
        self.start_stream.assert_called_once()
        self.assertEqual(self.start_stream.call_args.args[0], 3)
        self.assertEqual(self.slot(3)["state"], "playing")

    def test_slots_restart_when_optimising_raises(self):
        self.seed_slots()
        self.optimize.side_effect = RuntimeError("ffprobe crashed")
        with self.assertRaises(RuntimeError):
            self.upload("clip.mp4", b"new", on_conflict="replace")
        self.start_stream.assert_called_once()
        self.assertEqual(self.slot(3)["state"], "playing")

    def test_a_save_that_fails_reports_it_and_the_slots_go_back_to_the_old_file(self):
        self.seed_slots()
        with mock.patch.object(app_module.os, "replace", side_effect=OSError("disk went away")):
            response = self.upload("clip.mp4", b"new", on_conflict="replace")
        lines = response.get_data(as_text=True).splitlines()
        self.assertEqual(lines, ["Failed to save upload: disk went away"])
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"old")
        self.assertEqual(self.slot(3)["state"], "playing")
        self.start_stream.assert_called_once()

    def test_keep_both_never_stops_the_slots(self):
        self.seed_slots()
        self.upload("clip.mp4", b"new", on_conflict="keep_both")
        self.stop_stream.assert_not_called()
        self.start_stream.assert_not_called()
        self.assertEqual((self.media_dir / "clip.mp4").read_bytes(), b"old")


class UploadArchiveTests(UploadFixture):
    def setUp(self):
        super().setUp()
        (self.media_dir / "clips").mkdir()
        (self.media_dir / "clips" / "a.mp4").write_bytes(b"old-a")
        (self.media_dir / "clips" / "gone.mp4").write_bytes(b"old-gone")

    def archive(self, **members):
        return zip_bytes({name.replace("__", "/"): content for name, content in members.items()})

    def test_new_archive_extracts_into_its_folder_with_the_existing_lines(self):
        response = self.upload("fresh.zip", zip_bytes({"b.mp4": b"b"}))
        lines = response.get_data(as_text=True).splitlines()
        self.assertEqual(
            lines,
            [f"Saved archive; extracting into {self.media_dir / 'fresh'}", "Archive extracted.", "Upload complete."],
        )
        self.assertEqual((self.media_dir / "fresh" / "b.mp4").read_bytes(), b"b")
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4", "fresh", "fresh/b.mp4"])
        self.optimize.assert_called_once_with(self.media_dir / "fresh")

    def test_tar_gz_archives_clash_on_the_folder_too(self):
        response = self.upload("clips.tar.gz", b"irrelevant")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["conflict"], {"existing": "clips", "suggested": "clips_2"})

    def test_archive_clash_is_409_on_the_folder_and_extracts_nothing(self):
        response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.get_json(),
            {"error": "A file with this name exists.", "conflict": {"existing": "clips", "suggested": "clips_2"}},
        )
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4"])

    def test_archive_clash_on_folder_and_keep_both_extracts_to_folder_2(self):
        response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}), on_conflict="keep_both")
        self.assertIn("Upload complete.", response.get_data(as_text=True))
        self.assertEqual((self.media_dir / "clips_2" / "a.mp4").read_bytes(), b"new-a")
        self.assertEqual((self.media_dir / "clips" / "a.mp4").read_bytes(), b"old-a")
        self.optimize.assert_called_once_with(self.media_dir / "clips_2")

    def test_replace_swaps_the_folders_contents(self):
        response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a", "sub/c.mp4": b"c"}), on_conflict="replace")
        self.assertIn("Upload complete.", response.get_data(as_text=True))
        self.assertEqual(
            self.media_listing(), ["clips", "clips/a.mp4", "clips/sub", "clips/sub/c.mp4"],
            "files of the old folder that the archive lacks are gone, and no staging folder is left",
        )
        self.assertEqual((self.media_dir / "clips" / "a.mp4").read_bytes(), b"new-a")
        self.optimize.assert_called_once_with(self.media_dir / "clips")

    def test_failed_replace_keeps_the_old_folder_intact(self):
        response = self.upload("clips.zip", b"this is not a zip", on_conflict="replace")
        text = response.get_data(as_text=True)
        self.assertIn("Failed to extract archive: ", text)
        self.assertNotIn("Upload complete.", text)
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4"])
        self.assertEqual((self.media_dir / "clips" / "a.mp4").read_bytes(), b"old-a")

    def test_unsafe_member_fails_the_replace_and_keeps_the_old_folder(self):
        response = self.upload("clips.zip", zip_bytes({"../escape.mp4": b"x"}), on_conflict="replace")
        text = response.get_data(as_text=True)
        self.assertIn("Failed to extract archive: Unsafe archive path", text)
        self.assertNotIn("Upload complete.", text)
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4"])

    def test_a_replace_that_fails_while_swapping_puts_the_old_folder_back(self):
        real_rename = Path.rename

        def rename(path, destination):
            if path.name == "extracted":
                raise OSError("disk went away")
            return real_rename(path, destination)

        with mock.patch.object(Path, "rename", rename):
            response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}), on_conflict="replace")
        text = response.get_data(as_text=True)
        self.assertIn("Failed to extract archive: disk went away", text)
        self.assertNotIn("Upload complete.", text)
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4"])
        self.assertEqual((self.media_dir / "clips" / "a.mp4").read_bytes(), b"old-a")

    def test_failed_extraction_does_not_print_upload_complete(self):
        response = self.upload("broken.zip", b"this is not a zip")
        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("Failed to extract archive: ", text)
        self.assertNotIn("Upload complete.", text)
        self.assertNotIn("Archive extracted.", text)
        self.assertEqual(self.media_listing(), ["clips", "clips/a.mp4", "clips/gone.mp4"], "no half-extracted folder remains")
        self.optimize.assert_not_called()

    def test_replacing_a_file_with_an_archive_folder_is_refused(self):
        (self.media_dir / "report").write_bytes(b"a file")
        response = self.upload("report.zip", zip_bytes({"a.mp4": b"a"}), on_conflict="replace")
        self.assertEqual(response.status_code, 400)
        self.assertEqual((self.media_dir / "report").read_bytes(), b"a file")


class ReplaceArchiveRestartsSlotsTests(UploadFixture):
    def setUp(self):
        super().setUp()
        (self.media_dir / "clips").mkdir()
        (self.media_dir / "clips" / "a.mp4").write_bytes(b"old-a")
        (self.media_dir / "clips" / "gone.mp4").write_bytes(b"old-gone")
        playing = {"type": "file", "state": "playing", "transport": "rtsp", "codec": "h264"}
        self.write_slots(
            {"index": 1, "file": "clips/a.mp4", **playing},
            {"index": 2, "file": "clips/gone.mp4", **playing},
            {"index": 3, "file": "elsewhere.mp4", **playing},
            {"index": 4, "file": "clips/gone.mp4", **{**playing, "state": "stopped"}},
        )

    def test_slots_streaming_files_of_the_replaced_folder_restart(self):
        response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}), on_conflict="replace")
        lines = response.get_data(as_text=True).splitlines()
        self.assertIn("Restarted src1.", lines)
        self.assertEqual(lines[-1], "Upload complete.")
        stopped = {call.args[0] for call in self.stop_stream.call_args_list}
        self.assertTrue({1, 2} <= stopped and 3 not in stopped, stopped)
        self.assertEqual(self.slot(1)["state"], "playing")
        self.assertEqual(self.slot(3)["state"], "playing")

    def test_slots_assigned_to_files_the_new_archive_lacks_are_unassigned_not_restarted(self):
        response = self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}), on_conflict="replace")
        text = response.get_data(as_text=True)
        self.assertNotIn("src2", text)
        self.assertNotIn("src4", text)
        for index in (2, 4):  # one was playing, one only assigned: both are cleared as delete-media does
            self.assertEqual((self.slot(index)["file"], self.slot(index)["state"]), ("", "stopped"), f"src{index}")
        self.assertEqual(self.slot(1)["file"], "clips/a.mp4")
        self.assertEqual(self.slot(3)["file"], "elsewhere.mp4")

    def test_renditions_of_every_old_file_in_the_folder_are_forgotten(self):
        self.upload("clips.zip", zip_bytes({"a.mp4": b"new-a"}), on_conflict="replace")
        forgotten = sorted(call.args[2] for call in self.remove_renditions.call_args_list)
        self.assertEqual(forgotten, ["clips/a.mp4", "clips/gone.mp4"])

    def test_a_failed_extraction_stops_nothing(self):
        self.upload("clips.zip", b"this is not a zip", on_conflict="replace")
        self.stop_stream.assert_not_called()
        self.start_stream.assert_not_called()
        self.remove_renditions.assert_not_called()


if __name__ == "__main__":
    unittest.main()
