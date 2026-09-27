import tempfile
import json
import unittest
import threading
from pathlib import Path
from urllib.request import Request, urlopen

from exchange_layer import ExchangeError
from testnet_trading import BinanceSpotTestnet, TestnetError, TestnetOrderService, create_testnet_service


class FakeProvider(BinanceSpotTestnet):
    def __init__(self, order_status="NEW", send_error=None, balance=10000):
        self.api_key, self.api_secret = "fake", "fake"
        self.calls, self.order_status_value, self.send_error, self.lookups = [], order_status, send_error, 0
        self.balance = balance
    def symbol_info(self, symbol): return {"symbol": symbol, "status": "TRADING"}
    def price(self, symbol): return 100.0
    def account(self): return {"balances": [{"asset":"USDT","free":str(self.balance),"locked":"0"}]}
    def find_order(self, symbol, client_id):
        self.calls.append(("lookup", client_id))
        self.lookups += 1
        if self.lookups == 1: raise TestnetError("order_not_found", "not found")
        return {"status": self.order_status_value, "executedQty": "0.1", "price": "100"}
    def submit_bracket(self, params):
        self.calls.append(("submit", params))
        if self.send_error: raise self.send_error
        return {"orderListId": 123, "listOrderStatus": "EXECUTING"}
    def request(self, method, path, params=None, signed=True):
        if path == "/api/v3/order":
            return {"status": self.order_status_value, "executedQty": "0.1", "price": "100"}
        return {}


class TestnetWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.service = TestnetOrderService(self.provider, Path(self.temp.name) / "ledger.sqlite3", clock=lambda: 1780000000000)
        self.payload = {"symbol":"BTCUSDT", "side":"BUY", "quantity":0.1, "stopLoss":95.0, "takeProfit":110.0}
    def tearDown(self): self.temp.cleanup()
    def prepare(self, payload=None): return self.service.prepare(payload or self.payload)
    def test_successful_order_requires_confirmation_and_uses_unique_id(self):
        order = self.prepare()
        with self.assertRaises(TestnetError): self.service.confirm(order["clientOrderId"], False)
        result = self.service.confirm(order["clientOrderId"], True)
        self.assertEqual(result["status"], "NEW")
        self.assertEqual(len([x for x in self.provider.calls if x[0] == "submit"]), 1)
        submit = next(x for x in self.provider.calls if x[0] == "submit")
        self.assertIn("workingClientOrderId", submit[1])
    def test_partial_fill_uses_actual_quantity_and_protection_unconfirmed(self):
        self.provider.order_status_value="PARTIALLY_FILLED"
        o=self.prepare(); status=self.service.confirm(o["clientOrderId"], True)
        self.assertEqual(status["status"], "PARTIALLY_FILLED")
        self.assertEqual(status["details"]["executedQty"], .1)
        self.assertEqual(status["details"]["protection"], "PENDING_EXCHANGE_CONFIRMATION")
    def test_full_fill_status(self):
        self.provider.order_status_value="FILLED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"FILLED")
    def test_rejected_status(self):
        self.provider.order_status_value="REJECTED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"REJECTED")
    def test_canceled_status(self):
        self.provider.order_status_value="CANCELED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"CANCELED")
    def test_unknown_status_fails_closed(self):
        self.provider.order_status_value="ODD"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"UNKNOWN")
    def test_timeout_is_unknown_and_never_blindly_retried(self):
        self.provider.send_error=TestnetError("outcome_unknown", "timeout")
        o=self.prepare()
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
        self.assertEqual(self.service.order_status(o["clientOrderId"])["status"],"NEW")
        self.assertEqual(len([x for x in self.provider.calls if x[0]=="submit"]),1)
    def test_duplicate_confirmation_blocked(self):
        o=self.prepare(); self.service.confirm(o["clientOrderId"],True)
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
    def test_insufficient_balance(self):
        self.provider.balance=1
        with self.assertRaises(TestnetError): self.prepare()
    def test_missing_stop_loss(self):
        p=dict(self.payload); p["stopLoss"]=None
        with self.assertRaises(TestnetError): self.prepare(p)
    def test_max_risk_limit(self):
        p=dict(self.payload, quantity=20)
        with self.assertRaises(TestnetError): self.prepare(p)
    def test_daily_loss_limit(self):
        import time, json
        today=time.strftime("%Y-%m-%d",time.localtime(1780000000000/1000))
        with self.service._db() as db: db.execute("INSERT INTO ledger(event,payload,created) VALUES('CLOSED',?,?)",(json.dumps({"date":today,"pnl":-301}),1780000000000))
        with self.assertRaisesRegex(TestnetError,"Dagverlieslimiet"): self.prepare()
    def test_drawdown_limit(self):
        import json
        with self.service._db() as db: db.execute("INSERT INTO ledger(event,payload,created) VALUES('EQUITY',?,?)",(json.dumps({"equity":20000}),1780000000000))
        with self.assertRaisesRegex(TestnetError,"drawdown"): self.prepare()
    def test_invalid_market_information(self):
        self.provider.symbol_info=lambda symbol: (_ for _ in ()).throw(TestnetError("market_unavailable","x"))
        with self.assertRaises(TestnetError): self.prepare()
    def test_risk_rechecked_immediately_before_execution(self):
        o=self.prepare(); self.provider.balance=1
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
        self.assertEqual(len([x for x in self.provider.calls if x[0]=="submit"]),0)
    def test_live_factory_is_hard_blocked(self):
        import os
        old=(os.environ.get("EXCHANGE_PROVIDER"),os.environ.get("EXCHANGE_SANDBOX"))
        os.environ["EXCHANGE_PROVIDER"]="binance_spot"; os.environ["EXCHANGE_SANDBOX"]="0"
        try:
            with self.assertRaises(TestnetError): create_testnet_service()
        finally:
            for k,v in zip(("EXCHANGE_PROVIDER","EXCHANGE_SANDBOX"),old):
                if v is None: os.environ.pop(k,None)
                else: os.environ[k]=v
    def test_withdrawal_and_live_capabilities_absent(self):
        self.assertFalse(hasattr(self.provider,"withdraw")); self.assertFalse(hasattr(self.provider,"transfer"))
        self.assertEqual(self.service.history(), [])
    def test_http_mode_is_disabled_without_explicit_testnet_session(self):
        import os, run_local
        old={k:os.environ.get(k) for k in ("EXCHANGE_PROVIDER","EXCHANGE_SANDBOX","EXCHANGE_API_KEY","EXCHANGE_API_SECRET")}
        for k in old: os.environ.pop(k,None)
        server=run_local.create_server(0); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        base=f"http://127.0.0.1:{server.server_port}"
        try:
            status=json.load(urlopen(base+"/api/testnet/status"))
            self.assertFalse(status["enabled"]); self.assertFalse(status["liveEnabled"])
            req=Request(base+"/api/testnet/prepare",data=json.dumps(self.payload).encode(),headers={"Origin":base,"Content-Type":"application/json"},method="POST")
            with self.assertRaises(Exception): urlopen(req)
        finally:
            server.shutdown(); server.server_close(); thread.join()
            for k,v in old.items():
                if v is not None: os.environ[k]=v


if __name__ == "__main__": unittest.main()
