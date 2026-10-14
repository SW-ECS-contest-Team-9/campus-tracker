"""Compile the reference helpers with the app's Swift isolation settings and run checks."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

REFERENCE = Path(__file__).resolve().parent
source = REFERENCE / "TrackingCorrectionReference.swift"
checks = REFERENCE / "ReferenceChecks.swift"
with tempfile.TemporaryDirectory(prefix="campus-tracking-reference-") as temporary:
    directory = Path(temporary)
    main = directory / "main.swift"
    main.write_text(checks.read_text())
    binary = directory / "probe"
    flags = ["-swift-version", "5", "-default-isolation", "MainActor",
             "-strict-concurrency=complete", "-warnings-as-errors"]
    subprocess.run(["swiftc", *flags, "-module-cache-path", str(directory / "module-cache"),
                    str(source), str(main), "-o", str(binary)], check=True)
    execution = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
report = {
    "scope": "Host-side Foundation reference checks; no iOS app build or device accuracy claim.",
    "compiler_flags": flags,
    "source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (source, checks)},
    "output": execution.stdout.splitlines(),
}
(REFERENCE / "CHECK_RESULTS.json").write_text(json.dumps(report, indent=2) + "\n")
print(execution.stdout, end="")
