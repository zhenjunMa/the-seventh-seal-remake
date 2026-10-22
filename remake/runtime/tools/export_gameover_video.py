"""Convert the source normal-defeat film to a browser-compatible MP4.

The original Bink stream has no audio. H.264 is deliberately a visually close
browser export; the source/result decoded frame hashes and SSIM are retained,
and the report never calls the lossy output byte- or pixel-identical.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--ffmpeg',default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe',default=shutil.which('ffprobe'));args=parser.parse_args()
    assert args.ffmpeg and args.ffprobe
    source=ROOT/'Animate/GO02.bik';output=RUNTIME/'web/assets/video/go02.mp4'
    initial=sha(source);game_sha=sha(ROOT/'GAME.exe')
    assert game_sha=='fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
    native_path=RUNTIME/'evidence/audio_native.json';native=json.loads(native_path.read_text('utf-8'))
    record=next(r for r in native['records'] if r['operation']=='procedure_pseudo_code' and r['parameters'].get('procedure')=='0x4307a0')
    assert record['subject']['digest']['sha256']==game_sha and 'Go02_bik' in record['normalized_result']
    def probe(path):
        run=subprocess.run([args.ffprobe,'-v','error','-count_frames','-show_entries',
            'stream=codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt:format=duration,size','-of','json',str(path)],
            capture_output=True,text=True,check=True)
        return json.loads(run.stdout)
    original=probe(source);assert len(original['streams'])==1 and original['streams'][0]['codec_name']=='binkvideo'
    output.parent.mkdir(parents=True,exist_ok=True)
    command=[args.ffmpeg,'-v','error','-y','-i',str(source),'-map','0:v:0','-an','-c:v','libx264',
             '-preset','slow','-crf','12','-profile:v','high','-pix_fmt','yuv420p','-movflags','+faststart',str(output)]
    subprocess.run(command,check=True)
    converted=probe(output);assert len(converted['streams'])==1 and converted['streams'][0]['codec_name']=='h264'
    for field in ['width','height','r_frame_rate','nb_read_frames']:assert original['streams'][0][field]==converted['streams'][0][field]
    assert abs(float(original['format']['duration'])-float(converted['format']['duration']))<.001
    def frames(path):
        run=subprocess.run([args.ffmpeg,'-v','error','-i',str(path),'-map','0:v:0','-an','-pix_fmt','yuv420p','-f','framemd5','-'],
                           capture_output=True,text=True,check=True)
        return [line for line in run.stdout.splitlines() if line and not line.startswith('#')]
    source_frames,output_frames=frames(source),frames(output)
    assert len(source_frames)==len(output_frames)==int(original['streams'][0]['nb_read_frames'])
    comparison=subprocess.run([args.ffmpeg,'-v','info','-i',str(source),'-i',str(output),'-filter_complex',
        '[0:v]format=yuv420p,settb=1/30,setpts=N[s];[1:v]format=yuv420p,settb=1/30,setpts=N[d];[s][d]ssim',
        '-an','-f','null','-'],capture_output=True,text=True,check=True)
    score=float(re.search(r'SSIM.*?All:([\d.]+)',comparison.stderr)[1]);assert score>.99,comparison.stderr
    assert sha(source)==initial and sha(ROOT/'GAME.exe')==game_sha
    report=dict(schema='seventh-seal-gameover-video-export',version=1,success=True,
        source=dict(path='Animate/GO02.bik',sha256=initial,probe=original,decoded_frames=source_frames),
        output=dict(path='/assets/video/go02.mp4',sha256=sha(output),probe=converted,decoded_frames=output_frames),
        native=dict(procedure='0x4307a0',evidence_id=record['evidence_id'],bundle='remake/runtime/evidence/audio_native.json',
                    bundle_sha256=sha(native_path),behavior='Ordinary defeat plays Go02.bik then opens the main menu'),
        conversion=dict(codec='H.264 high, yuv420p, CRF12',same_dimensions=True,same_frame_count=True,same_duration=True,
                        decoded_ssim_all=score,decoded_frames_equal=source_frames==output_frames,has_audio=False),
        original_source_unchanged=True,original_game_execution_observed=False,
        limitations=['H.264 output is a lossy browser-compatible encoding; decoded frame MD5 and SSIM document its difference.',
                     'The 89 decoded frames/2.967-second film have no audio stream; no soundtrack is added.',
                     'Static native defeat branch plus real source decode; original game execution was not observed.'])
    (RUNTIME/'evidence/gameover_video_export.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n','utf-8')
    print(json.dumps(dict(frames=len(source_frames),ssim=score,output_bytes=output.stat().st_size,source_unchanged=True)))


if __name__=='__main__':main()
