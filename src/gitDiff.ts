import { execFile } from "child_process";
import * as path from "path";

export type DiffMode = "all" | "staged" | "unstaged";

export type ChangedFile = {
    path: string;
    status: string;
    kind: "tracked" | "untracked";
};

type GitCommandOptions = {
    allowExitCodes?: number[];
};

type GitCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

const MAX_GIT_BUFFER = 50 * 1024 * 1024;

export class GitCommandError extends Error {
    constructor(
        readonly args: string[],
        readonly stdout: string,
        readonly stderr: string,
        readonly exitCode: number,
        message: string
    ) {
        super(message);
        this.name = "GitCommandError";
    }
}

export function isGitCommandError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
}

export async function ensureGitRepository(cwd: string): Promise<void> {
    await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
}

export async function loadDiffText(mode: DiffMode, cwd: string): Promise<string> {
    switch (mode) {
        case "staged":
            return loadStagedDiff(cwd);
        case "unstaged":
            return loadUnstagedDiff(cwd);
        case "all":
        default:
            return loadAllDiff(cwd);
    }
}

async function loadStagedDiff(cwd: string): Promise<string> {
    const result = await runGit(
        ["diff", "--cached", "--no-ext-diff", "--no-color"],
        cwd
    );
    return result.stdout;
}

async function loadUnstagedDiff(cwd: string): Promise<string> {
    const result = await runGit(
        ["diff", "--no-ext-diff", "--no-color"],
        cwd
    );
    return result.stdout;
}

async function loadAllDiff(cwd: string): Promise<string> {
    let trackedDiff = "";
    try {
        const result = await runGit(
            ["diff", "--no-ext-diff", "--no-color", "HEAD"],
            cwd
        );
        trackedDiff = result.stdout;
    } catch (error) {
        if (!isMissingHeadError(error)) {
            throw error;
        }
        trackedDiff = joinDiffChunks([
            await loadStagedDiff(cwd),
            await loadUnstagedDiff(cwd),
        ]);
    }

    const untrackedDiff = await loadUntrackedDiff(cwd);
    return joinDiffChunks([trackedDiff, untrackedDiff]);
}

async function loadUntrackedDiff(cwd: string): Promise<string> {
    const { stdout } = await runGit(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        cwd
    );

    const files = stdout.split("\0").filter((file) => file.length > 0);
    if (files.length === 0) {
        return "";
    }

    const diffChunks: string[] = [];
    for (const file of files) {
        try {
            const diffResult = await runGit(
                ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", file],
                cwd,
                { allowExitCodes: [1] }
            );
            diffChunks.push(diffResult.stdout);
        } catch (error) {
            if (isMissingUntrackedFileError(error)) {
                continue;
            }
            throw error;
        }
    }

    return joinDiffChunks(diffChunks);
}

function parseNameStatus(stdout: string, kind: "tracked" | "untracked"): ChangedFile[] {
    const parts = stdout.split("\0");
    const files: ChangedFile[] = [];
    let i = 0;
    while (i < parts.length) {
        const statusVal = parts[i];
        if (!statusVal) {
            i++;
            continue;
        }
        if (statusVal.startsWith("R") || statusVal.startsWith("C")) {
            const newPath = parts[i + 2];
            if (newPath !== undefined) {
                files.push({
                    path: newPath,
                    status: statusVal[0],
                    kind
                });
            }
            i += 3;
        } else {
            const filePath = parts[i + 1];
            if (filePath !== undefined) {
                files.push({
                    path: filePath,
                    status: statusVal[0],
                    kind
                });
            }
            i += 2;
        }
    }
    return files;
}

async function runNameStatus(args: string[], cwd: string, kind: "tracked" | "untracked"): Promise<ChangedFile[]> {
    const { stdout } = await runGit(args, cwd);
    return parseNameStatus(stdout, kind);
}

