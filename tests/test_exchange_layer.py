import contextlib
import io
import json
import os
import threading
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

import exchange_layer as layer
import run_local


class FakeTransport:
    def __init__(self, responses=None, error=None):
        self.responses = responses or []
        self.error = error
        self.calls = []

    def __call__(self, url, headers, timeout):
        self.calls.append((url, headers, timeout))
        if self.error:
            raise self.error
        path = urlsplit(url).path
        if path == "/api/v3/ping": return {}
        if path == "/api/v3/account":
            return {"balances": [{"asset": "BTC", "free": "0.125", "locked": "0"},
                                  {"asset": "USDT", "free": "25.5", "locked": "1"},
                                  {"asset": "ZERO", "free": "0", "locked": "0"}]}
        if path == "/api/v3/openOrders": return []
        if path == "/api/v3/exchangeInfo":
            return {"symbols": [
                {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "status": "TRADING", "isSpotTradingAllowed": True},
                {"symbol": "ETHBTC", "baseAsset": "ETH", "quoteAsset": "BTC", "status": "TRADING", "isSpotTradingAllowed": True},
                {"symbol": "OLDUSDT", "baseAsset": "OLD", "quoteAsset": "USDT", "status": "BREAK", "isSpotTradingAllowed": True},
            ]}
        return {}


class ExchangeProviderTests(unittest.TestCase):
    def test_unconfigured_and_partial_configuration(self):
        self.assertFalse(layer.BinanceSpotReadOnly(api_key="", api_secret="").status()["configured"])
        self.assertTrue(layer.BinanceSpotReadOnly(api_key="key", api_secret="").status()["partial"])

    def test_readonly_test_account_balances_open_orders_and_dynamic_markets(self):
        transport = FakeTransport()
        provider = layer.BinanceSpotReadOnly("dummy-key", "dummy-secret", sandbox=True, transport=transport)
        result = provider.test_connection()
        self.assertTrue(result["connected"])
        self.assertTrue(result["readOnly"])
        self.assertFalse(result["tradingEnabled"])
        self.assertEqual([b["asset"] for b in result["balances"]], ["BTC", "USDT"])
        markets = provider.markets()
        self.assertEqual([(m["symbol"], m["quote"]) for m in markets], [("BTCUSDT", "USDT"), ("ETHBTC", "BTC")])
        provider.open_orders()
        self.assertTrue(all(urlsplit(call[0]).scheme == "https" for call in transport.calls))
        self.assertTrue(all("/testnet.binance.vision/" in call[0] for call in transport.calls))
        self.assertTrue(all(urlsplit(call[0]).query and "signature=" in urlsplit(call[0]).query for call in transport.calls if "/account" in call[0] or "/openOrders" in call[0]))
        self.assertTrue(all(call[1].get("X-MBX-APIKEY") == "dummy-key" for call in transport.calls if "/account" in call[0] or "/openOrders" in call[0]))
        self.assertTrue(all(call[2] <= 8 for call in transport.calls))

    def test_invalid_credentials_timeout_and_network_failure_are_sanitized(self):
        for error, expected in ((HTTPError("https://private/?signature=secret", 401, "bad", {}, None), "credentials_invalid"),
                                (TimeoutError("dummy-secret"), "timeout"),
                                (URLError("dummy-key"), "exchange_unavailable")):
            with self.subTest(expected=expected):
                provider = layer.BinanceSpotReadOnly("dummy-key", "dummy-secret", transport=FakeTransport(error=error))
                with self.assertRaises(layer.ExchangeError) as caught:
                    provider.test_connection()
                self.assertEqual(caught.exception.code, expected)
                self.assertNotIn("dummy-key", str(caught.exception))
                self.assertNotIn("dummy-secret", str(caught.exception))

    def test_no_order_transfer_or_withdraw_action_in_any_mode(self):
        for action in ("place_order", "buy", "sell", "withdraw", "transfer", "deposit"):
            for mode in ("PAPER", "TESTNET", "LIVE"):
                with self.subTest(action=action, mode=mode), self.assertRaises(layer.ExchangeError):
                    layer.assert_action_blocked(action, mode, user_confirmed=True)

    def test_server_status_and_forbidden_order_routes(self):
        old = {name: os.environ.pop(name, None) for name in ("EXCHANGE_PROVIDER", "EXCHANGE_API_KEY", "EXCHANGE_API_SECRET")}
        server = run_local.create_server(0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urlopen(base + "/api/exchange/status") as response:
                status = json.load(response)
            self.assertFalse(status["connected"])
            self.assertTrue(status["readOnly"])
            self.assertFalse(status["tradingEnabled"])
            request = Request(base + "/api/orders", data=b"{}", headers={"Origin": base}, method="POST")
            with self.assertRaises(HTTPError) as caught: urlopen(request)
            self.assertEqual(caught.exception.code, 404)
            request = Request(base + "/api/exchange/test", data=b"{}", headers={"Origin": base}, method="POST")
            with self.assertRaises(HTTPError) as caught: urlopen(request)
            self.assertEqual(caught.exception.code, 503)
            self.assertIn("ingesteld", caught.exception.read().decode("utf-8").lower())
        finally:
            server.shutdown(); server.server_close(); thread.join(2)
            for name, value in old.items():
                if value is not None: os.environ[name] = value

    def test_secrets_not_in_status_and_dashboard_has_no_secret_inputs(self):
        status = layer.BinanceSpotReadOnly("never-show-this-key", "never-show-this-secret").status()
        self.assertNotIn("never-show-this-key", json.dumps(status))
        self.assertNotIn("never-show-this-secret", json.dumps(status))
        with open("index.html", encoding="utf-8") as f: page = f.read().lower()
        self.assertNotIn('id="api-key"', page)
        self.assertNotIn('id="api-secret"', page)
        self.assertNotIn("never-show-this", page)
        with self.assertRaises(layer.ExchangeError): layer.create_provider() if os.environ.get("EXCHANGE_PROVIDER") == "invalid" else layer.assert_action_blocked("create_order")


if __name__ == "__main__":
    unittest.main()
