import vscode from "vscode";

import childProcess from "child_process";
import fs from "fs";
import path from "path";
import util from "util";

import { getWorkspaceFolder, isWorkspaceFile } from "./zigUtil";
import { zigProvider } from "./zigSetup";

const execFile = util.promisify(childProcess.execFile);

export default class ZigMainCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();

        const mainRegex = /pub\s+fn\s+main\s*\(/g;
        let match;
        while ((match = mainRegex.exec(text))) {
            const position = document.positionAt(match.index);
            const range = new vscode.Range(position, position);
            codeLenses.push(
                new vscode.CodeLens(range, { title: "Run", command: "zig.run", arguments: [document.uri.fsPath] }),
            );
            codeLenses.push(
                new vscode.CodeLens(range, { title: "Debug", command: "zig.debug", arguments: [document.uri.fsPath] }),
            );
        }
        return codeLenses;
    }

    public static registerCommands(context: vscode.ExtensionContext) {
        context.subscriptions.push(
            vscode.commands.registerCommand("zig.run", zigRun),
            vscode.commands.registerCommand("zig.debug", zigDebug),
        );
    }
}

function zigRun() {
    if (!vscode.window.activeTextEditor) return;
    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return;
    const filePath = vscode.window.activeTextEditor.document.uri.fsPath;
    const terminal = vscode.window.createTerminal("Run Zig Program");
    const callOperator = /(powershell.exe$|powershell$|pwsh.exe$|pwsh$)/.test(vscode.env.shell) ? "& " : "";
    terminal.show();
    const wsFolder = getWorkspaceFolder(filePath);
    if (wsFolder && isWorkspaceFile(filePath) && hasBuildFile(wsFolder.uri.fsPath)) {
        terminal.sendText(`${callOperator}${escapePath(zigPath)} build run`);
        return;
    }
    terminal.sendText(`${callOperator}${escapePath(zigPath)} run ${escapePath(filePath)}`);
}

function escapePath(rawPath: string): string {
    if (/[ !"#$&'()*,;:<>?\[\\\]^`{|}]/.test(rawPath)) {
        return `"${rawPath.replaceAll('"', '"\\""')}"`;
    }
    return rawPath;
}

function hasBuildFile(workspaceFspath: string): boolean {
    const buildZigPath = path.join(workspaceFspath, "build.zig");
    return fs.existsSync(buildZigPath);
}

async function zigDebug() {
    if (!vscode.window.activeTextEditor) return;
    const filePath = vscode.window.activeTextEditor.document.uri.fsPath;
    try {
        const workspaceFolder = getWorkspaceFolder(filePath);
        let binaryPath;
        if (workspaceFolder && isWorkspaceFile(filePath) && hasBuildFile(workspaceFolder.uri.fsPath)) {
            binaryPath = await buildDebugBinaryWithBuildFile(workspaceFolder.uri.fsPath);
        } else {
            binaryPath = await buildDebugBinary(filePath);
        }
        if (!binaryPath) return;

        const debugConfig: vscode.DebugConfiguration = {
            type: "lldb",
            name: `Debug Zig`,
            request: "launch",
            program: binaryPath,
            cwd: path.dirname(workspaceFolder?.uri.fsPath ?? path.dirname(filePath)),
            stopAtEntry: false,
        };
        await vscode.debug.startDebugging(undefined, debugConfig);
    } catch (e) {
        void vscode.window.showErrorMessage(`Failed to build debug binary: ${(e as Error).message}`);
    }
}

async function buildDebugBinaryWithBuildFile(workspacePath: string): Promise<string | null> {
    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return null;
    // Workaround because zig build doesn't support specifying the output binary name
    // `zig run` does support -femit-bin, but preferring `zig build` if possible
    const outputDir = path.join(workspacePath, "zig-out", "tmp-debug-build");
    await execFile(zigPath, ["build", "--prefix", outputDir], { cwd: workspacePath });
    const dirFiles = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(outputDir, "bin")));
    const files = dirFiles.find(([, type]) => type === vscode.FileType.File);
    if (!files) {
        throw new Error("Unable to build debug binary");
    }
    return path.join(outputDir, "bin", files[0]);
}

async function buildDebugBinary(filePath: string): Promise<string | null> {
    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return null;
    const fileDirectory = path.dirname(filePath);
    const binaryName = `debug-${path.basename(filePath, ".zig")}`;
    const binaryPath = path.join(fileDirectory, "zig-out", "bin", binaryName);
    void vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(binaryPath)));

    await execFile(zigPath, ["run", filePath, `-femit-bin=${binaryPath}`], { cwd: fileDirectory });
    return binaryPath;
}
