"""WSGI entrypoint (gunicorn: `gunicorn config.wsgi:application`)."""
import os
import sys
from pathlib import Path

# Keep the repo root importable for `pg.faq_api.*` regardless of how gunicorn is launched.
_repo_root = Path(__file__).resolve().parent.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()
