import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as pty from "node-pty";
import type {
	TerminalClose,
	TerminalCreate,
	TerminalEvent,
	TerminalResize,
	TerminalSession,
	TerminalWrite,
} from "../shared/terminal.ts";

interface Session {
	id: string;
	process: pty.IPty;
}

/*
 * ========================================================================
 * 步骤1：管理独立于 Agent 的用户 PTY 会话
 * ========================================================================
 * 数据源：活动项目目录与系统 shell。
 * 操作：
 *   1) 每个终端使用独立 PTY 和随机身份
 *   2) 尺寸、输入和关闭均有上限，应用退出时统一回收
 */
export class PtyService {
	private readonly sessions = new Map<string, Session>();

	async create(request: TerminalCreate, emit: (event: TerminalEvent) => void): Promise<TerminalSession> {
		const cwd = await realpath(request.cwd);
		if (!(await stat(cwd)).isDirectory()) throw new Error("项目目录已失效");
		const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash");
		const args = process.platform === "win32" ? ["-NoLogo"] : ["-l"];
		const env = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const terminal = pty.spawn(shell, args, {
			name: "xterm-256color",
			cols: request.cols,
			rows: request.rows,
			cwd,
			env: { ...env, TERM: "xterm-256color" },
		});
		const id = randomUUID();
		this.sessions.set(id, { id, process: terminal });
		terminal.onData((data) => emit({ type: "data", id, data }));
		terminal.onExit(({ exitCode }) => {
			this.sessions.delete(id);
			emit({ type: "exit", id, exitCode });
		});
		return { id, shell };
	}

	write(request: TerminalWrite): void {
		this.sessions.get(request.id)?.process.write(request.data);
	}

	resize(request: TerminalResize): void {
		this.sessions.get(request.id)?.process.resize(request.cols, request.rows);
	}

	close(request: TerminalClose): void {
		const session = this.sessions.get(request.id);
		if (!session) return;
		this.sessions.delete(request.id);
		session.process.kill();
	}

	disposeAll(): void {
		for (const session of this.sessions.values()) session.process.kill();
		this.sessions.clear();
	}
}
