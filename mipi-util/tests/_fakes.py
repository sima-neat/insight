"""Fake subprocess plumbing so the API can be exercised on a plain host with no
camera, no v4l2-ctl, and no gstreamer. Every test that touches an endpoint runs
through these instead of the real `subprocess`."""


class FakeCompleted:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


# Records every Popen invocation (list form) so tests can assert *what* was
# launched — e.g. that a service restart shelled `systemctl restart ...` and
# never `reboot`.
POPEN_CALLS = []


class FakePopen:
    def __init__(self, cmd, *a, **k):
        self.cmd = cmd
        self.pid = 4242
        self.returncode = 0
        POPEN_CALLS.append(list(cmd) if isinstance(cmd, (list, tuple)) else [cmd])

    def poll(self):
        return None

    def kill(self):
        pass

    def wait(self, timeout=None):
        return 0

    def communicate(self, *a, **k):
        return (b"", b"")


def default_run(cmd, *a, **k):
    """Enough of a v4l2-ctl to satisfy the read/set/list paths the endpoints
    use. Returns a benign, in-range value for gets and success for sets."""
    c = list(cmd) if isinstance(cmd, (list, tuple)) else cmd.split()
    if "--get-ctrl" in c:
        return FakeCompleted(stdout=f"{c[-1]}: 100\n")
    if "--set-ctrl" in c:
        return FakeCompleted(returncode=0)
    if "--list-ctrls" in c:
        return FakeCompleted(stdout="")
    if "--info" in c:
        return FakeCompleted(stdout="Card type     : imx477\n")
    return FakeCompleted(stdout="")
