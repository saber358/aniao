// 文件选择只传会话身份；实际目录和绝对路径由桌面持有。
export const PROJECT_FILE_LIMIT = 20;
export const PROJECT_PATH_LIMIT = 4096;
export const PROJECT_QUERY_LIMIT = 200;

export interface ProjectFileSelection {
	sessionId: string;
	generation: string;
}

export interface ProjectFileSearch extends ProjectFileSelection {
	query: string;
}

export interface ProjectFileMatches {
	paths: string[];
	incomplete: boolean;
}

export interface ProjectFileReference extends ProjectFileSelection {
	paths: string[];
}

export interface ProjectFilesPort {
	selectProjectFiles(selection: ProjectFileSelection): Promise<string[]>;
	searchProjectFiles(input: ProjectFileSearch): Promise<ProjectFileMatches>;
	validateProjectFiles(input: ProjectFileReference): Promise<string[]>;
}
