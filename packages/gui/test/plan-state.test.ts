import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SessionAdapter } from "../src/host/session-adapter.ts";
import type { Configuration } from "../src/shared/protocol.ts";

const logger = { info: () => {} };
const configuration: Configuration = {
	model: null,
	models: [],
	thinking: "off",
	thinkingLevels: ["off"],
};

function adapter(): { value: SessionAdapter; messages: AgentMessage[]; emit: (event: AgentSessionEvent) => void } {
	const messages: AgentMessage[] = [];
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		sessionId: "session-1",
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionName: () => null,
			getBranch: () => [],
			getEntries: () => [],
		},
		messages,
		isStreaming: false,
		getContextUsage: () => undefined,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		resourceLoader: {
			getExtensions: () => ({ extensions: [], errors: [] }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
		},
		extensionRunner: { getRegisteredCommands: () => [] },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			emit = listener;
			return () => {};
		},
	} as unknown as AgentSession;
	return {
		value: new SessionAdapter(session, configuration, logger, true),
		messages,
		emit: (event) => emit(event),
	};
}

describe("plan state", () => {
	it("transitions from drafting to awaiting and completed", () => {
		const { value, messages, emit } = adapter();
		expect(value.snapshot.plan?.phase).toBe("off");
		value.beginPlan();
		expect(value.snapshot.plan?.phase).toBe("drafting");

		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "1. Inspect the code\n2. Add tests" }],
		} as AgentMessage);
		emit({ type: "agent_settled" } as AgentSessionEvent);
		expect(value.snapshot.plan).toEqual({
			phase: "awaiting",
			text: "1. Inspect the code\n2. Add tests",
		});

		value.approvePlan("1. Inspect the code\n2. Add tests");
		expect(value.snapshot.plan?.phase).toBe("executing");
		emit({ type: "agent_settled" } as AgentSessionEvent);
		expect(value.snapshot.plan?.phase).toBe("completed");

		value.clearPlan();
		expect(value.snapshot.plan?.phase).toBe("off");
	});
});
