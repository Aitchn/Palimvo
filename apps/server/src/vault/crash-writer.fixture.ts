// Child process for crash.test.ts: rewrites one file over and over with large, self-checking
// content until it is killed.
import { atomicWrite } from "./atomic.ts";

const target = process.argv[2]!;
const size = 256 * 1024;

for (let n = 1; ; n++) {
  const body = `${n}:${"x".repeat(size)}:${n}`;
  await atomicWrite(target, body);
  if (n === 1) process.stdout.write("ready\n");
}
