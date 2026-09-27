"""Start the local-only web server and unconfigured AI safety boundary."""

from __future__ import annotations

import json
import math
import re
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from exchange_layer import ExchangeError, assert_action_blocked, create_provider
from testnet_trading import TestnetError, create_testnet_service

PROJECT_ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765
MAX_REQUEST_BYTES = 64 * 1024
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9]{2,24}USDT$")
INTERVALS = {"15m", "1h", "4h", "1d"}
FACTOR_KEYS = {"trend", "macd", "sma20", "sma50", "sma200", "ema20", "ema50", "rsi", "volume", "movement"}
ALLOWED_ANALYSIS_FIELDS = {
    "schemaVersion", "symbol", "generatedAt", "market", "technicalSignal",
    "timeframes", "missingData", "earlierAnalysis",
}


def _finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _valid_analysis_payload(payload: dict) -> bool:
    """Bound and validate the public market context before any provider could use it."""
    if payload.get("schemaVersion") != 1 or not SYMBOL_PATTERN.fullmatch(payload.get("symbol", "")):
        return False
    if type(payload.get("generatedAt")) is not int or payload["generatedAt"] <= 0:
        return False
    market = payload.get("market")
    if market is not None:
        if not isinstance(market, dict) or set(market) - {"price", "quoteCurrency", "source", "timestamp"}:
            return False
        if not _finite_number(market.get("price")) or market["price"] <= 0 or market.get("quoteCurrency") != "USDT":
            return False
        if not isinstance(market.get("source"), str) or len(market["source"]) > 80 or not _finite_number(market.get("timestamp")):
            return False
    signal = payload.get("technicalSignal")
    if signal is not None:
        if not isinstance(signal, dict) or set(signal) - {"label", "score", "factorAlignment", "disagreement", "timeframes"}:
            return False
        if signal.get("label") not in {"KOPEN", "MOGELIJK KOPEN", "GEEN ACTIE", "MOGELIJK VERKOPEN", "VERKOPEN"}:
            return False
        if not _finite_number(signal.get("score")) or not -100 <= signal["score"] <= 100:
            return False
        if not _finite_number(signal.get("factorAlignment")) or not 0 <= signal["factorAlignment"] <= 100 or not isinstance(signal.get("disagreement"), bool):
            return False
        if not isinstance(signal.get("timeframes"), dict) or set(signal["timeframes"]) - INTERVALS:
            return False
    timeframes = payload.get("timeframes")
    if not isinstance(timeframes, dict) or set(timeframes) != INTERVALS:
        return False
    for frame in timeframes.values():
        if not isinstance(frame, dict) or set(frame) - {"available", "score", "candleCount", "indicators", "factors", "recentCandles"}:
            return False
        if not isinstance(frame.get("available"), bool) or type(frame.get("candleCount")) is not int or not 0 <= frame["candleCount"] <= 210:
            return False
        if frame.get("score") is not None and (not _finite_number(frame["score"]) or not -100 <= frame["score"] <= 100):
            return False
        factors = frame.get("factors")
        if not isinstance(factors, list) or len(factors) > len(FACTOR_KEYS):
            return False
        for factor in factors:
            if not isinstance(factor, dict) or set(factor) != {"key", "direction", "weight", "evidence"}:
                return False
        readings = frame.get("indicators")
        if readings is not None:
            if not isinstance(readings, dict) or set(readings) - {"trend", "rsi", "macd", "macdValues", "averages", "volume", "priceAbove"}:
                return False
            if readings.get("rsi") is not None and not _finite_number(readings["rsi"]):
                return False
            for group, allowed in (("macdValues", {"line", "signal", "histogram"}),
                                   ("averages", {"sma20", "sma50", "sma200", "ema20", "ema50"}),
                                   ("priceAbove", {"sma20", "sma50", "sma200"})):
                values = readings.get(group)
                if not isinstance(values, dict) or set(values) - allowed:
                    return False
                if group == "priceAbove":
                    if any(value not in (True, False, None) for value in values.values()):
                        return False
                elif any(value is not None and not _finite_number(value) for value in values.values()):
                    return False
            volume = readings.get("volume")
            if volume is not None and (not isinstance(volume, dict) or set(volume) - {"comparison", "latest", "average"}
                                       or not isinstance(volume.get("comparison"), str)
                                       or any(not _finite_number(volume.get(name)) for name in ("latest", "average"))):
                return False
            if factor["key"] not in FACTOR_KEYS or not _finite_number(factor["direction"]) or not -1 <= factor["direction"] <= 1:
                return False
            if not _finite_number(factor["weight"]) or factor["weight"] <= 0 or not isinstance(factor["evidence"], str) or len(factor["evidence"]) > 240:
                return False
        candles = frame.get("recentCandles")
        if candles is not None:
            if not isinstance(candles, list) or len(candles) > 20:
                return False
            for candle in candles:
                if not isinstance(candle, dict) or set(candle) != {"time", "open", "high", "low", "close", "volume"}:
                    return False
                if any(not _finite_number(candle[field]) for field in candle):
                    return False
    missing = payload.get("missingData")
    if not isinstance(missing, list) or len(missing) > 20 or any(not isinstance(item, str) or len(item) > 240 for item in missing):
        return False
    if payload.get("earlierAnalysis") is not None:
        return False
    return True


