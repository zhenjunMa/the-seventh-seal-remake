"""Independent source-MNU RGB565 span rendering for full-pixel export tests."""
import struct
from PIL import Image


def render(raw, record):
    width, height = record['width'], record['height']
    cursor = record['source_offset'] + 20
    result = Image.new('RGBA', (width, height))
    pixels = result.load()
    alpha_start = cursor + record['stream_bytes'] * 2
    for y in range(height):
        count, = struct.unpack_from('<H', raw, cursor)
        cursor += 2
        for _ in range(0 if count == 65535 else count):
            start, size = struct.unpack_from('<HH', raw, cursor)
            cursor += 4
            for x in range(start, start + size):
                word, = struct.unpack_from('<H', raw, cursor)
                cursor += 2
                r, g, b = word >> 11, word >> 5 & 63, word & 31
                alpha = 255 - raw[alpha_start + y * width + x] if record['alpha_bytes'] else 255
                pixels[x, y] = (r * 8 + r // 4, g * 4 + g // 16, b * 8 + b // 4, alpha)
    assert cursor == record['source_offset'] + 20 + record['stream_bytes']
    return result
