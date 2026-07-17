import { appendFileSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const encodedName = encodeURIComponent(pkg.name);
const response = await fetch(`https://registry.npmjs.org/${encodedName}/${pkg.version}`, {
  headers: { Accept: "application/json" },
});

let shouldPublish;
if (response.status === 404) shouldPublish = true;
else if (response.ok) shouldPublish = false;
else throw new Error(`npm registry returned HTTP ${response.status}`);

const output = `should_publish=${shouldPublish}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
else process.stdout.write(output);
