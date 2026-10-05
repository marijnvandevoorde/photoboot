import { build } from 'vite';

// The server serves ./dist, so build it once before the e2e run.
export default async function setup() {
  await build({ logLevel: 'warn' });
}
