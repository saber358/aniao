import { describe, expect, it } from "vitest";
import { PtyService } from "../src/main/pty-service.ts";
import type { TerminalEvent } from "../src/shared/terminal.ts";

describe("pty service", () => {
	it("spawns a shell and returns command output", async () => {
		const service = new PtyService();
		const events: TerminalEvent[] = [];
		const session = await service.create({ cwd: process.cwd(), cols: 80, rows: 24 }, (event) => events.push(event));
		try {
			service.write({ id: session.id, data: "echo PTY_TEST\r" });
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (events.some((event) => event.type === "data" && event.data.includes("PTY_TEST"))) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(events).toContainEqual(expect.objectContaining({ type: "data", id: session.id }));
			expect(
				events.some((event) => event.type === "data" && event.data.includes("PTY_TEST")),
				"missing shell output",
			).toBe(true);
		} finally {
			service.close({ id: session.id });
		}
	}, 20_000);
});
