import json
import pathlib
import subprocess
import sys

api, output = sys.argv[1:]
root = pathlib.Path(__file__).resolve().parents[4]
output = pathlib.Path(output)
with output.with_suffix('.diagnostic.json').open('w') as result, output.with_suffix('.profiler.log').open('w') as log:
    child = subprocess.Popen(['node', 'scripts/profile-tiobe.mjs', '--api', api, '--seconds', '20'], cwd=root, stdout=result, stderr=subprocess.PIPE, text=True)
    try:
        while True:
            line = child.stderr.readline()
            log.write(line)
            log.flush()
            if 'Warm workload ready' in line:
                break
            if child.poll() is not None:
                raise RuntimeError('Workload exited before its warm marker')
        recording = subprocess.run(['/usr/bin/sample', str(child.pid), '10', '1', '-file', str(output)], stdout=log, stderr=log)
        if recording.returncode:
            raise RuntimeError(f'Profiler exited {recording.returncode}')
        if child.wait(timeout=60):
            raise RuntimeError('Workload failed')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
print(output)
