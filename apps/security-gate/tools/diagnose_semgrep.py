"""Read-only runtime diagnosis using bundled fixtures and local rules only.

Run with this project's Python from a normal Windows PowerShell to compare
against the sandbox. No raw scanner output, source, certificate, or env values
are printed. All temporary files stay under apps/security-gate/.tmp.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from security_gate.semgrep import environment, find_executable  # noqa: E402


def windows_store_probe():
    if os.name != "nt":
        return {"applicable": False}
    api = ctypes.WinDLL("crypt32", use_last_error=True)
    api.CertOpenStore.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
                                 ctypes.c_uint32, ctypes.c_wchar_p]
    api.CertOpenStore.restype = ctypes.c_void_p
    api.CertCloseStore.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    # SYSTEM_W, CURRENT_USER, READONLY, OPEN_EXISTING: no store creation/write.
    handle = api.CertOpenStore(10, 0, None, 0x10000 | 0x8000 | 0x4000, "ROOT")
    result = {"applicable": True, "opened_readonly": bool(handle),
              "winerror": 0 if handle else ctypes.get_last_error()}
    if handle:
        api.CertCloseStore(handle, 0)
    return result


def probe(command, snapshot):
    try:
        run = subprocess.run(command, cwd=snapshot, env=environment(snapshot),
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=30, shell=False,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except subprocess.TimeoutExpired:
        return {"error": "TIMEOUT"}
    except OSError:
        return {"error": "PROCESS_START_FAILED"}
    result = {"exit_code": run.returncode,
              "certificate_store_error": b"CertOpenSystemStore returned NULL" in run.stderr}
    if re.fullmatch(rb"[0-9]+\.[0-9]+\.[0-9]+\s*", run.stdout):
        result["version"] = run.stdout.decode("ascii").strip()
    try:
        data = json.loads(run.stdout)
        if isinstance(data, dict):
            result["finding_count"] = len(data.get("results", []))
            result["error_count"] = len(data.get("errors", []))
            result["scanned_count"] = len(data.get("paths", {}).get("scanned", []))
    except (ValueError, TypeError):
        pass
    return result


def main():
    executable = find_executable()
    if executable is None:
        print(json.dumps({"error": "SEMGREP_NOT_INSTALLED"}))
        return 3
    output = {"readonly_certificate_store": windows_store_probe(), "probes": {}}
    temporary = ROOT / ".tmp"
    temporary.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="runtime-diagnostic-", dir=temporary) as directory:
        snapshot = Path(directory)
        commands = {"version_without_rules_or_targets": [executable, "--version"],
                    "help_without_rules_or_targets": [executable, "scan", "--help"]}
        for language, fixture, source, rule in [
            ("python", "safe", "sample.py", "python-security.yml"),
            ("java", "java_safe", "BoardService.java", "java-security.yml"),
            ("javascript", "javascript_safe", "sample.js", "javascript-typescript-security.yml"),
            ("typescript", "typescript_safe", "sample.ts", "javascript-typescript-security.yml"),
        ]:
            # Direct CLI calls bypass the Security Gate scan/normalization code.
            target = snapshot / source
            target.write_bytes((ROOT / "tests/fixtures/semgrep" / fixture / source).read_bytes())
            commands[language + "_direct_local_scan"] = [
                executable, "scan", "--config", str(ROOT / "semgrep_rules" / rule),
                "--json", "--strict", "--oss-only", "--metrics", "off", "--disable-version-check",
                "--no-git-ignore", "--no-rewrite-rule-ids", "--jobs", "1", "--", str(target)]
        for name, command in commands.items():
            output["probes"][name] = probe(command, snapshot)
    print(json.dumps(output, indent=2))
    return 0 if all(p.get("exit_code") == 0 for p in output["probes"].values()) else 3


if __name__ == "__main__":
    raise SystemExit(main())
