import os
import threading
import unittest
import unittest.mock as mock
from types import SimpleNamespace

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55587")

from neat_insight import app as app_module
from neat_insight import remote_devkit


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class LocalCpuTests(unittest.TestCase):
    def test_local_cpu_is_read_without_blocking(self):
        with mock.patch.object(app_module.psutil, "cpu_percent", return_value=12.5) as cpu_percent:
            reader = app_module.LocalCpuReader(clock=FakeClock())
            value = reader.read()

        self.assertEqual(value, 12.5)
        # The priming call and the reading are the only two, and neither passes an interval, which
        # would block the request for that long.
        self.assertEqual(cpu_percent.call_args_list, [mock.call(interval=None)] * 2)

    def test_reads_from_every_thread_share_one_psutil_baseline(self):
        # psutil keeps its "previous call" per calling thread, and a thread's first call answers a
        # meaningless 0.0. Flask answers each request on its own thread, so the reader must make
        # every psutil call from one thread of its own.
        callers = []

        def cpu_percent(interval=None):
            callers.append(threading.get_ident())
            return 7.0

        clock = FakeClock()
        with mock.patch.object(app_module.psutil, "cpu_percent", side_effect=cpu_percent):
            reader = app_module.LocalCpuReader(clock=clock)
            for _ in range(3):
                clock.now += 10
                worker = threading.Thread(target=reader.read)
                worker.start()
                worker.join()

        self.assertEqual(len(callers), 4)
        self.assertEqual(len(set(callers)), 1)
        self.assertNotIn(threading.get_ident(), callers)

    def test_a_second_read_within_the_minimum_interval_repeats_the_reading(self):
        clock = FakeClock()
        readings = iter([1.0, 40.0, 60.0])
        with mock.patch.object(app_module.psutil, "cpu_percent", side_effect=lambda interval=None: next(readings)) as cpu_percent:
            reader = app_module.LocalCpuReader(min_interval_sec=0.5, clock=clock)
            first = reader.read()
            clock.now += 0.01
            second = reader.read()
            clock.now += 2.0
            third = reader.read()

        self.assertEqual((first, second, third), (40.0, 40.0, 60.0))
        self.assertEqual(cpu_percent.call_count, 3)


class RemoteCpuTests(unittest.TestCase):
    def test_remote_cpu_is_total_time_not_user_time(self):
        procps_ng = "%Cpu(s):  5.9 us,  2.0 sy,  0.0 ni, 91.2 id,  0.5 wa,  0.0 hi,  0.4 si,  0.0 st"
        older_procps = "Cpu(s):  5.9%us,  2.0%sy,  0.0%ni, 91.2%id,  0.5%wa,  0.0%hi,  0.4%si,  0.0%st"

        self.assertEqual(remote_devkit.remote_cpu_percent(procps_ng), 8.8)
        self.assertEqual(remote_devkit.remote_cpu_percent(older_procps), 8.8)
        self.assertEqual(remote_devkit.remote_cpu_percent("%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id"), 0.0)

    def test_remote_cpu_without_an_idle_field_is_none(self):
        self.assertIsNone(remote_devkit.remote_cpu_percent(""))
        self.assertIsNone(remote_devkit.remote_cpu_percent("%Cpu(s):  5.9 us,  2.0 sy"))

    def test_remote_metrics_use_the_total_cpu(self):
        outputs = {
            "top -bn1 | grep 'Cpu(s)'": "%Cpu(s):  5.9 us,  2.0 sy,  0.0 ni, 91.2 id,  0.5 wa",
            "free -b": "Mem:  1000  250  750",
            "df -B1 /data | tail -1": "/dev/x 100 40 60 40% /data",
        }

        class FakeSsh:
            def exec_command(self, command):
                return None, SimpleNamespace(read=lambda: outputs.get(command, "").encode()), None

            def close(self):
                pass

        with mock.patch.object(remote_devkit, "create_ssh_client", return_value=FakeSsh()), \
             mock.patch.object(remote_devkit, "remote_board_type", return_value=None):
            metrics = remote_devkit.get_remote_metrics()

        self.assertEqual(metrics["cpu_load"], 8.8)


class MetricsResponseTests(unittest.TestCase):
    def test_metrics_response_keeps_its_fields(self):
        app_module.app.config.update(TESTING=True)
        client = app_module.app.test_client()
        memory = SimpleNamespace(total=1000, used=250, percent=25.0)
        disk = SimpleNamespace(total=100, used=40, free=60, percent=40.0)

        with mock.patch.object(app_module, "is_remote_devkit_configured", return_value=False), \
             mock.patch.object(app_module, "is_sima_board", return_value=False), \
             mock.patch.object(app_module.psutil, "cpu_percent", return_value=3.5), \
             mock.patch.object(app_module.psutil, "virtual_memory", return_value=memory), \
             mock.patch.object(app_module.psutil, "disk_usage", return_value=disk), \
             mock.patch.object(app_module, "_local_cpu", app_module.LocalCpuReader(clock=FakeClock())):
            response = client.get("/api/metrics")
            self.addCleanup(response.close)
            body = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(body),
            {"cpu_load", "memory", "disk", "mla_allocated_bytes", "temperature_celsius_avg", "REMOTE", "pipeline_status"},
        )
        self.assertEqual(body["cpu_load"], 3.5)
        self.assertEqual(body["memory"], {"total": 1000, "used": 250, "percent": 25.0})
        self.assertEqual(body["disk"]["mount"], str(app_module.Path.home()))
        self.assertEqual(body["mla_allocated_bytes"], 0)
        self.assertIsNone(body["temperature_celsius_avg"])
        self.assertIs(body["REMOTE"], False)
        self.assertEqual(body["pipeline_status"], {})


if __name__ == "__main__":
    unittest.main()
