import json
from importlib.resources import files

from flask import Blueprint, Response, send_file, url_for


api_docs_bp = Blueprint("api_docs", __name__)
SWAGGER_UI_VERSION = "5.32.11"


def _openapi_path():
    return files("neat_insight").joinpath("openapi.json")


@api_docs_bp.get("/api/openapi.json")
def openapi_spec():
    """Return the machine-readable OpenAPI description for Insight's HTTP API."""
    return send_file(
        _openapi_path(),
        mimetype="application/vnd.oai.openapi+json;version=3.1",
        download_name="neat-insight-openapi.json",
        conditional=True,
        max_age=300,
    )


@api_docs_bp.get("/api/docs")
def swagger_ui():
    """Render interactive Swagger UI documentation for Insight's HTTP API."""
    spec_url = json.dumps(url_for("api_docs.openapi_spec"))
    version = SWAGGER_UI_VERSION
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Interactive API reference for Neat Insight">
    <title>Neat Insight API reference</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@{version}/swagger-ui.css">
    <style>
      html {{ box-sizing: border-box; overflow-y: scroll; }}
      *, *::before, *::after {{ box-sizing: inherit; }}
      body {{ margin: 0; background: #fafafa; }}
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@{version}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.addEventListener("load", function () {{
        window.ui = SwaggerUIBundle({{
          url: {spec_url},
          dom_id: "#swagger-ui",
          deepLinking: true,
          displayRequestDuration: true,
          filter: true,
          validatorUrl: null,
          presets: [SwaggerUIBundle.presets.apis]
        }});
      }});
    </script>
  </body>
</html>
"""
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response
