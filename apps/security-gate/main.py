"""Local command-line entry point; never executes the scan target."""
from security_gate.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
