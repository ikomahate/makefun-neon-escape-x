import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(repository, 'main.ts');
const publishedPost = readFileSync(join(repository, 'POST.json'));
const validUrl = JSON.parse(publishedPost.toString('utf8')).url;
const validPost = JSON.stringify({ url: validUrl });
const previousOutput = Buffer.from('{"previous":"keep on failure"}\n');

function fixture(t, input = validPost) {
  const root = mkdtempSync(join(tmpdir(), 'makefun-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bot = join(root, 'bot');
  const output = join(root, 'output');
  mkdirSync(bot);
  if (input !== null) writeFileSync(join(bot, 'POST.json'), input);
  return { root, bot, output, destination: join(output, 'POST.json') };
}

function run(f, overrides = {}) {
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: f.root,
    env: {
      ...process.env,
      MAKEFUN_BOT_DIR: f.bot,
      MAKEFUN_OUTPUT_DIR: f.output,
      ...overrides,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function expectSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'success must be silent');
  assert.equal(result.stderr, '', 'success must have no diagnostics');
}

function expectFailure(result, diagnostic) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^makefun: /);
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'errors should not print a stack trace');
}

test('published POST.json survives two runs byte for byte', (t) => {
  const f = fixture(t, publishedPost);
  const first = run(f);
  expectSuccess(first);
  const firstOutput = readFileSync(f.destination);
  expectSuccess(run(f));
  assert.deepEqual(readFileSync(f.destination), publishedPost);
  assert.deepEqual(firstOutput, publishedPost);
  assert.deepEqual(readFileSync(join(f.bot, 'POST.json')), publishedPost);
  assert.deepEqual(readFileSync(join(repository, 'POST.json')), publishedPost);
  assert.deepEqual(readdirSync(f.output), ['POST.json']);
});

const acceptedUrls = [
  'https://x.com/test_user/status/123',
  'https://twitter.com/test_user/status/123',
  'https://www.x.com/test_user/status/123',
  'https://mobile.x.com/test_user/status/123',
  'https://www.twitter.com/test_user/status/123',
  'https://mobile.twitter.com/test_user/status/123',
  'https://x.com/i/web/status/123',
  'https://mobile.twitter.com/i/web/status/123?source=share#video',
  'https://x.com/test_user/status/123?s=20&t=abc#video',
];
for (const url of acceptedUrls) {
  test(`accepts documented address: ${url}`, (t) => {
    const input = JSON.stringify({ url, note: 'Preserve Unicode: café 🎮' }, null, 2) + '\r\n';
    const f = fixture(t, input);
    expectSuccess(run(f));
    assert.deepEqual(readFileSync(f.destination), Buffer.from(input));
  });
}

test('creates nested output directories and resolves relative overrides', (t) => {
  const f = fixture(t);
  expectSuccess(run(f, { MAKEFUN_BOT_DIR: 'bot', MAKEFUN_OUTPUT_DIR: 'nested/output' }));
  assert.equal(readFileSync(join(f.root, 'nested', 'output', 'POST.json'), 'utf8'), validPost);
});

test('supports the same input and output directory', (t) => {
  const f = fixture(t, publishedPost);
  expectSuccess(run(f, { MAKEFUN_OUTPUT_DIR: f.bot }));
  assert.deepEqual(readFileSync(join(f.bot, 'POST.json')), publishedPost);
});

function sizedPost(size) {
  const prefix = JSON.stringify({ url: validUrl, note: 'é🎮' });
  return prefix + ' '.repeat(size - Buffer.byteLength(prefix));
}

test('accepts exactly 16384 UTF-8 bytes', (t) => {
  const input = sizedPost(16_384);
  const f = fixture(t, input);
  expectSuccess(run(f));
  assert.equal(readFileSync(f.destination).length, 16_384);
});

const rejectedInputs = [
  ['empty file', '', /valid JSON/],
  ['malformed JSON', '{"url":', /valid JSON/],
  ['trailing garbage', validPost + 'oops', /valid JSON/],
  ['array', '[]', /JSON object/],
  ['null', 'null', /JSON object/],
  ['number', '123', /JSON object/],
  ['boolean', 'true', /JSON object/],
  ['string', '"text"', /JSON object/],
  ['missing url', '{}', /string "url"/],
  ['numeric url', '{"url":123}', /string "url"/],
  ['null url', '{"url":null}', /string "url"/],
  ['oversize file', sizedPost(16_385), /limit is 16384/],
  ['invalid UTF-8 in metadata', Buffer.concat([
    Buffer.from('{"url":' + JSON.stringify(validUrl) + ',"note":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]), /UTF-8/],
];

for (const [name, input, diagnostic] of rejectedInputs) {
  test(`rejects ${name} and preserves previous output`, (t) => {
    const f = fixture(t, input);
    mkdirSync(f.output);
    writeFileSync(f.destination, previousOutput);
    expectFailure(run(f), diagnostic);
    assert.deepEqual(readFileSync(f.destination), previousOutput);
    assert.deepEqual(readdirSync(f.output), ['POST.json']);
  });
}

const rejectedUrls = [
  '',
  'http://x.com/user/status/123',
  'https://example.com/user/status/123',
  'https://x.com.evil.example/user/status/123',
  'https://x.com@evil.example/user/status/123',
  'https://user:password@x.com/user/status/123',
  'https://x.com:443/user/status/123',
  'https://x.com/user',
  'https://x.com/user/status/not-an-id',
  'https://x.com/user/status/123/more',
  'https://x.com/user/status/123\n',
  ' https://x.com/user/status/123',
  'https://x.com/user/status/123?query=has space',
  'https://x.com/<handle>/status/<id>',
];
for (const url of rejectedUrls) {
  test(`rejects invalid address: ${JSON.stringify(url)}`, (t) => {
    const f = fixture(t, JSON.stringify({ url }));
    expectFailure(run(f), /HTTPS X\/Twitter post address/);
    assert.equal(existsSync(f.output), false, 'validation must happen before creating output');
  });
}

test('reports a missing input with its path', (t) => {
  const f = fixture(t, null);
  const result = run(f);
  expectFailure(result, /Cannot read input.*POST\.json/);
  assert.equal(existsSync(f.output), false);
});

test('reports an input path that is a directory', (t) => {
  const f = fixture(t, null);
  mkdirSync(join(f.bot, 'POST.json'));
  expectFailure(run(f), /Cannot read input/);
  assert.equal(existsSync(f.output), false);
});

test('reports output-directory creation failures', (t) => {
  const f = fixture(t);
  writeFileSync(f.output, 'blocking file');
  expectFailure(run(f), /Cannot write output/);
  assert.equal(readFileSync(f.output, 'utf8'), 'blocking file');
});

test('reports output-file write failures', (t) => {
  const f = fixture(t);
  mkdirSync(f.destination, { recursive: true });
  expectFailure(run(f), /Cannot write output/);
  assert.deepEqual(readdirSync(f.destination), []);
});

for (const name of ['MAKEFUN_BOT_DIR', 'MAKEFUN_OUTPUT_DIR']) {
  test(`rejects blank ${name}`, (t) => {
    const f = fixture(t);
    expectFailure(run(f, { [name]: '   ' }), new RegExp(`${name}.*cannot be empty`));
    assert.equal(existsSync(f.output), false);
  });
}