class LocalAssistantHandler(SimpleHTTPRequestHandler):
    """Serve the dashboard locally; never forwards requests to an AI or exchange."""

    server_version = "LocalAssistant/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def log_message(self, format_string, *args):
        # Do not log payloads or user data.
        print(f"[lokaal] {self.address_string()} - {format_string % args}")

    def _expected_origin(self) -> str:
        return f"http://{HOST}:{self.server.server_port}"

    def _valid_host(self) -> bool:
        return self.headers.get("Host", "").lower() == f"{HOST}:{self.server.server_port}"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self) -> None:
        self._send_json(404, {"error": "not_found"})

    def do_GET(self):
        if not self._valid_host():
            self._send_json(403, {"error": "host_not_allowed"})
            return
        route = urlsplit(self.path).path
        if route.startswith("/api/testnet/"):
            self._testnet_get(route)
            return
        if route.startswith("/api/exchange/"):
            self._exchange_get(route)
            return
        if route == "/api/ai/status":
            self._send_json(200, {
                "providerConfigured": False,
                "analysisAvailable": False,
                "message": "Lokale aansluiting actief. Er is nog geen AI-dienst gekozen; er wordt niets naar een AI verstuurd.",
            })
            return
        if route.startswith("/api/"):
            self._not_found()
            return
        disk_path = self._safe_path(self.path)
        if disk_path is None or (disk_path.is_dir() and route != "/"):
            self._not_found()
            return
        if disk_path.is_dir() and not (disk_path / "index.html").is_file():
            self._not_found()
            return
        super().do_GET()

    def do_POST(self):
        if not self._valid_host():
            self._send_json(403, {"error": "host_not_allowed"})
            return
        if self.headers.get("Origin") != self._expected_origin():
            self._send_json(403, {"error": "origin_not_allowed"})
            return
        route = urlsplit(self.path).path
        if route.startswith("/api/testnet/"):
            self._testnet_post(route)
            return
        if route == "/api/exchange/test":
            self._exchange_test()
            return
        if route != "/api/ai/analyze":
            self._not_found()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "invalid_content_length"})
            return
        if length < 1 or length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "request_too_large_or_empty"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid_json"})
            return
        if not isinstance(payload, dict) or set(payload) - ALLOWED_ANALYSIS_FIELDS:
            self._send_json(400, {"error": "unexpected_analysis_fields"})
            return
        symbol = payload.get("symbol")
        if not isinstance(symbol, str) or not SYMBOL_PATTERN.fullmatch(symbol):
            self._send_json(400, {"error": "invalid_market_symbol"})
            return
        if not _valid_analysis_payload(payload):
            self._send_json(400, {"error": "invalid_analysis_context"})
            return
        # Deliberately no provider, key, outbound HTTP client, or AI response yet.
        self._send_json(503, {
            "error": "ai_provider_not_configured",
            "message": "Er is nog geen AI-dienst gekozen. De analysegegevens zijn niet doorgestuurd.",
        })

    def _exchange_get(self, route: str) -> None:
        try:
            if route == "/api/exchange/status":
                assert_action_blocked("status")
                provider = create_provider()
                if provider is None:
                    self._send_json(200, {"exchange": "Niet gekozen", "configured": False,
                        "connected": False, "state": "not_configured", "mode": "PAPER",
                        "readOnly": True, "tradingEnabled": False, "withdrawalsEnabled": False,
                        "transfersEnabled": False, "lastSuccess": None,
                        "message": "Er is nog geen account-exchange ingesteld. Openbare marktgegevens en paper trading blijven beschikbaar."})
                    return
                self._send_json(200, provider.status())
                return
            provider = create_provider()
            if provider is None:
                self._send_json(503, {"error": "exchange_not_configured", "message": "Er is nog geen exchange-account ingesteld."})
                return
            if route == "/api/exchange/markets":
                assert_action_blocked("markets")
                self._send_json(200, {"exchange": provider.name, "markets": provider.markets(), "readOnly": True})
            elif route == "/api/exchange/account":
                assert_action_blocked("account")
                self._send_json(200, provider.account())
            elif route == "/api/exchange/open-orders":
                assert_action_blocked("open_orders")
                self._send_json(200, {"exchange": provider.name, "orders": provider.open_orders(), "readOnly": True})
            else:
                self._not_found()
        except ExchangeError as exc:
            status = 503 if exc.code in {"not_configured", "exchange_unavailable", "timeout"} else 400
            self._send_json(status, {"error": exc.code, "message": exc.message})
        except Exception:
            # Deliberately suppress exception text: it may contain request details.
            self._send_json(503, {"error": "exchange_error", "message": "De exchange kon de gegevens niet leveren. Probeer het later opnieuw."})

    def _exchange_test(self) -> None:
        try:
            assert_action_blocked("test_connection")
            provider = create_provider()
            if provider is None:
                self._send_json(503, {"error": "exchange_not_configured", "message": "Er is nog geen exchange-account ingesteld."})
                return
            self._send_json(200, provider.test_connection())
        except ExchangeError as exc:
            status = 503 if exc.code in {"not_configured", "exchange_unavailable", "timeout"} else 400
            self._send_json(status, {"error": exc.code, "message": exc.message})
        except Exception:
            self._send_json(503, {"error": "exchange_error", "message": "De exchange kon de verbinding niet bevestigen. Probeer het later opnieuw."})

    def _testnet_get(self, route):
        try:
            if route == "/api/testnet/status":
                env = __import__("os").environ
                sandbox = env.get("EXCHANGE_SANDBOX", "").lower() in {"1", "true", "yes"}
                enabled = (sandbox and env.get("EXCHANGE_PROVIDER", "").strip().lower() == "binance_spot"
                           and bool(env.get("EXCHANGE_API_KEY")) and bool(env.get("EXCHANGE_API_SECRET")))
                self._send_json(200, {"mode": "TESTNET" if enabled else "PAPER", "enabled": enabled,
                    "liveEnabled": False, "withdrawalsEnabled": False,
                    "message": "TESTNET is de actieve exchange-modus; paper trading blijft een aparte virtuele rekening." if enabled else "PAPER TRADING actief. Er is geen volledige Testnet-sessie met provider en tijdelijke credentials ingesteld."})
                return
            service = create_testnet_service()
            if route == "/api/testnet/orders": self._send_json(200, {"orders": service.history(), "liveEnabled": False})
            elif route == "/api/testnet/sync": self._send_json(200, {"portfolio": service.sync(), "orders": service.history(), "liveEnabled": False})
            elif route == "/api/testnet/portfolio": self._send_json(200, {"portfolio": service.portfolio_summary(), "liveEnabled": False})
            elif route.startswith("/api/testnet/order/"):
                client_id = route.rsplit("/", 1)[-1]
                if not re.fullmatch(r"codex[a-f0-9]{28}", client_id): self._send_json(400, {"error": "invalid_id"}); return
                self._send_json(200, service.order_status(client_id))
            else: self._not_found()
        except TestnetError as exc:
            code = 503 if exc.code in {"not_configured", "mode_blocked", "outcome_unknown"} else 400
            self._send_json(code, {"error": exc.code, "message": exc.message})
        except Exception:
            self._send_json(503, {"error": "testnet_error", "message": "Testnet-gegevens zijn tijdelijk niet beschikbaar."})

    def _testnet_post(self, route):
        try: length = int(self.headers.get("Content-Length", "0"))
        except ValueError: self._send_json(400, {"error": "invalid_content_length"}); return
        if not 1 <= length <= 8192: self._send_json(413, {"error": "request_too_large_or_empty"}); return
        try: payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError): self._send_json(400, {"error": "invalid_json"}); return
        try:
            service = create_testnet_service()
            if route == "/api/testnet/prepare":
                self._send_json(200, {"order": service.prepare(payload), "liveEnabled": False})
            elif route == "/api/testnet/confirm":
                if not isinstance(payload, dict) or set(payload) != {"clientOrderId", "confirmed"}:
                    self._send_json(400, {"error": "invalid_confirmation"}); return
                self._send_json(200, service.confirm(payload["clientOrderId"], payload["confirmed"]))
            elif route == "/api/testnet/resume":
                if not isinstance(payload, dict) or set(payload) != {"confirmed"}:
                    self._send_json(400, {"error": "invalid_confirmation"}); return
                service.manual_resume(payload["confirmed"])
                self._send_json(200, {"portfolio": service.portfolio_summary(), "resumed": True})
            else: self._not_found()
        except TestnetError as exc:
            code = 503 if exc.code in {"not_configured", "mode_blocked", "outcome_unknown"} else 400
            self._send_json(code, {"error": exc.code, "message": exc.message})
        except Exception:
            self._send_json(503, {"error": "testnet_error", "message": "De Testnet-order is veilig geblokkeerd door een onverwachte fout."})

    def _safe_path(self, request_path: str) -> Path | None:
        relative = unquote(urlsplit(request_path).path).lstrip("/").replace("\\", "/")
        target = (PROJECT_ROOT / relative).resolve()
        try:
            target.relative_to(PROJECT_ROOT)
        except ValueError:
            return None
        return target

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_server(port: int = PORT) -> LocalThreadingHTTPServer:
    return LocalThreadingHTTPServer((HOST, port), LocalAssistantHandler)


def main() -> None:
    server = create_server()
    address = f"http://{HOST}:{server.server_port}/"
    print("AI Crypto Trading Assistant — lokale veilige aansluiting")
    print(f"Alleen bereikbaar op deze pc: {address}")
    print("AI-dienst: nog niet ingesteld. Er worden geen AI-verzoeken of orders verstuurd.")
    threading.Timer(0.8, lambda: webbrowser.open(address)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLokale verbinding gestopt.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
