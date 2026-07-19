#!/usr/bin/env python3
"""Static ES-module graph check for the build-free frontend.

Without a local JS runtime we can still catch the most common cause of a broken
build-free app: an import that points at a missing file or a name the target
module doesn't export. This scans public/app + public/index.html import map and
verifies every relative/bare import resolves to a real file AND that every named
import matches an export in the target module.

Not a substitute for running the app — it catches wiring errors, not logic bugs.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')

# import map from index.html
BARE = {
    'preact': 'public/vendor/preact.module.js',
    'preact/hooks': 'public/vendor/hooks.module.js',
    'htm': 'public/vendor/htm.module.js',
}

IMPORT_RE = re.compile(
    r'import\s+(?:(?P<ns>\*\s+as\s+\w+)|(?P<def>\w+)\s*,?\s*)?'
    r'(?:\{(?P<named>[^}]*)\})?\s*from\s*[\'"](?P<path>[^\'"]+)[\'"]',
    re.M)
EXPORT_DECL_RE = re.compile(r'export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)')
EXPORT_LIST_RE = re.compile(r'export\s*\{([^}]*)\}')
EXPORT_DEFAULT_RE = re.compile(r'export\s+default\b')


def exports_of(path):
    """Best-effort set of named exports. For the vendored bundles (preact etc.)
    we can't reliably regex the minified re-exports, so treat them as exporting
    anything (return None = 'any')."""
    rel = os.path.relpath(path, ROOT).replace('\\', '/')
    if rel.startswith('public/vendor/'):
        return None
    try:
        src = open(path, encoding='utf-8').read()
    except OSError:
        return set()
    names = set(EXPORT_DECL_RE.findall(src))
    for grp in EXPORT_LIST_RE.findall(src):
        for part in grp.split(','):
            part = part.strip()
            if not part:
                continue
            # handle "a as b"
            name = part.split(' as ')[-1].strip()
            names.add(name)
    if EXPORT_DEFAULT_RE.search(src):
        names.add('default')
    return names


def resolve(import_path, from_file):
    if import_path in BARE:
        return os.path.join(ROOT, BARE[import_path])
    if import_path.startswith('.'):
        base = os.path.dirname(from_file)
        return os.path.normpath(os.path.join(base, import_path))
    return None  # unknown bare import


def main():
    js_files = []
    for dirpath, _dirs, files in os.walk(os.path.join(PUBLIC, 'app')):
        for f in files:
            if f.endswith('.js'):
                js_files.append(os.path.join(dirpath, f))
    # include the worker (loaded separately) — it uses importScripts, not import,
    # so it has no ES imports to check; skip named-export checks for it.

    problems = []
    for jf in js_files:
        src = open(jf, encoding='utf-8').read()
        for m in IMPORT_RE.finditer(src):
            ipath = m.group('path')
            target = resolve(ipath, jf)
            rel_from = os.path.relpath(jf, ROOT)
            if target is None:
                problems.append(f'{rel_from}: unknown bare import "{ipath}"')
                continue
            if not os.path.isfile(target):
                problems.append(f'{rel_from}: import "{ipath}" -> missing file {os.path.relpath(target, ROOT)}')
                continue
            named = m.group('named')
            if named:
                exp = exports_of(target)
                if exp is None:
                    continue  # vendored bundle -> assume ok
                for part in named.split(','):
                    part = part.strip()
                    if not part:
                        continue
                    name = part.split(' as ')[0].strip()
                    if name and name not in exp:
                        problems.append(
                            f'{rel_from}: imports {{{name}}} from "{ipath}" but it is not exported there')

    if problems:
        print('MODULE GRAPH PROBLEMS:')
        for p in problems:
            print('  !', p)
        sys.exit(1)
    print(f'OK: checked {len(js_files)} JS modules — all imports resolve and all named imports exist.')


if __name__ == '__main__':
    main()
