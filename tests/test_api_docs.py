import json
import os
import re
import unittest


os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55585")

from neat_insight import app as app_module
from neat_insight.api_docs import SWAGGER_UI_VERSION


HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def _openapi_path_for_flask_rule(rule: str) -> str:
    return re.sub(r"<(?:(?:path|int|string):)?([^>]+)>", r"{\1}", rule)


def _follow_json_pointer(document, ref: str):
    value = document
    for raw_part in ref.removeprefix("#/").split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        value = value[part]
    return value


class ApiDocumentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_module.app.config.update(TESTING=True)
        cls.client = app_module.app.test_client()
        response = cls.client.get("/api/openapi.json")
        cls.spec = json.loads(response.data)
        response.close()

    def test_openapi_document_is_served_as_openapi_json(self):
        response = self.client.get("/api/openapi.json")
        self.addCleanup(response.close)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content_type.startswith("application/vnd.oai.openapi+json"))
        self.assertEqual(self.spec["openapi"], "3.1.0")
        self.assertEqual(self.spec["info"]["title"], "Neat Insight API")

    def test_swagger_ui_loads_the_local_spec_with_pinned_assets(self):
        response = self.client.get("/api/docs")
        self.addCleanup(response.close)
        html = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/html")
        self.assertIn('url: "/api/openapi.json"', html)
        self.assertIn(f"swagger-ui-dist@{SWAGGER_UI_VERSION}/swagger-ui.css", html)
        self.assertIn(f"swagger-ui-dist@{SWAGGER_UI_VERSION}/swagger-ui-bundle.js", html)
        self.assertIn("validatorUrl: null", html)
        self.assertEqual(response.headers["Cache-Control"], "no-store, max-age=0")

    def test_openapi_operations_match_every_registered_api_route(self):
        flask_operations = set()
        for rule in app_module.app.url_map.iter_rules():
            if not rule.rule.startswith("/api/"):
                continue
            path = _openapi_path_for_flask_rule(rule.rule)
            for method in rule.methods:
                method = method.lower()
                if method in HTTP_METHODS:
                    flask_operations.add((path, method))

        documented_operations = {
            (path, method)
            for path, path_item in self.spec["paths"].items()
            if path.startswith("/api/")
            for method in path_item
            if method in HTTP_METHODS
        }

        self.assertEqual(documented_operations, flask_operations)

    def test_every_operation_has_a_unique_id_summary_and_response(self):
        operation_ids = []
        for path, path_item in self.spec["paths"].items():
            for method, operation in path_item.items():
                if method not in HTTP_METHODS:
                    continue
                with self.subTest(method=method, path=path):
                    self.assertTrue(operation.get("summary"))
                    self.assertTrue(operation.get("operationId"))
                    self.assertTrue(operation.get("responses"))
                operation_ids.append(operation["operationId"])

        self.assertEqual(len(operation_ids), len(set(operation_ids)))

    def test_every_internal_reference_resolves(self):
        def refs(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    yield value["$ref"]
                for child in value.values():
                    yield from refs(child)
            elif isinstance(value, list):
                for child in value:
                    yield from refs(child)

        for ref in refs(self.spec):
            with self.subTest(ref=ref):
                self.assertTrue(ref.startswith("#/"))
                self.assertIsNotNone(_follow_json_pointer(self.spec, ref))

    def test_sysinfo_documents_command_failure_statuses(self):
        responses = self.spec["paths"]["/api/sysinfo"]["get"]["responses"]

        self.assertEqual(
            responses["502"]["$ref"], "#/components/responses/BadGateway"
        )
        self.assertEqual(
            responses["504"]["$ref"], "#/components/responses/GatewayTimeout"
        )

    def test_workspace_contract_matches_index_and_raw_preview_behavior(self):
        search_description = self.spec["paths"]["/api/workspace/search"]["get"][
            "description"
        ]
        raw_description = self.spec["paths"]["/api/workspace/raw"]["get"][
            "description"
        ]
        workspace_properties = self.spec["components"]["schemas"]["WorkspaceNode"][
            "properties"
        ]

        self.assertIn("members inside them are not indexed", search_description)
        self.assertIn("archive-member paths are not supported", raw_description)
        self.assertIn("mtime", workspace_properties)
        self.assertNotIn("modified", workspace_properties)


if __name__ == "__main__":
    unittest.main()
