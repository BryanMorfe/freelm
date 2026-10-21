# Bundled search third-party notices

FreeLM ships an offline-installed, separate SearXNG helper. Its full pinned upstream source and license are included in `source/` during preparation; FreeLM's `launcher.py` is distributed alongside it under AGPL-3.0-or-later, with the license also available in [LICENSE](LICENSE). The helper executes in a separate process and never downloads software at runtime.

SearXNG: `3cd69d30e2a78dfc817be9e349e7c2e4317c92e3` (`2026.9.23+3cd69d30e`), AGPL-3.0-or-later. Source: https://github.com/searxng/searxng . Full license: `source/LICENSE`.

CPython 3.12.14 from Astral python-build-standalone release 20260929. Source/build provenance: https://github.com/astral-sh/python-build-standalone . CPython's license is included in each `runtime/<target>/python/lib/python3.12/LICENSE.txt`. The complete upstream component-license collection, including OpenSSL, libffi, SQLite, and compression-library notices, is included in `licenses/python-standalone/` at build revision `b498734a5791d0e6786695a226fd398a41c6f7f6`; individual file hashes and source URLs are pinned in `manifest.json`. This upstream collection covers multiple build variants; component availability varies by target.

Python dependencies below use exact official PyPI wheels, verified against their SHA-256 metadata. Original license files and copyright notices remain in `runtime/<target>/site-packages/*.dist-info/` (including `licenses/`); package metadata is preserved. `manifest.json` records each architecture-specific artifact URL, hash, version, size, and declared license. `requirements.lock` records all allowed wheel hashes.

| Dependency        | Version     | Declared license / notice location                     |
| ----------------- | ----------- | ------------------------------------------------------ |
| annotated-doc     | 0.0.5       | MIT                                                    |
| babel             | 2.18.0      | BSD-3-Clause                                           |
| blinker           | 1.9.0       | See bundled dist-info notices                          |
| certifi           | 2026.7.22   | MPL-2.0                                                |
| cffi              | 2.1.1       | MIT-0                                                  |
| click             | 8.5.0       | BSD-3-Clause                                           |
| curl_cffi         | 0.16.3      | MIT                                                    |
| Flask             | 3.1.3       | BSD-3-Clause                                           |
| flask-babel       | 4.0.0       | BSD-3-Clause                                           |
| isodate           | 0.7.2       | Copyright (c) 2021, Hugo van Kemenade and contributors |
| itsdangerous      | 2.2.0       | See bundled dist-info notices                          |
| Jinja2            | 3.1.6       | See bundled dist-info notices                          |
| lxml              | 6.1.3       | BSD-3-Clause                                           |
| markdown-it-py    | 4.2.0       | See bundled dist-info notices                          |
| MarkupSafe        | 3.0.3       | BSD-3-Clause                                           |
| mdurl             | 0.1.2       | See bundled dist-info notices                          |
| msgspec           | 0.21.1      | BSD-3-Clause                                           |
| pycparser         | 3.0         | BSD-3-Clause                                           |
| Pygments          | 2.21.0      | BSD-2-Clause                                           |
| python-dateutil   | 2.9.0.post0 | Dual License                                           |
| pytz              | 2026.4      | MIT                                                    |
| PyYAML            | 6.0.3       | MIT                                                    |
| rich              | 15.0.0      | MIT                                                    |
| shellingham       | 1.5.4       | ISC License                                            |
| six               | 1.17.0      | MIT                                                    |
| typer             | 0.27.2      | MIT                                                    |
| typing_extensions | 4.16.0      | PSF-2.0                                                |
| valkey            | 6.1.1       | MIT                                                    |
| waitress          | 3.0.2       | ZPL 2.1                                                |
| Werkzeug          | 3.1.9       | BSD-3-Clause                                           |
| whitenoise        | 6.12.0      | MIT                                                    |
