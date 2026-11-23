import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_POST_BYTES = 16_384;
// Match the address forms listed in RULES.txt without rewriting the submitted URL.
const POST_ADDRESS = /^https:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/(?:[a-z0-9_]+\/status|i\/web\/status)\/[0-9]+(?:[?#][^\s]*)?$/i;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directory(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (value.trim().length === 0) {
    throw new Error(`${name} must name a directory; it cannot be empty.`);
  }
  return resolve(value);
}

function readPost(filename: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filename);
  } catch (error) {
    throw new Error(`Cannot read input ${JSON.stringify(filename)}: ${detail(error)}`);
  }

  if (bytes.length > MAX_POST_BYTES) {
    throw new Error(`Input POST.json is ${bytes.length} bytes; the limit is ${MAX_POST_BYTES}.`);
  }

  // Buffer.toString replaces malformed byte sequences, which could validate data
  // different from the bytes we publish. Reject encoding errors before parsing.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Input POST.json must be valid UTF-8; malformed byte sequences are not allowed.');
  }

  let post: unknown;
  try {
    post = JSON.parse(text);
  } catch (error) {
    throw new Error(`Input POST.json must contain valid JSON: ${detail(error)}`);
  }

  if (post === null || typeof post !== 'object' || Array.isArray(post)) {
    throw new Error('Input POST.json must be a JSON object.');
  }
  if (!('url' in post) || typeof post.url !== 'string') {
    throw new Error('Input POST.json must have a string "url" field.');
  }
  if (!POST_ADDRESS.test(post.url)) {
    throw new Error(
      'Input POST.json "url" must be an HTTPS X/Twitter post address with a numeric status ID ' +
      '(for example https://x.com/handle/status/123); www., mobile. and /i/web/status/ are supported.',
    );
  }

  // Retain formatting, extra fields, query strings and the exact published address.
  return bytes;
}

function run(): void {
  const source = join(directory('MAKEFUN_BOT_DIR', '/bot'), 'POST.json');
  const outputDirectory = directory('MAKEFUN_OUTPUT_DIR', '/output');
  const bytes = readPost(source);

  try {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'POST.json'), bytes);
  } catch (error) {
    throw new Error(`Cannot write output in ${JSON.stringify(outputDirectory)}: ${detail(error)}`);
  }
}

try {
  run();
} catch (error) {
  console.error(`makefun: ${detail(error)}`);
  process.exitCode = 1;
}