export async function loadChangedFiles(mode: DiffMode, cwd: string): Promise<ChangedFile[]> {
    if (mode === "staged") {
        return runNameStatus(["diff", "--cached", "--name-status", "-z"], cwd, "tracked");
    } else if (mode === "unstaged") {
        return runNameStatus(["diff", "--name-status", "-z"], cwd, "tracked");
    } else {
        let trackedFiles: ChangedFile[] = [];
        try {
            trackedFiles = await runNameStatus(["diff", "--name-status", "-z", "HEAD"], cwd, "tracked");
        } catch (error) {
            if (!isMissingHeadError(error)) {
                throw error;
            }
            const staged = await runNameStatus(["diff", "--cached", "--name-status", "-z"], cwd, "tracked");
            const unstaged = await runNameStatus(["diff", "--name-status", "-z"], cwd, "tracked");
            trackedFiles = [...staged, ...unstaged];
        }

        const { stdout: untrackedStdout } = await runGit(
            ["ls-files", "--others", "--exclude-standard", "-z"],
            cwd
        );
        const untrackedPaths = untrackedStdout.split("\0").filter(p => p.length > 0);
        const untrackedFiles: ChangedFile[] = untrackedPaths.map(filePath => ({
            path: filePath,
            status: "?",
            kind: "untracked"
        }));

        const allFiles = [...trackedFiles, ...untrackedFiles];
        const seen = new Set<string>();
        const uniqueFiles: ChangedFile[] = [];
        for (const file of allFiles) {
            if (!seen.has(file.path)) {
                seen.add(file.path);
                uniqueFiles.push(file);
            }
        }
        return uniqueFiles;
    }
}

export async function loadDiffForPaths(mode: DiffMode, cwd: string, files: ChangedFile[]): Promise<string> {
    if (files.length === 0) {
        return "";
    }

    const paths = files.map(f => f.path);

    if (mode === "staged") {
        const result = await runGit(
            ["diff", "--cached", "--no-ext-diff", "--no-color", "--", ...paths],
            cwd
        );
        return result.stdout;
    }

    if (mode === "unstaged") {
        const result = await runGit(
            ["diff", "--no-ext-diff", "--no-color", "--", ...paths],
            cwd
        );
        return result.stdout;
    }

    const trackedFiles = files.filter(f => f.kind === "tracked");
    const untrackedFiles = files.filter(f => f.kind === "untracked");

    let trackedDiff = "";
    if (trackedFiles.length > 0) {
        const trackedPaths = trackedFiles.map(f => f.path);
        try {
            const result = await runGit(
                ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", ...trackedPaths],
                cwd
            );
            trackedDiff = result.stdout;
        } catch (error) {
            if (!isMissingHeadError(error)) {
                throw error;
            }
            const stagedResult = await runGit(
                ["diff", "--cached", "--no-ext-diff", "--no-color", "--", ...trackedPaths],
                cwd
            );
            const unstagedResult = await runGit(
                ["diff", "--no-ext-diff", "--no-color", "--", ...trackedPaths],
                cwd
            );
            trackedDiff = joinDiffChunks([stagedResult.stdout, unstagedResult.stdout]);
        }
    }

    const untrackedDiffChunks: string[] = [];
    for (const file of untrackedFiles) {
        try {
            const diffResult = await runGit(
                ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", file.path],
                cwd,
                { allowExitCodes: [1] }
            );
            untrackedDiffChunks.push(diffResult.stdout);
        } catch (error) {
            if (isMissingUntrackedFileError(error)) {
                continue;
            }
            throw error;
        }
    }
    const untrackedDiff = joinDiffChunks(untrackedDiffChunks);

    return joinDiffChunks([trackedDiff, untrackedDiff]);
}

function toRepoRelativePath(cwd: string, absoluteFilePath: string): string {
    const resolvedCwd = path.resolve(cwd);
    const resolvedFile = path.resolve(absoluteFilePath);
    const relativePath = path.relative(resolvedCwd, resolvedFile);

    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("File is outside the repository workspace.");
    }

    return relativePath.replace(/\\/g, "/");
}

