"""Exercise incremental exports and evidence preservation in an isolated tree."""
from pathlib import Path
import importlib.util
import json
import sys
import subprocess
import symtable
import builtins
import tempfile
import unittest
from unittest.mock import patch
import copy

TOOL = Path(__file__).resolve().parents[1] / 'tools/build_runtime.py'
spec = importlib.util.spec_from_file_location('runtime_build_test_module', TOOL)
build = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = build
spec.loader.exec_module(build)
from incremental import resource, write_bytes, write_json, save_png, file_hash, local_modules, build_lock
from incremental_atlas import build_atlas, source_image
import export_battle_packs as packs


class BuildTests(unittest.TestCase):
    def test_source_atlas_decode_uses_real_033_shadow_dimensions_and_restores_pillow_guard(self):
        from PIL import Image
        from source.dgp import DGP
        from unittest.mock import MagicMock
        graphics=DGP(TOOL.parents[3]/'Fight_Role/033.dgp')
        self.assertEqual((graphics.width,graphics.height,graphics.frame_count),(1119,719,268))
        self.assertEqual(max(action['first_frame']+action['frames_per_direction']*action['directions']
                             for action in graphics.actions),graphics.frame_count)
        bounds=[box for frame in range(graphics.frame_count) if (box:=graphics.decode_shadow(frame).getbbox())]
        width=max(box[2] for box in bounds)-min(box[0] for box in bounds)
        height=max(box[3] for box in bounds)-min(box[1] for box in bounds)
        descriptor={'width':16*width,'height':((graphics.frame_count+15)//16)*height}
        self.assertEqual((descriptor['width'],descriptor['height']),(17888,12223))
        expected_pixels=descriptor['width']*descriptor['height']
        self.assertEqual(expected_pixels,218645024)
        opened=MagicMock();opened.__enter__.return_value=opened;opened.size=(descriptor['width'],descriptor['height'])
        decoded=object()
        def convert(mode):
            self.assertEqual(mode,'RGBA');self.assertEqual(Image.MAX_IMAGE_PIXELS,expected_pixels)
            return decoded
        opened.convert.side_effect=convert
        with patch.object(Image,'open',return_value=opened),patch.object(Image,'MAX_IMAGE_PIXELS',123):
            self.assertIs(source_image(Path('verified-source.png'),descriptor),decoded)
            self.assertEqual(Image.MAX_IMAGE_PIXELS,123)
            opened.size=(descriptor['width']-1,descriptor['height']);opened.convert.reset_mock()
            with self.assertRaisesRegex(ValueError,'geometry mismatch'):
                source_image(Path('verified-source.png'),descriptor)
            opened.convert.assert_not_called();self.assertEqual(Image.MAX_IMAGE_PIXELS,123)
        with tempfile.TemporaryDirectory() as temporary:
            image=Image.new('RGBA',(8,7),(17,31,47,255));path=Path(temporary)/'source.png';image.save(path)
            with patch.object(Image,'MAX_IMAGE_PIXELS',4):
                self.assertEqual(source_image(path,{'width':8,'height':7}).tobytes(),image.tobytes())
                self.assertEqual(Image.MAX_IMAGE_PIXELS,4)
                with self.assertRaises(Image.DecompressionBombError):Image.open(path)

    def test_exporter_function_bodies_have_no_unbound_global_names(self):
        allowed=set(dir(builtins))|{'__file__','__name__','__package__','__doc__','__spec__','__loader__','__builtins__'}
        names={step.tool for step in build.STEPS.values() if step.tool.endswith('.py')}|{'incremental.py','incremental_atlas.py'}
        for name in sorted(names):
            path=TOOL.parent/name
            module=symtable.symtable(path.read_text('utf-8-sig'),str(path),'exec')
            known=allowed|{s.get_name() for s in module.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
            def missing(table):
                result={s.get_name() for s in table.get_symbols() if s.is_referenced() and s.is_global() and s.get_name() not in known}
                for child in table.get_children(): result.update(missing(child))
                return result
            with self.subTest(tool=name): self.assertEqual(missing(module),set())

    def test_python_exporters_import_in_an_independent_isolated_process(self):
        # Embedded Python does not add a script's directory to sys.path. A
        # shared unittest process can otherwise conceal broken CLI imports.
        for name in sorted({step.tool for step in build.STEPS.values() if step.tool.endswith('.py')}):
            with self.subTest(tool=name):
                result=subprocess.run([sys.executable,'-B','-c',
                    "import runpy,sys; runpy.run_path(sys.argv[1],run_name='export_import_check')",
                    str(TOOL.parent/name)],capture_output=True,text=True,encoding='utf-8',errors='replace')
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_manifest_tracks_shared_media_outside_its_original_export_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            web=Path(temporary); media=web/'assets/shared/effect.png'; media.parent.mkdir(parents=True)
            media.write_bytes(b'pixels')
            (web/'view.json').write_text(json.dumps({'effects':[{'sheet':'/assets/shared/effect.png'}]}))
            with patch.object(build,'WEB',web):
                step=build.Step('export.py',('view.json',))
                self.assertIn(str(media.resolve()),build.output_hashes(step))
                media.unlink()
                with self.assertRaises(FileNotFoundError): build.output_hashes(step)

    def test_only_consumed_data_and_local_tool_imports_invalidate_steps(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); runtime=root/'runtime'; web=runtime/'web'; evidence=runtime/'evidence'
            tools=runtime/'tools'; tools.mkdir(parents=True); web.mkdir(); evidence.mkdir()
            (tools/'a.py').write_text('import decoder\n')
            (tools/'decoder.py').write_text('VERSION = 1\n')
            (tools/'unrelated.py').write_text('VERSION = 1\n')
            (web/'upstream.json').write_text('old')
            steps={'a':build.Step('a.py',('upstream.json',)),
                   'b':build.Step('a.py',(),('a',)),
                   'consumer':build.Step('a.py',(),('a',),inputs=('upstream.json',))}
            with patch.multiple(build,ROOT=root,RUNTIME=runtime,WEB=web,EVIDENCE=evidence,STEPS=steps):
                before={name:build.signature(step) for name,step in steps.items()}
                (tools/'unrelated.py').write_text('VERSION = 2\n')
                self.assertEqual(before,{name:build.signature(step) for name,step in steps.items()})
                (web/'upstream.json').write_text('new')
                self.assertEqual(before['b'],build.signature(steps['b']))
                self.assertNotEqual(before['consumer'],build.signature(steps['consumer']))
                (tools/'decoder.py').write_text('VERSION = 2\n')
                self.assertNotEqual(before['b'],build.signature(steps['b']))

    def test_registration_projection_and_cross_language_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime=Path(temporary); tools=runtime/'tools'; tools.mkdir()
            (tools/'export.py').write_text("resolver = 'resolve.mjs'\n")
            (tools/'resolve.mjs').write_text("import './helper.mjs';\n")
            (tools/'helper.mjs').write_text('export const version = 1;\n')
            self.assertEqual({p.name for p in local_modules(tools/'export.py',runtime)},
                             {'export.py','resolve.mjs','helper.mjs'})
            path=runtime/'content.json'
            value={'roles':{'001':{'side':'player','battle_skills':[]}},'maps':{}}
            path.write_text(json.dumps(value))
            step=build.Step('export.py',(),registration=('players',))
            before=build.registration_input(step,path)
            value['maps']['M17029']={}; path.write_text(json.dumps(value))
            self.assertEqual(before,build.registration_input(step,path))
            value['roles']['001']['battle_skills'].append({'index':22}); path.write_text(json.dumps(value))
            self.assertNotEqual(before,build.registration_input(step,path))

    def test_resource_reuse_addition_repair_and_failed_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime=Path(temporary)
            calls=[]
            def run(key,source='v1',rule='rule1',fail=False):
                path=runtime/(key+'.bin')
                def produce():
                    calls.append(key)
                    if fail: raise RuntimeError('controlled failure')
                    write_bytes(path,source.encode())
                    return {'value':source},[path]
                return resource(runtime,key,{'source':source},rule,produce)
            run('a'); before=(runtime/'a.bin').stat().st_mtime_ns
            run('a'); run('b')
            self.assertEqual(calls,['a','b'])
            self.assertEqual(before,(runtime/'a.bin').stat().st_mtime_ns)
            (runtime/'a.bin').write_bytes(b'corrupt')
            run('a'); run('b')
            self.assertEqual(calls,['a','b','a'])
            with self.assertRaisesRegex(RuntimeError,'controlled failure'):
                run('a','v2',fail=True)
            self.assertEqual(run('a'),{'value':'v1'})
            run('a',rule='rule2')
            self.assertEqual(calls,['a','b','a','a','a'])

    def test_identical_json_preserves_legacy_bytes_and_exclusive_build_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); path=root/'output.json'
            path.write_bytes(b'{\r\n  "value": 1\r\n}\r\n')
            before=path.stat().st_mtime_ns
            self.assertFalse(write_json(path,{'value':1}))
            self.assertEqual(before,path.stat().st_mtime_ns)
            self.assertTrue(write_json(path,{'value':2}))
            self.assertIn(b'\r\n',path.read_bytes())
            audio=root/'victory.mp3'; write_bytes(audio,b'ID3 original bytes')
            audio_time=audio.stat().st_mtime_ns
            self.assertFalse(write_bytes(audio,b'ID3 original bytes'))
            self.assertEqual(audio_time,audio.stat().st_mtime_ns)
            with build_lock(root):
                with self.assertRaisesRegex(RuntimeError,'Another runtime build'):
                    with build_lock(root): pass
            with build_lock(root): pass

    def test_atlas_append_dedup_noop_and_exact_page_repair(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            runtime=Path(temporary)/'remake/runtime'; web=runtime/'web'; web.mkdir(parents=True)
            data={'assets':[],'manifests':{}}
            def add(name,color,owner):
                path=web/'assets'/name
                save_png(Image.new('RGBA',(4,4),color),path)
                data['assets'].append(dict(path='/assets/'+name,sha256=file_hash(path),width=4,height=4,
                    tile_width=4,tile_height=4,group='effect-'+name,owners=[owner]))
            def run():
                return build_atlas(copy.deepcopy(data),runtime=runtime,web=web,out=web/'assets/battle_packs',
                    layout_pages=packs.layout_pages,packing_family=packs.packing_family,dependency_groups=packs.dependency_groups)
            add('red.png','red','001')
            first,*_=run()
            first=copy.deepcopy(first)
            old_page=web/first['pages'][0]['path'].lstrip('/')
            page_time=old_page.stat().st_mtime_ns
            add('green.png','green','002')
            second,_,_,counts=run()
            self.assertEqual(counts['new_pages'],1)
            self.assertEqual(second['pages'][:len(first['pages'])],first['pages'])
            self.assertEqual(second['images']['/assets/red.png'],first['images']['/assets/red.png'])
            self.assertEqual(page_time,old_page.stat().st_mtime_ns)
            add('red-shared.png','red','003')
            third,_,_,counts=run()
            self.assertEqual(counts['new_pages'],0)
            self.assertEqual(third['images']['/assets/red-shared.png']['regions'],first['images']['/assets/red.png']['regions'])
            files=[web/'data/battle_packs.json',runtime/'evidence/resource_cache/battle_tiles.json',old_page]
            before={path:path.stat().st_mtime_ns for path in files}
            _,_,_,counts=run()
            self.assertEqual(counts['decoded_images'],0)
            self.assertEqual(before,{path:path.stat().st_mtime_ns for path in files})
            other=web/second['pages'][1]['path'].lstrip('/')
            other_time=other.stat().st_mtime_ns
            old_page.write_bytes(b'broken')
            repaired,_,_,counts=run()
            self.assertEqual(counts['repaired_pages'],1)
            self.assertEqual(file_hash(old_page),first['pages'][0]['sha256'])
            self.assertEqual(repaired['images'],third['images'])
            self.assertEqual(other_time,other.stat().st_mtime_ns)

    def test_asset_counts_do_not_break_source_ledger_and_aliases_still_resolve(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            evidence = root/'evidence'; evidence.mkdir()
            source = root/'assets/source.dgp'; source.parent.mkdir(); source.write_bytes(b'original')
            ledger = evidence/'export.json'
            step = build.Step('export.py', ('output.json',), reports=('export.json',))
            with patch.multiple(build, ROOT=root, EVIDENCE=evidence):
                for assets in [27, {}, None, []]:
                    ledger.write_text(json.dumps({'source_hashes':{'assets/source.dgp':build.sha(source)}, 'assets':assets}))
                    self.assertEqual(build.source_paths(step), {source})
                ledger.write_text(json.dumps({'source_hashes':{'source.dgp':build.sha(source)},
                    'assets':[{'source':{'path':'assets/source.dgp'}}, {'source':None}]}))
                self.assertEqual(build.source_paths(step), {source})

    def test_first_export_tracks_sources_without_an_existing_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            runtime, web, evidence = root/'runtime', root/'runtime/web', root/'runtime/evidence'
            web.mkdir(parents=True); evidence.mkdir()
            source = root/'new-map.dat'; source.write_bytes(b'original')
            steps = {'new-map': build.Step('map.py', ('map.json',), reports=('map_export.json',), sources=('new-map.dat',))}
            called = []
            def exporter(command, name):
                called.append(name)
                (web/'map.json').write_text(json.dumps('generated'))
                (evidence/'map_export.json').write_text(json.dumps({'source_hashes': {'new-map.dat': build.sha(source)}}))
            stamp = build.datetime.now(build.timezone.utc)
            with patch.multiple(build, ROOT=root, RUNTIME=runtime, WEB=web, EVIDENCE=evidence, STEPS=steps), patch.object(build, 'datetime') as clock:
                clock.now.return_value = stamp
                build.execute(['new-map'], run_command=exporter)
                build.execute(['new-map'], run_command=exporter)
                self.assertEqual(called, ['new-map'])
                source.write_bytes(b'updated original')
                build.execute(['new-map'], run_command=exporter)
                self.assertEqual(called, ['new-map', 'new-map'])
                self.assertEqual(len(list((evidence/'builds').iterdir())), 3)

    def test_added_source_inventory_is_allowed_but_input_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();runtime=root/'runtime';web=runtime/'web';evidence=runtime/'evidence'
            web.mkdir(parents=True);evidence.mkdir()
            first=root/'first.chr';second=root/'second.chr'
            first.write_bytes(b'first');second.write_bytes(b'second')
            ledger=evidence/'export.json'
            ledger.write_text(json.dumps({'source_hashes':{'first.chr':build.sha(first)}}))
            steps={'roles':build.Step('roles.py',('roles.json',),reports=('export.json',))}
            def exporter(command,name):
                (web/'roles.json').write_text(json.dumps('new role'))
                ledger.write_text(json.dumps({'source_hashes':{'first.chr':build.sha(first),'second.chr':build.sha(second)}}))
            with patch.multiple(build,ROOT=root,RUNTIME=runtime,WEB=web,EVIDENCE=evidence,STEPS=steps):
                self.assertTrue(build.execute(['roles'],run_command=exporter)['passed'])
                def corrupt(command,name):
                    exporter(command,name);first.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError,'changed original inputs'):
                    build.execute(['roles'],force=True,run_command=corrupt)

    def test_dependency_order_and_cycle(self):
        steps = {'a':build.Step('a.py', ('a.json',)), 'b':build.Step('b.py', ('b.json',), ('a',))}
        self.assertEqual(build.plan(['b', 'a'], steps), ['a', 'b'])
        steps['a'] = build.Step('a.py', ('a.json',), ('b',))
        with self.assertRaisesRegex(ValueError, 'cycle'):
            build.plan(['a'], steps)

    def test_incremental_output_validation_resume_and_old_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            runtime, web, evidence = root/'runtime', root/'runtime/web', root/'runtime/evidence'
            web.mkdir(parents=True); evidence.mkdir()
            original = root/'original.dat'; original.write_bytes(b'input')
            history = evidence/'export_20261011.json'
            original_report = json.dumps({'source_hashes':{'original.dat':build.sha(original)}}).encode()
            history.write_bytes(original_report)
            steps = {'a':build.Step('a.py', ('a.json',), reports=(history.name,)),
                     'b':build.Step('b.py', ('b.json',), ('a',))}
            called = []
            fail = {'b':True}
            def exporter(command, name):
                called.append(name)
                if fail.get(name):
                    raise RuntimeError('controlled failure')
                (web/f'{name}.json').write_text(json.dumps('new output'))
                if name == 'a':
                    history.write_text('new evidence, retained separately')
            with patch.multiple(build, ROOT=root, RUNTIME=runtime, WEB=web, EVIDENCE=evidence, STEPS=steps):
                with self.assertRaisesRegex(RuntimeError, 'controlled failure'):
                    build.execute(['b'], run_command=exporter)
                self.assertEqual(history.read_bytes(), original_report)
                self.assertEqual(set(json.loads((evidence/'build_state.json').read_text())['steps']), {'a'})
                fail['b'] = False
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b'])
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b'])
                (web/'a.json').write_text('broken JSON')
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b', 'a'])
                (web/'a.json').unlink()
                build.execute(['b'], run_command=exporter)
                self.assertEqual(called, ['a', 'b', 'b', 'a', 'a'])
                self.assertEqual(original.read_bytes(), b'input')
                self.assertEqual(history.read_bytes(), original_report)
                generated = list((evidence/'builds').glob('*/a/generated-evidence/export_20261011.json'))
                self.assertTrue(generated)
                self.assertEqual(generated[0].read_text(), 'new evidence, retained separately')


if __name__ == '__main__':
    unittest.main()
