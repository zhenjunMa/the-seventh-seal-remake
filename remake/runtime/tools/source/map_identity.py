"""Safe original M-family and Elf-forest identity syntax, independent of admission.

The shipped DAT inventory includes m01020a, m03012_1f, m70078-1_1,
m71076-1-03, m72010-0-A, and the distinct Elf-forest-A through -W maps.
Case is normalized only at filename boundaries.
Keep this contract aligned with web/core/native_map_identity.mjs.
"""
import re

MAP_ID = re.compile(r'(?:M[0-9]{5}[A-Z]?(?:[-_][0-9A-Z]+)*|ELF-FOREST-[A-W])')


def is_native_map_id(value):
    return isinstance(value, str) and len(value) <= 20 and MAP_ID.fullmatch(value) is not None


def native_map_id_from_filename(value):
    if not isinstance(value, str) or not value.upper().endswith('.DAT'):
        return None
    ident = value[:-4].upper()
    return ident if is_native_map_id(ident) else None
