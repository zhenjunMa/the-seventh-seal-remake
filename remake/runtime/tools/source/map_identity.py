"""Original map basename syntax, independent of content admission.

The shipped DAT inventory includes m01020a, m03012_1f, m70078-1_1,
m71076-1-03, m72010-0-A, mtest/mtest2, Elf-forest-A through -W, and the seven ruin families.
Case is normalized only at filename boundaries.
Keep this contract aligned with web/core/exploration/native_map_identity.mjs.
"""
import re

MAP_ID = re.compile(r'(?:M[0-9]{5}[A-Z]?(?:[-_][0-9A-Z]+)*|MTEST2?|ELF-FOREST-[A-W]'
                    r'|(?:REBIRTH|SILENCE|JUDGELIGH|YEARN|RUINOUSLY|HELLWAY)-[A-Z][0-9]{2}'
                    r'|WING-[A-Z][0-9]{2}-[A-C])')


def is_native_map_id(value):
    return isinstance(value, str) and len(value) <= 20 and MAP_ID.fullmatch(value) is not None


def native_map_id_from_filename(value):
    if not isinstance(value, str) or not value.upper().endswith('.DAT'):
        return None
    ident = value[:-4].upper()
    return ident if is_native_map_id(ident) else None