export async function loadCurrentFileDiff(mode: DiffMode, cwd: string, absoluteFilePath: string): Promise<string> {
    const relativePath = toRepoRelativePath(cwd, absoluteFilePath);

    const { stdout: untrackedStdout } = await runGit(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", relativePath],
        cwd
    );
    const isUntracked = untrackedStdout.split("\0").filter(p => p.length > 0).length > 0;

    if (mode === "all") {
        if (isUntracked) {
            const result = await runGit(
                ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", relativePath],
                cwd,
                { allowExitCodes: [1] }
            );
            return result.stdout;
        } else {
            try {
                const result = await runGit(
                    ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", relativePath],
                    cwd
                );
                return result.stdout;
            } catch (error) {
                if (!isMissingHeadError(error)) {
                    throw error;
                }
                const stagedResult = await runGit(
                    ["diff", "--cached", "--no-ext-diff", "--no-color", "--", relativePath],
                    cwd
                );
                const unstagedResult = await runGit(
                    ["diff", "--no-ext-diff", "--no-color", "--", relativePath],
                    cwd
                );
                return joinDiffChunks([stagedResult.stdout, unstagedResult.stdout]);
            }
        }
    }

    if (mode === "staged") {
        const result = await runGit(
            ["diff", "--cached", "--no-ext-diff", "--no-color", "--", relativePath],
            cwd
        );
        return result.stdout;
    }

    if (mode === "unstaged") {
        const result = await runGit(
            ["diff", "--no-ext-diff", "--no-color", "--", relativePath],
            cwd
        );
        return result.stdout;
    }

    return "";
}

function joinDiffChunks(chunks: string[]): string {
    const nonEmptyChunks = chunks.filter((chunk) => chunk.length > 0);
    if (nonEmptyChunks.length === 0) {
        return "";
    }

    let combined = nonEmptyChunks[0];
    for (const chunk of nonEmptyChunks.slice(1)) {
        if (!combined.endsWith("\n") && !chunk.startsWith("\n")) {
            combined += "\n";
        }
        combined += chunk;
    }

    return combined;
}

function runGit(
    args: string[],
    cwd: string,
    options: GitCommandOptions = {}
): Promise<GitCommandResult> {
    const allowedExitCodes = new Set(options.allowExitCodes ?? []);

    return new Promise((resolve, reject) => {
        execFile(
            "git",
            args,
            {
                cwd,
                maxBuffer: MAX_GIT_BUFFER,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                const exitCode =
                    typeof error?.code === "number"
                        ? error.code
                        : error
                            ? 1
                            : 0;

                if (error && !allowedExitCodes.has(exitCode)) {
                    reject(
                        new GitCommandError(
                            args,
                            stdout,
                            stderr,
                            exitCode,
                            stderr.trim() || error.message
                        )
                    );
                    return;
                }

                resolve({
                    stdout,
                    stderr,
                    exitCode,
                });
            }
        );
    });
}

function isMissingHeadError(error: unknown): boolean {
    if (!isGitCommandError(error)) {
        return false;
    }

    const message = `${error.stderr}\n${error.message}`.toLowerCase();
    return message.includes("ambiguous argument 'head'")
        || message.includes("bad revision 'head'")
        || message.includes("unknown revision or path not in the working tree");
}

function isMissingUntrackedFileError(error: unknown): boolean {
    if (!isGitCommandError(error)) {
        return false;
    }

    const message = `${error.stderr}\n${error.message}`.toLowerCase();
    return message.includes("could not access")
        || message.includes("no such file or directory");
}

export function toFriendlyError(error: unknown): string {
    if (isGitCommandError(error)) {
        const message = `${error.stderr}\n${error.message}`.toLowerCase();

        if (message.includes("not a git repository")) {
            return "Selected folder is not a Git repository.";
        }

        if (message.includes("spawn git") && message.includes("enoent")) {
            return "Git executable not found in PATH.";
        }

        return error.stderr.trim() || error.message;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return "Unknown error while loading diff.";
}
