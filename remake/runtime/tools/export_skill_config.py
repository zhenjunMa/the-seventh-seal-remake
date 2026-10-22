"""Compatibility command for the unified runtime configuration exporter."""
from pathlib import Path
import argparse
import subprocess

RUNTIME = Path(__file__).resolve().parents[1]

def export(reset=False):
    command = ['node', str(RUNTIME/'tools/export_runtime_config.mjs')]
    if reset:
        command.append('--reset')
    subprocess.run(command, check=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--reset', action='store_true', help='Restore all runtime config files to source defaults')
    export(parser.parse_args().reset)
