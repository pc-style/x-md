import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compile the actual site tokens into plain CSS; no second palette to maintain.
await mkdir(new URL('./assets/', import.meta.url), { recursive: true });
const tokens = await readFile(new URL('../../src/tokens.css', import.meta.url), 'utf8');
await writeFile(new URL('./assets/brand.css', import.meta.url), tokens.replace('@theme', ':root'));
await copyFile(new URL('../../node_modules/gsap/dist/gsap.min.js', import.meta.url), new URL('./assets/gsap.min.js', import.meta.url));

// User-selected local track: Silo — meaningful love (instrumental).
// Start on the measured main drop (video/launch/src/beats.ts), after the spoken tag.
// Preserve the recording's pitch and tempo; leave headroom and fade the final beat.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-ss', '6.748', '-i', fileURLToPath(new URL('../audio-src.mp3', import.meta.url)),
  '-t', '30', '-vn',
  '-af', 'volume=0.65,afade=t=in:d=0.025,afade=t=out:st=28.8:d=1.2',
  '-ar', '48000', '-c:a', 'pcm_s16le',
  fileURLToPath(new URL('./assets/meaningful-love.wav', import.meta.url)),
], { stdio: 'inherit' });
console.log('Prepared site tokens, local GSAP, and 30-second Meaningful Love instrumental excerpt.');
