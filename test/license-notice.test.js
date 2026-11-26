// The copyright and license of the project are declared in one place each and agree:
// REUSE.toml for every file, LICENSES/ (REUSE) and LICENSE (GitHub) for the text,
// NOTICE for people, package.json for npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('REUSE.toml gives every file the copyright holder and AGPL-3.0-only', () => {
  const reuse = read('REUSE.toml');
  assert.match(reuse, /^version = 1$/m);
  assert.match(reuse, /^path = "\*\*"$/m);
  assert.match(reuse, /^SPDX-FileCopyrightText = "2026 Zackyanto /m);
  assert.match(reuse, /^SPDX-License-Identifier = "AGPL-3\.0-only"$/m);
});

test('the license text in LICENSES/ is the same as LICENSE', () => {
  assert.equal(read('LICENSES/AGPL-3.0-only.txt'), read('LICENSE'));
  assert.match(read('LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
});

test('NOTICE and package.json name the same holder and license', () => {
  const notice = read('NOTICE');
  assert.match(notice, /Copyright \(C\) 2026 Zackyanto/);
  assert.match(notice, /AGPL-3\.0-only/);
  assert.match(notice, /trademarks of Grafana Labs/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'AGPL-3.0-only');
  assert.equal(pkg.author.name, 'Zackyanto');
});
