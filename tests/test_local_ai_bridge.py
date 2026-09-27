import http.client
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_local


def valid_context():
    frame = {"available": False, "score": None, "candleCount": 0, "indicators": None, "factors": [], "recentCandles": None}
    return {
        "schemaVersion": 1, "symbol": "BTCUSDT", "generatedAt": 1,
        "market": {"price": 100.0, "quoteCurrency": "USDT", "source": "openbare testgegevens", "timestamp": 1},
        "technicalSignal": None,
        "timeframes": {name: frame for name in ("15m", "1h", "4h", "1d")},
        "missingData": ["Geen echte testkoers gebruikt."], "earlierAnalysis": None,
    }


class LocalAiBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = run_local.create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host, cls.port = cls.server.server_address
        cls.origin = f"http://{cls.host}:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=3)
        body = json.dumps(payload) if payload is not None else None
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_dashboard_and_unconfigured_status(self):
        status, page = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"AI-analyse", page)
        status, body = self.request("GET", "/api/ai/status")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["analysisAvailable"])

    def test_valid_context_is_not_forwarded_without_provider(self):
        status, body = self.request("POST", "/api/ai/analyze", valid_context(), {"Origin": self.origin})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "ai_provider_not_configured")

    def test_rejects_other_origin_and_secret_fields(self):
        headers = {"Origin": self.origin}
        status, _ = self.request("POST", "/api/ai/analyze", valid_context(), {"Origin": "https://example.com"})
        self.assertEqual(status, 403)
        context = valid_context()
        context["apiKey"] = "never accepted"
        status, _ = self.request("POST", "/api/ai/analyze", context, headers)
        self.assertEqual(status, 400)

    def test_rejects_non_finite_values_and_unknown_routes(self):
        context = valid_context()
        context["market"]["price"] = float("nan")
        status, _ = self.request("POST", "/api/ai/analyze", context, {"Origin": self.origin})
        self.assertEqual(status, 400)
        status, _ = self.request("POST", "/api/orders", valid_context(), {"Origin": self.origin})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
