"""Record source integrity and controller checks for the browser audio adapter."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest_path = RUNTIME/'web/data/audio.json'
    manifest = json.loads(manifest_path.read_text('utf-8'))
    sources = manifest['source_hashes']
    before = {p:sha(ROOT/p) for p in sources}
    assert before == sources, 'Original audio sources differ from the recorded export'
    for path,expected in {**manifest.get('reference_hashes',{}),**manifest.get('native_bundle_hashes',{})}.items():
        assert sha(ROOT/path)==expected, f'Audio source manifest/evidence reference changed: {path}'
    files = [manifest_path,RUNTIME/'web/core/audio.mjs',RUNTIME/'tests/test_audio.mjs']
    files += [RUNTIME/'web'/clip['path'].lstrip('/') for clip in manifest['clips'].values()]
    video_path=RUNTIME/'evidence/gameover_video_export.json'
    video=json.loads(video_path.read_text('utf-8'))
    assert video['success'] and video['original_source_unchanged'] and video['conversion']['decoded_ssim_all']>.99
    assert sha(ROOT/video['source']['path'])==video['source']['sha256']
    assert sha(RUNTIME/'web'/video['output']['path'].lstrip('/'))==video['output']['sha256']
    assert video['conversion']['same_frame_count'] and video['conversion']['same_duration'] and not video['conversion']['has_audio']
    files += [video_path,RUNTIME/'web'/video['output']['path'].lstrip('/')]
    hashes = {p.relative_to(RUNTIME).as_posix():sha(p) for p in files}
    command = ['node','--test','--test-reporter=spec','remake/runtime/tests/test_audio.mjs']
    run = subprocess.run(command,cwd=ROOT,capture_output=True,encoding='utf-8')
    output = run.stdout+run.stderr
    counts = {key:int(re.search(r'(?:#|ℹ)\s+'+key+r'\s+(\d+)',output)[1]) for key in ['tests','pass','fail']}
    assert run.returncode == counts['fail'] == 0 and counts['tests'] == counts['pass'], output
    assert before == {p:sha(ROOT/p) for p in sources}, 'Original sources changed during verification'
    assert hashes == {p.relative_to(RUNTIME).as_posix():sha(p) for p in files}, 'Audio code or assets changed during verification'
    report = dict(schema='seventh-seal-audio-verification',version=1,created_utc=datetime.now(timezone.utc).isoformat(),
        success=True,command=command,counts=counts,source_hashes=before,artifact_hashes=hashes,
        original_source_unchanged=True,original_game_execution_observed=False,browser_audio_playback_observed=False,
        defeat_video=dict(path=video['output']['path'],sha256=video['output']['sha256'],decoded_ssim_all=video['conversion']['decoded_ssim_all'],
                          source_unchanged=True,has_audio=False),
        authority='Controller media-double lifecycle tests, real source/asset bytes and exporter decoded-PCM audit; not original game audio runtime observation',
        limitations=manifest['limitations'])
    (RUNTIME/'evidence/audio_tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
    (RUNTIME/'evidence/audio_tests.txt').write_text(output,'utf-8')
    print(json.dumps(counts))


if __name__ == '__main__': main()
