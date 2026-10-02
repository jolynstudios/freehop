// Copies Freehop's own browser modules into static/lib/ so that the live call and the
// "what the gate sees" demo run the real client code, not a re-implementation.
// static/lib/ is generated (git-ignored) and refreshed before every start and build.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';

const repo = new URL('../../', import.meta.url);
const out = new URL('../static/lib/', import.meta.url);

await rm(out, { recursive: true, force: true });
await mkdir(new URL('client/', out), { recursive: true });
await mkdir(new URL('sdk/', out), { recursive: true });

const client = (await readdir(new URL('src/client/', repo))).filter(name => name.endsWith('.mjs'));
for (const name of client) await cp(new URL(`src/client/${name}`, repo), new URL(`client/${name}`, out));
for (const name of ['client.mjs', 'ticket.mjs']) await cp(new URL(`src/sdk/${name}`, repo), new URL(`sdk/${name}`, out));

console.log(`copy-lib: ${client.length} client modules + sdk/client.mjs, sdk/ticket.mjs -> static/lib/`);
