#!/usr/bin/env python3
"""Sanity-check a generated layout file.

Guards the invariants the web app relies on, so a bad regeneration fails loudly
instead of quietly putting pins in the wrong place.

    python3 tools/check_layout.py data/C108.json
"""
import json
import sys


def check(path: str) -> list[str]:
    doc = json.load(open(path, encoding='utf-8'))
    problems: list[str] = []

    for key in ('event', 'source', 'pages'):
        if key not in doc:
            problems.append(f'missing top-level key: {key}')
    if problems:
        return problems

    seen: dict[str, str] = {}
    for page in doc['pages']:
        tag = f'page {page["index"] + 1}'
        if not page.get('blocks'):
            problems.append(f'{tag}: no blocks')
        for block in page['blocks']:
            name = block['block']
            where = f'{tag} {block["hall"]}{name}'

            if name in seen:
                problems.append(f'{where}: block letter also used by {seen[name]}')
            seen[name] = where

            if block['count'] != len(block['rows']) * 2:
                problems.append(f'{where}: count {block["count"]} != rows*2 '
                                f'{len(block["rows"]) * 2}')
            if block['count'] % 2:
                problems.append(f'{where}: odd space count {block["count"]}')
            if not 6 <= block['w'] <= 40:
                problems.append(f'{where}: implausible island width {block["w"]}')
            if not 0 <= block['x'] <= page['width']:
                problems.append(f'{where}: x {block["x"]} outside page')

            heights = []
            for i, (y0, y1) in enumerate(block['rows']):
                if y1 <= y0:
                    problems.append(f'{where}: row {i} inverted ({y0}, {y1})')
                if not 0 <= y0 < y1 <= page['height']:
                    problems.append(f'{where}: row {i} outside page ({y0}, {y1})')
                heights.append(y1 - y0)
            # rows are stored bottom-up and must not overlap
            for i in range(1, len(block['rows'])):
                if block['rows'][i][0] + 0.5 < block['rows'][i - 1][1]:
                    problems.append(f'{where}: rows {i - 1}/{i} overlap')
            if heights:
                spread = max(heights) - min(heights)
                if spread > max(heights) * 0.35:
                    problems.append(f'{where}: uneven row heights '
                                    f'({min(heights):.1f}..{max(heights):.1f})')

        for wall in page.get('walls', []):
            if wall['block'] in seen:
                problems.append(f'{tag}: wall {wall["block"]} clashes with a block')
            seen[wall['block']] = f'{tag} wall'

    return problems


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'data/C108.json'
    issues = check(path)
    doc = json.load(open(path, encoding='utf-8'))
    blocks = sum(len(p['blocks']) for p in doc['pages'])
    spaces = sum(b['count'] for p in doc['pages'] for b in p['blocks'])
    print(f'{path}: {len(doc["pages"])} pages, {blocks} blocks, {spaces} spaces')
    for issue in issues:
        print(f'  FAIL {issue}')
    if issues:
        sys.exit(1)
    print('  all checks passed')
