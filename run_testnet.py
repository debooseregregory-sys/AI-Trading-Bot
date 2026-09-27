"""Launch a temporary Binance Spot TESTNET session (never a live write session)."""
from getpass import getpass
import os
from pathlib import Path
import subprocess
import sys


def main():
    print("Fase 9 — uitsluitend Binance Spot TESTNET")
    print("Gebruik alleen sleutelgegevens die je op Binance Testnet hebt aangemaakt.")
    print("Gebruik hier nooit een echte/live API-sleutel. De live-orderroute bestaat niet.")
    if input("Typ TESTNET om verder te gaan: ").strip() != "TESTNET":
        print("Niet gestart. Er zijn geen verbindingen gemaakt.")
        return
    key = getpass("Testnet API-sleutel (verborgen): ").strip()
    secret = getpass("Testnet API-geheim (verborgen): ").strip()
    if not key or not secret:
        print("Gegevens ontbreken; de applicatie is niet gestart.")
        return
    env = os.environ.copy()
    env.update({"EXCHANGE_PROVIDER":"binance_spot", "EXCHANGE_API_KEY":key,
                "EXCHANGE_API_SECRET":secret, "EXCHANGE_SANDBOX":"1"})
    project = Path(__file__).resolve().parent
    print("De Testnet-sessie start lokaal. Sleutels blijven alleen tijdelijk in het serverproces.")
    print("Alle orders vereisen jouw aparte bevestiging. Sluit het venster om de sessie en geheugensleutels te wissen.")
    try:
        subprocess.run([sys.executable, str(project / "run_local.py")], cwd=project, env=env, check=False)
    except OSError:
        print("Server kon niet starten. Geheime gegevens zijn niet getoond.")


if __name__ == "__main__": main()
