import re
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
text = open(src_path, encoding='utf-8', errors='replace').read().replace('\r', '').lstrip('﻿')
# Some community files use '->' instead of '-->'.
text = re.sub(r'(\d{2}:\d{2}:\d{2}[,.]\d{3})[ \t]*-+>[ \t]*(\d{2}:\d{2}:\d{2}[,.]\d{3})', r'\1 --> \2', text)
blocks = [b for b in re.split(r'\n[ \t]*\n', text.strip()) if '-->' in b]
out = ['WEBVTT', '']
for b in blocks:
    lines = [l for l in b.split('\n') if l.strip()]
    i = next(k for k, l in enumerate(lines) if '-->' in l)
    timing = re.sub(r'(\d{2}:\d{2}:\d{2}),(\d{3})', r'\1.\2', lines[i])
    out += [timing] + lines[i + 1:] + ['']
open(dst_path, 'w', encoding='utf-8').write('\n'.join(out))
print(f'{len(blocks)} cues -> {dst_path}')
