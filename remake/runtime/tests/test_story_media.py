"""Source selection, literal media identity and retained complete-decode proof."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_story_media as media


def anm(commands):
    header = bytearray(67)
    struct.pack_into('<H', header, 0, 3)
    struct.pack_into('<I', header, 2, len(commands))
    result = bytes(header)
    for opcode, token, mode in commands:
        row = bytearray(74);row[0] = opcode;row[29] = mode
        encoded = token.encode('ascii')
        assert len(encoded) <= 20
        row[54:54+len(encoded)] = encoded
        result += row
    return result


class StoryMediaSourceTests(unittest.TestCase):
    def test_registered_and_source_only_programs_retain_distinct_authority_and_native_key(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name);(root/'Animate').mkdir();(root/'sound').mkdir()
            (root/'Animate/live.anm').write_bytes(anm([(60, '20.bik', 0)]))
            (root/'Animate/later.anm').write_bytes(anm([(62, 'MANYANSHORT.wav', 2), (62, '', 1)]))
            (root/'Animate/20.bik').write_bytes(b'input video')
            (root/'sound/MANYANSHORT.wav').write_bytes(b'ID3 input audio')
            before = {path: path.read_bytes() for path in root.rglob('*') if path.is_file()}
            result = media.discover(['live'], ['later'], root)
            self.assertEqual({row['id']: row['selection_authority'] for row in result['programs']},
                             {'later':'declared-source-preparation', 'live':'runtime-registered'})
            reference = result['sounds']['manyanshort.wav']['referenced_by'][0]
            self.assertEqual(reference['filename_raw'], 'MANYANSHORT.wav')
            self.assertEqual(reference['source']['offset'], 67)
            self.assertEqual(reference['raw_hex'], anm([(62, 'MANYANSHORT.wav', 2)])[67:].hex())
            self.assertEqual(result['empty_sound_commands'][0]['command_index'], 1)
            self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_bad_partition_unsafe_names_and_missing_sources_fail_closed(self):
        for bad in [b'bad', b'\x02\x00'+anm([])[2:], anm([(60, '../20.bik', 0)]), anm([(60, 'absent.bik', 0)]),
                    anm([(62, 'foo.mp3', 0)]), anm([(60, '', 0)])]:
            with tempfile.TemporaryDirectory() as name:
                root = Path(name);(root/'Animate').mkdir();(root/'sound').mkdir()
                (root/'Animate/bad.anm').write_bytes(bad)
                with self.assertRaises(ValueError):
                    media.discover(['bad'], [], root)

    def test_source_selection_does_not_use_file_prefix_or_invent_assets(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name);(root/'Animate').mkdir();(root/'sound').mkdir()
            (root/'Animate/selected.anm').write_bytes(anm([]))
            (root/'Animate/selected-late.anm').write_bytes(anm([(60, 'absent.bik', 0)]))
            result = media.discover(['selected'], [], root)
            self.assertEqual(result['videos'], {});self.assertEqual(result['sounds'], {})
            self.assertEqual([row['id'] for row in result['programs']], ['selected'])

    @unittest.skipUnless((media.ROOT/'Animate/m17030-1.anm').is_file(), 'Original source unavailable')
    def test_real_late_fire_valley_media_closure_is_preserved_before_program_admission(self):
        result = media.discover([], media.SOURCE_PREPARATION_PROGRAMS)
        self.assertEqual(set(result['videos']), {'20.bik','24.bik','25.bik'})
        self.assertEqual(set(result['sounds']), {'manyanshort.wav'})
        self.assertEqual([result['videos'][key]['referenced_by'][0]['command_index'] for key in ['20.bik','24.bik','25.bik']], [96,107,182])
        self.assertEqual(result['sounds']['manyanshort.wav']['referenced_by'][0]['command_index'], 62)
        self.assertTrue(all(row['selection_authority']=='declared-source-preparation' for row in result['programs']))

    def test_content_build_tracks_original_media_without_dependency_on_final_registry(self):
        import build_runtime as build
        self.assertIn('story-media', build.STEPS['content'].depends)
        self.assertEqual(build.STEPS['story-media'].depends, ())
        self.assertTrue({'Animate/20.bik','Animate/24.bik','Animate/25.bik','sound/MANYANSHORT.wav'} <= set(build.STEPS['story-media'].sources))


@unittest.skipUnless(media.REPORT.exists(), 'Complete media export not yet prepared')
class StoryMediaArtifactTests(unittest.TestCase):
    def test_retained_manifest_and_whole_source_output_hashes_match_complete_decode_report(self):
        report = json.loads(media.REPORT.read_text('utf8'))
        manifest = json.loads(media.MANIFEST.read_text('utf8'))
        self.assertTrue(report['success']);self.assertFalse(report['original_game_execution_observed'])
        self.assertEqual(media.sha(media.MANIFEST), report['manifest']['sha256'])
        for row in report['assets']:
            self.assertEqual(media.sha(media.ROOT/row['source']['path']), row['source']['sha256'])
            self.assertEqual(media.sha(media.WEB/row['output']['path'].lstrip('/')), row['output']['sha256'])
            self.assertEqual(manifest[row['kind']][row['id']]['sha256'], row['output']['sha256'])
            verified = row['verification'];validation = verified['validation']
            self.assertTrue(validation['complete_media_decode_succeeded'])
            if row['kind']=='videos':
                self.assertGreater(validation['decoded_ssim_all'], .99)
                self.assertEqual(len(verified['source_decoded_video_frames']), len(verified['output_decoded_video_frames']))
                if validation['source_audio_present']:
                    audio = validation['audio']
                    self.assertEqual(audio['playback_gain'], manifest['videos'][row['id']]['audio']['playback_gain'])
                    self.assertEqual(audio['encode_gain']*audio['playback_gain'], 1)
                    self.assertGreater(audio['restored_aligned_source_prefix_snr_db'], 25)
            else:
                self.assertTrue(validation['decoded_pcm_identical'])
        self.assertTrue(manifest['sounds']['manyanshort.wav']['path'].endswith('.mp3'))


if __name__ == '__main__':
    unittest.main()
