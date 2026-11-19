import os
import threading
import unittest
import unittest.mock as mock
from types import SimpleNamespace

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55587")

from neat_insight import app as app_module


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


class SysMetricsTests(unittest.TestCase):
    """The profiler's `sys` topic publishes these readings (System Info reads the server's own)."""

    def test_the_readings_keep_their_fields(self):
        memory = SimpleNamespace(total=1000, used=250, percent=25.0)
        disk = SimpleNamespace(total=100, used=40, free=60, percent=40.0)

        with mock.patch.object(app_module, "is_sima_board", return_value=False), \
             mock.patch.object(app_module.psutil, "cpu_percent", return_value=3.5), \
             mock.patch.object(app_module.psutil, "virtual_memory", return_value=memory), \
             mock.patch.object(app_module.psutil, "disk_usage", return_value=disk), \
             mock.patch.object(app_module, "_local_cpu", app_module.LocalCpuReader(clock=FakeClock())):
            body = app_module.collect_system_metrics()

        self.assertEqual(
            set(body),
            {"cpu_load", "memory", "disk", "mla_allocated_bytes", "temperature_celsius_avg", "REMOTE", "pipeline_status"},
        )
        self.assertEqual(body["cpu_load"], 3.5)
        self.assertEqual(body["memory"], {"total": 1000, "used": 250, "percent": 25.0})
        self.assertEqual(body["disk"]["mount"], str(app_module.Path.home()))
        self.assertIs(body["REMOTE"], False)


if __name__ == "__main__":
    unittest.main()
