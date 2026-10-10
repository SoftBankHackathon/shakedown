"""CLI writes one JSON report to stdout with decision-specific exit codes."""
import argparse
import json

from .scanner import DEFAULT_MAX_FILE_BYTES, DEFAULT_TIMEOUT_SECONDS, scan

EXIT_CODES = {"ALLOW": 0, "DENY": 1, "SCAN_FAILED": 3}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Static Docker Compose checks with optional Semgrep and Gitleaks")
    parser.add_argument("path", help="Local directory or Compose file")
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--with-semgrep", action="store_true", help="Version 2 Docker + local Semgrep report")
    parser.add_argument("--semgrep-timeout-seconds", type=float, default=30.0)
    parser.add_argument("--with-gitleaks", action="store_true", help="Version 3 Docker + Semgrep + Gitleaks report")
    parser.add_argument("--gitleaks-timeout-seconds", type=float, default=30.0)
    args = parser.parse_args(argv)
    if args.with_gitleaks:
        from .gate3 import scan_full_repository
        result = scan_full_repository(args.path, max_file_bytes=args.max_file_bytes,
                                      docker_timeout_seconds=args.timeout_seconds,
                                      semgrep_timeout_seconds=args.semgrep_timeout_seconds,
                                      gitleaks_timeout_seconds=args.gitleaks_timeout_seconds)
    elif args.with_semgrep:
        from .gate import scan_repository
        result = scan_repository(args.path, max_file_bytes=args.max_file_bytes,
                                 docker_timeout_seconds=args.timeout_seconds,
                                 semgrep_timeout_seconds=args.semgrep_timeout_seconds)
    else:
        result = scan(args.path, max_file_bytes=args.max_file_bytes, timeout_seconds=args.timeout_seconds)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return EXIT_CODES[result["decision"]]
