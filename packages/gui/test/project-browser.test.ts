import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectBrowser } from "../src/main/project-browser.ts";

const browser = new ProjectBrowser();
const roots: string[] = [];

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-project-"));
	roots.push(root);
	await mkdir(join(root, "src"));
	await mkdir(join(root, ".git"));
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "README.md"), "readme\n");
	await writeFile(join(root, "src", "main.ts"), "export {};\n");
	await writeFile(join(root, ".git", "config"), "hidden\n");
	await writeFile(join(root, "node_modules", "package.json"), "{}\n");
	await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2]));
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project browser", () => {
	it("lists directories without repository internals", async () => {
		const root = await project();
		const listing = await browser.list({ cwd: root, path: "" });
		expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "image.bin", "README.md"]);
		expect(listing.entries.find((entry) => entry.name === "src")?.type).toBe("directory");
		const child = await browser.list({ cwd: root, path: "src" });
		expect(child.path).toBe("src");
		expect(child.entries[0]).toMatchObject({ name: "main.ts", type: "file" });
	});

	it("reads text files and reports binary files", async () => {
		const root = await project();
		expect(await browser.read({ cwd: root, path: "README.md" })).toMatchObject({
			path: "README.md",
			text: "readme\n",
			binary: false,
			truncated: false,
		});
		expect(await browser.read({ cwd: root, path: "image.bin" })).toMatchObject({
			binary: true,
			text: "",
		});
	});

	it("rejects paths outside the project", async () => {
		const root = await project();
		await expect(browser.list({ cwd: root, path: "../" })).rejects.toThrow();
		await expect(browser.read({ cwd: root, path: join(root, "README.md") })).rejects.toThrow();
	});
});
