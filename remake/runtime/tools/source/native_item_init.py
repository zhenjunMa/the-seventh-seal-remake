"""The deterministic subset of GAME.exe item initializer 0x47B3C0.

Only recreates the fields the native initializer writes. Other bytes remain
intact. All min/max pairs must match: random initialization is unsupported.
Source: save_analysis_20261010/rea_format_evidence.json inventory_init
(GAME.exe SHA-256 fc6c0194...).
"""
import struct

INSTANCE_SIZE = 0xE5
DEFINITION_SIZE = 0x3BF
VALUE_PAIRS = (
    (0x0D, 0x17E), (0x11, 0x186), (0x15, 0x18E), (0x19, 0x196),
    (0x1D, 0x19E), (0x21, 0x1A6), (0x25, 0x1AE), (0x29, 0x1B6),
    (0x2D, 0x1CE), (0x31, 0x1EA), (0x35, 0x1F2), (0x39, 0x1FA),
    (0x3D, 0x202), (0x41, 0x20A), (0x45, 0x212), (0x49, 0x21A),
    (0x4D, 0x222), (0x51, 0x29A), (0x55, 0x22A), (0x59, 0x232),
    (0x5D, 0x23A), (0x61, 0x242),
) + tuple((0x65 + i * 4, 0x24A + i * 8) for i in range(10))


def initialize_existing_instance(instance, definition):
    if len(instance) != INSTANCE_SIZE or len(definition) != DEFINITION_SIZE:
        raise ValueError('Wrong instance or definition record size.')
    result = bytearray(instance)
    result[0:4] = definition[0:4]
    result[9] = definition[0x176]
    result[10:13] = b'\0\0\0'
    for destination, source in VALUE_PAIRS:
        minimum, maximum = struct.unpack_from('<2i', definition, source)
        if minimum != maximum:
            raise ValueError(f'Random value range at definition +0x{source:X} is unsupported.')
        struct.pack_into('<i', result, destination, minimum)
    return bytes(result)
