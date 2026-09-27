"""Fail-closed Binance Spot TESTNET-only order workflow.

This module deliberately has no LIVE host and no withdrawal/transfer methods.
All transport calls in tests are mocked.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

from exchange_layer import ExchangeError


class TestnetError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


class BinanceSpotTestnet:
    """Dedicated adapter: fixed testnet host and explicitly enumerated endpoints."""
    name = "Binance Spot Testnet"
    base_url = "https://testnet.binance.vision"
    timeout_seconds = 8
    allowed = {
        ("GET", "/api/v3/account"), ("GET", "/api/v3/ticker/price"),
        ("GET", "/api/v3/exchangeInfo"), ("GET", "/api/v3/order"),
        ("GET", "/api/v3/openOrders"), ("POST", "/api/v3/order"),
        ("POST", "/api/v3/orderList/otoco"),
        ("GET", "/api/v3/orderList"), ("GET", "/api/v3/orderList/open"),
    }

    def __init__(self, api_key, api_secret, transport=None):
        if not api_key or not api_secret:
            raise TestnetError("not_configured", "Voor Testnet ontbreken de tijdelijke sleutelgegevens.")
        self.api_key, self.api_secret = api_key, api_secret
        self.transport = transport or self._transport

    @staticmethod
    def _transport(method, url, headers, timeout, body=None):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, new_url): return None
        req = urllib.request.Request(url, data=body.encode("ascii") if body is not None else None, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            return json.loads(response.read(1_000_001))

    def request(self, method, path, params=None, signed=True):
        method = method.upper()
        if (method, path) not in self.allowed:
            raise TestnetError("endpoint_blocked", "Deze exchangeactie is niet toegestaan.")
        values = dict(params or {})
        headers = {"Accept": "application/json", "X-MBX-APIKEY": self.api_key}
        if signed:
            values.update(timestamp=int(time.time() * 1000), recvWindow=5000)
            query = urllib.parse.urlencode(values)
            values["signature"] = hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        query = urllib.parse.urlencode(values)
        url = self.base_url + path
        if method == "GET" and query:
            url += "?" + query
        elif method != "GET":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            result = self.transport(method, url, headers, self.timeout_seconds, query if method != "GET" else None)
        except TypeError:
            # Four-argument injectable transport remains convenient for GET-only test doubles.
            if method != "GET":
                raise TestnetError("transport_invalid", "De Testnet-verbinding kan deze veilige aanvraag niet uitvoeren.") from None
            result = self.transport(url, headers, self.timeout_seconds)
        except (TimeoutError, urllib.error.URLError, OSError):
            raise TestnetError("outcome_unknown", "Geen antwoord van Testnet. De orderstatus moet eerst worden gecontroleerd; er wordt niets opnieuw verstuurd.") from None
        except urllib.error.HTTPError as exc:
            # Only Binance's exact unknown-order code permits first send. All other
            # HTTP errors stop here so a permission/network failure cannot trigger a duplicate.
            try: error_data = json.loads(exc.read(100_000))
            except Exception: error_data = {}
            if method == "GET" and path == "/api/v3/order" and isinstance(error_data, dict) and error_data.get("code") == -2013:
                raise TestnetError("order_not_found", "De unieke Testnet-clientorder is nog niet aangemaakt.") from None
            raise TestnetError("exchange_rejected", "Testnet heeft de aanvraag geweigerd. Controleer de orderstatus voordat je verdergaat.") from None
        except Exception:
            raise TestnetError("exchange_unavailable", "Testnet gaf geen veilig leesbaar antwoord.") from None
        if isinstance(result, dict) and isinstance(result.get("code"), int) and result["code"] < 0:
            if path == "/api/v3/order" and result.get("code") == -2013:
                raise TestnetError("order_not_found", "De unieke Testnet-clientorder is nog niet aangemaakt.")
            raise TestnetError("exchange_rejected", "Testnet heeft de aanvraag geweigerd.")
        if not isinstance(result, (dict, list)):
            raise TestnetError("invalid_response", "Testnet gaf een ongeldige reactie.")
        return result

    def account(self):
        return self.request("GET", "/api/v3/account", {"omitZeroBalances": "true"})

    def price(self, symbol):
        result = self.request("GET", "/api/v3/ticker/price", {"symbol": symbol}, signed=False)
        value = float(result["price"])
        if not value > 0: raise ValueError()
        return value

    def symbol_info(self, symbol):
        data = self.request("GET", "/api/v3/exchangeInfo", {"symbol": symbol}, signed=False)
        rows = data.get("symbols", []) if isinstance(data, dict) else []
        row = next((x for x in rows if x.get("symbol") == symbol and x.get("status") == "TRADING"), None)
        if not row or row.get("isSpotTradingAllowed") is False:
            raise TestnetError("market_unavailable", "Dit Testnet-paar is niet beschikbaar voor spotorders.")
        return row

    def find_order(self, symbol, client_id):
        return self.request("GET", "/api/v3/order", {"symbol": symbol, "origClientOrderId": client_id})

    def submit_bracket(self, params):
        return self.request("POST", "/api/v3/orderList/otoco", params)

    def order_list(self, **params):
        return self.request("GET", "/api/v3/orderList", params)


class TestnetOrderService:
    """Two-step user-confirmed Testnet workflow with server-side second risk check."""
    # Conservative Fase 7 baseline (USDT quote valuation); no client-provided overrides.
    RULES = {"risk_per_trade": .01, "max_position": 1000.0, "max_position_pct": .10,
             "max_positions": 3, "max_exposure_pct": .50, "max_open_risk_pct": .03,
             "daily_loss_pct": .03, "max_drawdown_pct": .15, "min_rr": 1.5,
             "fee_rate": .001}
    SYMBOL = re.compile(r"^[A-Z0-9]{2,20}USDT$")

    def __init__(self, provider, db_path=None, clock=None):
        if not isinstance(provider, BinanceSpotTestnet):
            raise TestnetError("mode_blocked", "Orderuitvoering is uitsluitend voor expliciet gekozen Testnet beschikbaar.")
        self.provider = provider
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.db_path = str(db_path or Path(__file__).parent / "outputs" / "testnet_ledger.sqlite3")
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS orders (client_id TEXT PRIMARY KEY, symbol TEXT, payload TEXT, state TEXT, created INTEGER, updated INTEGER, exchange_json TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, payload TEXT, created INTEGER)")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _snapshot(self):
        account = self.provider.account()
        balances = {r["asset"]: float(r["free"]) + float(r["locked"]) for r in account.get("balances", [])}
        # Record only the known USDT balance; other assets are not falsely valued.
        with self._db() as db:
            db.execute("INSERT INTO ledger(event,payload,created) VALUES('EQUITY',?,?)",
                       (json.dumps({"equity": balances.get("USDT", 0), "basis": "USDT balance only"}), self.clock()))
        return account, balances

    def _checks(self, p, price, balances):
        errors, rules = [], self.RULES
        sym, side, qty = p.get("symbol"), p.get("side"), p.get("quantity")
        sl, tp = p.get("stopLoss"), p.get("takeProfit")
        if not isinstance(sym, str) or not self.SYMBOL.fullmatch(sym): errors.append("Ongeldig USDT-spotpaar.")
        if side not in {"BUY", "SELL"}: errors.append("Kies BUY of SELL.")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (qty, price, sl, tp)):
            errors.append("Hoeveelheid, prijs, stop-loss en take-profit moeten positief zijn.")
            return errors
        equity = max(balances.get("USDT", 0), 1)
        if side == "BUY":
            if not sl < price < tp: errors.append("Voor BUY moet stop-loss onder en take-profit boven de actuele prijs liggen.")
            risk = qty * (price - sl) + qty * price * rules["fee_rate"] * 2
            notional = qty * price
            if risk > equity * rules["risk_per_trade"]: errors.append("Maximaal risico per positie overschreden.")
            if notional > rules["max_position"]: errors.append("Maximale positiegrootte overschreden.")
            if notional > equity * rules["max_position_pct"]: errors.append("Maximumpercentage per positie overschreden.")
            if qty * price * (1 + rules["fee_rate"]) > balances.get("USDT", 0): errors.append("Onvoldoende vrije USDT-balans.")
        else:
            if not tp < price < sl: errors.append("Voor SELL (positie sluiten) moet take-profit onder en stop-loss boven de actuele prijs liggen.")
            if qty > balances.get(sym[:-4], 0): errors.append("Onvoldoende vrij bezit om te verkopen.")
            risk = qty * (sl - price) + qty * price * rules["fee_rate"] * 2
            notional = qty * price
        with self._db() as db:
            rows = db.execute("SELECT payload FROM orders WHERE state IN ('NEW','PARTIALLY_FILLED','FILLED','UNKNOWN')").fetchall()
        positions = [json.loads(x[0]) for x in rows if json.loads(x[0]).get("side") == "BUY"]
        if side == "BUY" and not any(x.get("symbol") == sym for x in positions) and len(positions) >= rules["max_positions"]:
            errors.append("Maximaal aantal gelijktijdige posities bereikt.")
        exposure = sum(float(x.get("quantity", 0)) * float(x.get("price", 0)) for x in positions)
        open_risk = sum(float(x.get("risk", 0)) for x in positions)
        if side == "BUY" and exposure + notional > equity * rules["max_exposure_pct"]: errors.append("Maximale totale blootstelling overschreden.")
        if side == "BUY" and open_risk + risk > equity * rules["max_open_risk_pct"]: errors.append("Maximaal totaal open risico overschreden.")
        if side == "BUY" and (tp - price) / max(price - sl, 1e-12) < rules["min_rr"]: errors.append("Risk/reward is lager dan de ingestelde minimumverhouding.")
        today = time.strftime("%Y-%m-%d", time.localtime(self.clock() / 1000))
        with self._db() as db:
            losses = db.execute("SELECT payload FROM ledger WHERE event='CLOSED'").fetchall()
        day_loss = sum(max(0, -float(json.loads(x[0]).get("pnl", 0))) for x in losses if json.loads(x[0]).get("date") == today)
        if day_loss + max(0, -float(p.get("realizedPnl", 0))) > equity * rules["daily_loss_pct"]: errors.append("Dagverlieslimiet bereikt.")
        with self._db() as db:
            observed = [json.loads(r[0]).get("equity", 0) for r in db.execute("SELECT payload FROM ledger WHERE event='EQUITY'").fetchall()]
        peak = max([equity] + [float(x) for x in observed if isinstance(x, (int, float))])
        if peak > 0 and (peak - equity) / peak >= rules["max_drawdown_pct"]: errors.append("Maximale drawdown bereikt.")
        if not p.get("stopLoss"): errors.append("Verplichte stop-loss ontbreekt.")
        return errors

    def prepare(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"symbol", "side", "quantity", "stopLoss", "takeProfit"}:
            raise TestnetError("invalid_order", "De ordergegevens zijn onvolledig of ongeldig.")
        if payload.get("side") != "BUY":
            # Spot SELL only safely closes a position held in this application ledger; not a short.
            raise TestnetError("sell_requires_position", "Verkooporders zijn nog geblokkeerd totdat een Testnet-positie door de administratie is bevestigd.")
        if not isinstance(payload.get("stopLoss"), (int, float)) or isinstance(payload.get("stopLoss"), bool) or payload["stopLoss"] <= 0:
            raise TestnetError("risk_rejected", "Een geldige verplichte stop-loss ontbreekt.")
        if not isinstance(payload.get("quantity"), (int, float)) or isinstance(payload.get("quantity"), bool) or payload["quantity"] <= 0:
            raise TestnetError("invalid_order", "Een geldige hoeveelheid ontbreekt.")
        sym = payload.get("symbol")
        if not isinstance(sym, str) or not self.SYMBOL.fullmatch(sym): raise TestnetError("invalid_symbol", "Alleen geldige USDT spotparen zijn toegestaan.")
        try:
            info = self.provider.symbol_info(sym)
            price = self.provider.price(sym)
            account, balances = self._snapshot()
        except TestnetError: raise
        except Exception: raise TestnetError("market_unavailable", "Prijs, account of marktdetails zijn niet betrouwbaar beschikbaar.") from None
        p = dict(payload, price=price, orderType="OTOCO_LIMIT", quote="USDT", maxRisk=float(payload["quantity"]) * (price-float(payload["stopLoss"])) + float(payload["quantity"])*price*.002,
                 estimatedFees=float(payload["quantity"])*price*.002, availableBalance=balances.get("USDT", 0), priceTimestamp=self.clock(),
                 exchange=self.provider.name, ruleVersion="Fase 7 veilige basis 1")
        errors = self._checks(p, price, balances)
        if errors: raise TestnetError("risk_rejected", "Order niet voorbereid: " + " ".join(errors))
        client_id = "codex" + uuid.uuid4().hex[:28]
        p["clientOrderId"] = client_id
        with self._db() as db:
            db.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?)", (client_id, sym, json.dumps(p), "PREPARED", self.clock(), self.clock(), "{}"))
        return {k: p[k] for k in ("exchange", "symbol", "side", "quantity", "price", "orderType", "stopLoss", "takeProfit", "maxRisk", "estimatedFees", "availableBalance", "priceTimestamp", "clientOrderId")}

    def confirm(self, client_id, confirmed):
        if confirmed is not True: raise TestnetError("confirmation_required", "Zonder expliciete Testnet-bevestiging wordt niets verstuurd.")
        with self._db() as db:
            row = db.execute("SELECT * FROM orders WHERE client_id=?", (client_id,)).fetchone()
            if not row or row["state"] != "PREPARED": raise TestnetError("order_not_prepared", "Deze order is niet meer bevestigbaar; status veilig controleren.")
            p = json.loads(row["payload"])
            changed = db.execute("UPDATE orders SET state='SENDING',updated=? WHERE client_id=? AND state='PREPARED'", (self.clock(), client_id)).rowcount
            if changed != 1: raise TestnetError("duplicate_blocked", "Deze order is al verwerkt; er wordt niets dubbel verstuurd.")
        try:
            price = self.provider.price(p["symbol"])
            _, balances = self._snapshot()
            self.provider.symbol_info(p["symbol"])
            # Price movement invalidates the user's prepared screen; require a new review.
            if abs(price - float(p["price"])) / float(p["price"]) > 0.001:
                raise TestnetError("price_changed", "De prijs is sinds voorbereiding veranderd. Bereid de order opnieuw voor en controleer de nieuwe gegevens.")
            p = dict(p, price=price)
            errors = self._checks(p, price, balances)
            if errors: raise TestnetError("second_risk_check_failed", "Laatste veiligheidscontrole mislukt: " + " ".join(errors))
            # Verify an idempotency key before send, then submit exactly once.
            try:
                existing = self.provider.find_order(p["symbol"], client_id)
            except TestnetError as exc:
                if exc.code != "order_not_found": raise
                existing = None
            if existing:
                response = existing
            else:
                # OTOCO queues protective OCO legs after the entry fills. A partial fill is
                # recorded as partial and UNPROTECTED until exchange order-list query confirms
                # both protective orders active for the actual executed quantity.
                params = {"symbol": p["symbol"], "workingSide": "BUY", "workingType": "LIMIT",
                          "workingTimeInForce": "GTC", "workingQuantity": p["quantity"],
                          "workingPrice": p["price"], "workingClientOrderId": client_id,
                          "pendingSide": "SELL", "pendingQuantity": p["quantity"],
                          "pendingAboveType": "LIMIT_MAKER", "pendingAbovePrice": p["takeProfit"],
                          "pendingAboveClientOrderId": client_id + "TP",
                          "pendingBelowType": "STOP_LOSS_LIMIT", "pendingBelowPrice": p["stopLoss"] * .999,
                          "pendingBelowStopPrice": p["stopLoss"], "pendingBelowTimeInForce": "GTC",
                          "pendingBelowClientOrderId": client_id + "SL"}
                response = self.provider.submit_bracket(params)
        except TestnetError as exc:
            state = "UNKNOWN" if exc.code == "outcome_unknown" else "REJECTED"
            self._save_state(client_id, state, {"safeMessage": exc.message})
            raise
        except Exception:
            self._save_state(client_id, "UNKNOWN", {"safeMessage": "Verzendresultaat onbekend; statuscontrole vereist."})
            raise TestnetError("outcome_unknown", "Verzendresultaat onbekend. Controleer eerst orderstatus; niet opnieuw versturen.") from None
        status = response.get("listOrderStatus") or response.get("status") or "UNKNOWN" if isinstance(response, dict) else "UNKNOWN"
        normalized = {"NEW": "NEW", "EXECUTING": "NEW", "PARTIALLY_FILLED": "PARTIALLY_FILLED", "FILLED": "FILLED",
                      "CANCELED": "CANCELED", "REJECT": "REJECTED", "REJECTED": "REJECTED", "EXPIRED": "EXPIRED"}.get(status, "UNKNOWN")
        self._save_state(client_id, normalized, response)
        return self.order_status(client_id)

    def _save_state(self, client_id, state, response):
        safe = response if isinstance(response, (dict, list)) else {"value": str(response)}
        with self._db() as db:
            db.execute("UPDATE orders SET state=?,updated=?,exchange_json=? WHERE client_id=?", (state, self.clock(), json.dumps(safe), client_id))

    def order_status(self, client_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM orders WHERE client_id=?", (client_id,)).fetchone()
        if not row: raise TestnetError("not_found", "Order niet gevonden.")
        if row["state"] in {"UNKNOWN", "SENDING", "NEW", "PARTIALLY_FILLED", "FILLED"}:
            p = json.loads(row["payload"])
            try:
                response = self.provider.find_order(p["symbol"], client_id)
                if isinstance(response, dict):
                    status = response.get("status", "UNKNOWN")
                    mapped = {"NEW":"NEW", "PARTIALLY_FILLED":"PARTIALLY_FILLED", "FILLED":"FILLED", "CANCELED":"CANCELED", "REJECTED":"REJECTED", "EXPIRED":"EXPIRED"}.get(status, "UNKNOWN")
                    executed = float(response.get("executedQty", 0) or 0)
                    avg = float(response.get("price", 0) or 0)
                    response["executedQty"] = executed
                    response["averageEntry"] = avg
                    response["protection"] = "PENDING_EXCHANGE_CONFIRMATION" if executed > 0 else "NOT_ACTIVE"
                    if executed > 0 and mapped == "FILLED":
                        original = json.loads(row["exchange_json"] or "{}")
                        list_id = response.get("orderListId") or original.get("orderListId")
                        if list_id is not None:
                            try:
                                bracket = self.provider.order_list(orderListId=list_id)
                                reports = bracket.get("orders", []) if isinstance(bracket, dict) else []
                                open_children = [x for x in reports if x.get("status") in {"NEW", "PARTIALLY_FILLED"}]
                                if len(open_children) >= 2 and bracket.get("listOrderStatus") == "EXECUTING":
                                    response["protection"] = "ACTIVE_CONFIRMED"
                                    response["protectiveOrders"] = open_children
                            except TestnetError:
                                pass
                    self._save_state(client_id, mapped, response)
                    row = dict(row); row["state"] = mapped; row["exchange_json"] = json.dumps(response)
            except TestnetError:
                pass
        exchange_data = json.loads(row["exchange_json"] or "{}")
        return {"clientOrderId": client_id, "status": row["state"], "exchange": "Binance Spot Testnet", "details": exchange_data,
                "liveEnabled": False, "withdrawalsEnabled": False}

    def history(self):
        with self._db() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM orders ORDER BY created DESC LIMIT 10")]
        result = []
        for row in rows:
            state = row["state"]
            if state in {"NEW", "PARTIALLY_FILLED", "UNKNOWN", "SENDING", "FILLED"}:
                try: latest = self.order_status(row["client_id"])
                except TestnetError: latest = {"status": state, "details": {}}
            else: latest = {"status": state, "details": json.loads(row["exchange_json"] or "{}")}
            details = latest.get("details") or {}
            result.append({"clientOrderId": row["client_id"], "symbol": row["symbol"], "status": latest["status"],
                           "createdAt": row["created"], "executedQty": details.get("executedQty", 0),
                           "averageEntry": details.get("averageEntry"), "protection": details.get("protection", "NOT_CONFIRMED")})
        return result


def create_testnet_service():
    """Never builds a provider unless caller explicitly selected sandbox mode."""
    if os.environ.get("EXCHANGE_PROVIDER", "").lower() != "binance_spot" or os.environ.get("EXCHANGE_SANDBOX", "").lower() not in {"1", "true", "yes"}:
        raise TestnetError("mode_blocked", "Testnet-orderstroom is uitgeschakeld. Kies expliciet de TESTNET-sessiestarter.")
    key, secret = os.environ.get("EXCHANGE_API_KEY", ""), os.environ.get("EXCHANGE_API_SECRET", "")
    try: return TestnetOrderService(BinanceSpotTestnet(key, secret))
    except TestnetError: raise
    except Exception: raise TestnetError("not_configured", "Testnet is niet ingesteld.") from None
