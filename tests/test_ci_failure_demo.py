import unittest


class CiFailureDemoTests(unittest.TestCase):
    """Deliberate failure to show the Unit tests job fails CI (#152). Removed in the next commit."""

    def test_deliberate_failure(self):
        self.assertEqual(1, 2)
