import os
from setuptools import setup, find_packages
from setuptools.dist import Distribution
from wheel.bdist_wheel import bdist_wheel as _bdist_wheel

version = os.environ.get("PACKAGE_VERSION", "0.0.0")


class BinaryDistribution(Distribution):
    def has_ext_modules(self):
        return True

    def is_pure(self):
        return False


class PlatformPy3Wheel(_bdist_wheel):
    def finalize_options(self):
        super().finalize_options()
        self.root_is_pure = False

    def get_tag(self):
        _, _, plat = super().get_tag()
        return "py3", "none", plat


setup(
    name="neat-insight",
    version=version,
    description="Sima.ai Vision ML Development Tool",
    author="Sima.ai",
    author_email="support@sima.ai",
    license="MIT",
    packages=find_packages(exclude=["neat_insight.bin*"]),
    include_package_data=True,
    zip_safe=False,
    package_data={
        "neat_insight": [
            # The server, with the web UI built in, and the MediaMTX it runs.
            "bin/neat-insight",
            "bin/mediamtx",
            "bin/mediamtx.yml",
            "bin/ffmpeg_nodelay.so",
            "tools/*",
        ]
    },
    entry_points={
        "console_scripts": [
            "neat-insight = neat_insight.launcher:main",
            "neat-insight-metadata-test = neat_insight.tools.metadata_test:main",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.10",
    distclass=BinaryDistribution,
    cmdclass={"bdist_wheel": PlatformPy3Wheel},
)
