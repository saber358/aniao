import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiKey = process.env.ANIAO_DEFAULT_API_KEY?.trim();
if (!apiKey) {
	console.error("ANIAO_DEFAULT_API_KEY is required to build the default provider package");
	process.exit(1);
}
const template = JSON.parse(await readFile(join(root, "resources", "default-provider.json"), "utf8"));
const outputDirectory = join(root, "build");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
	join(outputDirectory, "default-provider.json"),
	`${JSON.stringify({ ...template, apiKey }, null, 2)}\n`,
	{ encoding: "utf8", mode: 0o600 },
);
console.log("Prepared default provider configuration");
