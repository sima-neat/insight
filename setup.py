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
    packages=find_packages(exclude=["neat_insight.bin*", "neat_insight.bin.static*"]),
    include_package_data=True,
    zip_safe=False,
    install_requires=[
        "flask",
        "pillow",
        "pymediainfo",
        "psutil",
        "pyzmq",
        "cryptography>=41.0.5,<45",
        "paramiko"
    ],
    package_data={
        "neat_insight": [
            "bin/vf",
            "bin/vf.exe",
            "bin/mediamtx",
            "bin/mediamtx.exe",
            "bin/mediamtx.yml",
            "bin/static/*",
            "bin/static/**/*",
            "frontend_dist/*",
            "frontend_dist/**/*",
            "tools/*",
        ]
    },
    entry_points={
        "console_scripts": [
            "neat-insight = neat_insight.app:main",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "Framework :: Flask",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.8",
    distclass=BinaryDistribution,
    cmdclass={"bdist_wheel": PlatformPy3Wheel},
)
