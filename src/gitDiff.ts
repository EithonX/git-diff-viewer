import { execFile } from "child_process";

export type DiffMode = "all" | "staged" | "unstaged";

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
