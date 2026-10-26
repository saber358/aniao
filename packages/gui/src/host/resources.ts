import { basename } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
	ResourceCommand,
	ResourceDiagnostic,
	ResourceExtension,
	ResourcePrompt,
	ResourceSkill,
	ResourceSnapshot,
} from "../shared/resources.ts";

const MAX_COMMANDS = 1000;
const MAX_DIAGNOSTICS = 500;

/*
 * ========================================================================
 * 步骤1：把宿主资源压缩成只读管理快照
 * ========================================================================
 * 数据源：SDK 已加载的扩展、技能、模板和命令注册表。
 * 操作：
 *   1) 只保留路径、来源、能力和诊断，不携带扩展函数或凭据
 *   2) 命令与诊断去重并限制数量，避免大仓库把所有项目资源带入快照
 */
export function buildResources(session: AgentSession): ResourceSnapshot {
	const loader = session.resourceLoader;
	const loadedExtensions = loader.getExtensions();
	const commands: ResourceCommand[] = [];
	const seen = new Set<string>();
	const addCommand = (command: ResourceCommand) => {
		const key = `${command.source}:${command.name}`;
		if (seen.has(key) || commands.length >= MAX_COMMANDS) return;
		seen.add(key);
		commands.push(command);
	};

	const extensions: ResourceExtension[] = loadedExtensions.extensions.slice(0, 200).map((extension) => {
		const source = sourceInfo(extension.sourceInfo);
		return {
			name: clip(basename(extension.path) || extension.path, 512),
			path: clip(extension.path, 4096),
			source: clip(source.source, 512),
			scope: source.scope,
			tools: [...extension.tools.keys()].slice(0, 200).map((tool) => clip(tool, 512)),
			commands: [...extension.commands.keys()].slice(0, 200).map((command) => clip(command, 512)),
		};
	});

	try {
		for (const command of session.extensionRunner.getRegisteredCommands()) {
			const source = sourceInfo(command.sourceInfo);
			addCommand({
				name: clip(command.invocationName, 512),
				...(command.description ? { description: clip(command.description, 8192) } : {}),
				source: "extension",
				scope: source.scope,
				path: source.path ? clip(source.path, 4096) : undefined,
			});
		}
	} catch {
		// 扩展尚未完成绑定时仍可展示已加载的技能与模板。
	}

	const skillResult = loader.getSkills();
	const skills: ResourceSkill[] = skillResult.skills.slice(0, 500).map((skill) => {
		const source = sourceInfo(skill.sourceInfo);
		addCommand({
			name: clip(`skill:${skill.name}`, 512),
			description: clip(skill.description, 8192),
			source: "skill",
			scope: source.scope,
			path: clip(skill.filePath, 4096),
		});
		return {
			name: clip(skill.name, 512),
			description: clip(skill.description, 8192),
			path: clip(skill.filePath, 4096),
			source: clip(source.source, 512),
			scope: source.scope,
			disableModelInvocation: skill.disableModelInvocation,
		};
	});

	const promptResult = loader.getPrompts();
	const prompts: ResourcePrompt[] = promptResult.prompts.slice(0, 500).map((prompt) => {
		const source = sourceInfo(prompt.sourceInfo);
		addCommand({
			name: clip(prompt.name, 512),
			description: clip(prompt.description, 8192),
			source: "prompt",
			scope: source.scope,
			path: clip(prompt.filePath, 4096),
		});
		return {
			name: clip(prompt.name, 512),
			description: clip(prompt.description, 8192),
			...(prompt.argumentHint ? { argumentHint: clip(prompt.argumentHint, 512) } : {}),
			path: clip(prompt.filePath, 4096),
			source: clip(source.source, 512),
			scope: source.scope,
		};
	});

	const diagnostics: ResourceDiagnostic[] = [];
	const addDiagnostic = (diagnostic: ResourceDiagnostic) => {
		if (diagnostics.length >= MAX_DIAGNOSTICS) return;
		diagnostics.push(diagnostic);
	};
	for (const error of loadedExtensions.errors)
		addDiagnostic({
			type: "error",
			message: clip(error.error, 8192),
			path: clip(error.path, 4096),
		});
	for (const diagnostic of [...skillResult.diagnostics, ...promptResult.diagnostics])
		addDiagnostic({
			type: diagnostic.type,
			message: clip(diagnostic.message, 8192),
			...(diagnostic.path ? { path: clip(diagnostic.path, 4096) } : {}),
		});

	return { extensions, skills, prompts, commands, diagnostics };
}

function sourceInfo(info: { source?: string; scope?: string; path?: string } | undefined): {
	source: string;
	scope: ResourceExtension["scope"];
	path: string;
} {
	const scope = info?.scope;
	return {
		source: info?.source ?? "local",
		scope: scope === "user" || scope === "project" || scope === "temporary" ? scope : "unknown",
		path: info?.path ?? "",
	};
}

function clip(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}
