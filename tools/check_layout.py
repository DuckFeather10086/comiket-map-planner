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

        # a space may be drawn once and only once, or a click would be ambiguous
        placed: dict[str, str] = {}
        for strip in page.get('wallStrips', []):
            where = f'{tag} {strip["hall"]}{strip["block"]}'
            count = abs(strip['to'] - strip['from']) + 1
            step = 1 if strip['to'] >= strip['from'] else -1
            length = strip['h'] if strip.get('axis') == 'y' else strip['w']

            if strip['block'] not in {w['block'] for w in page.get('walls', [])}:
                problems.append(f'{where}: strip on a block this page has no wall for')
            if not (strip.get('axis') in ('x', 'y')) ^ ('a' in strip):
                problems.append(f'{where}: strip needs exactly one of axis and a')
            if strip['w'] <= 0 or strip['h'] <= 0:
                problems.append(f'{where}: strip {strip["from"]} has no area')
            if not 4 <= length / count <= 15:
                problems.append(f'{where}: strip {strip["from"]}-{strip["to"]} '
                                f'has {length / count:.1f}pt cells')
            for x, y in ((strip['x'], strip['y']),
                         (strip['x'] + strip['w'], strip['y'] + strip['h'])):
                if not (-1 <= x <= page['width'] + 1
                        and -1 <= y <= page['height'] + 1):
                    problems.append(f'{where}: strip {strip["from"]} outside the page')
            for i in range(count):
                key = f'{strip["block"]}-{strip["from"] + step * i}'
                if key in placed:
                    problems.append(f'{where}: {key} also drawn by {placed[key]}')
                placed[key] = f'strip {strip["from"]}-{strip["to"]}'

        for i, shape in enumerate(page.get('structures', [])):
            if shape['w'] <= 0 or shape['h'] <= 0:
                problems.append(f'{tag}: structure {i} has no area')
            if not 0 <= shape['tone'] <= 1:
                problems.append(f'{tag}: structure {i} tone {shape["tone"]} out of range')
            if not (-1 <= shape['x'] and shape['x'] + shape['w'] <= page['width'] + 1
                    and -1 <= shape['y'] and shape['y'] + shape['h'] <= page['height'] + 1):
                problems.append(f'{tag}: structure {i} outside the page')

    return problems


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'data/C108.json'
    issues = check(path)
    doc = json.load(open(path, encoding='utf-8'))
    blocks = sum(len(p['blocks']) for p in doc['pages'])
    spaces = sum(b['count'] for p in doc['pages'] for b in p['blocks'])
    walls = sum(abs(s['to'] - s['from']) + 1
                for p in doc['pages'] for s in p.get('wallStrips', []))
    print(f'{path}: {len(doc["pages"])} pages, {blocks} blocks, {spaces} spaces, '
          f'{walls} wall spaces')
    for issue in issues:
        print(f'  FAIL {issue}')
    if issues:
        sys.exit(1)
    print('  all checks passed')
