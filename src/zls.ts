import vscode from "vscode";

import {
    CancellationToken,
    ConfigurationParams,
    DocumentSelector,
    LSPAny,
    LanguageClient,
    LanguageClientOptions,
    RequestHandler,
    ResponseError,
    ServerOptions,
} from "vscode-languageclient/node";
import axios from "axios";
import camelCase from "camelcase";
import semver from "semver";

import { downloadAndExtractArtifact, getHostZigName, getVersion, getZigPath, handleConfigOption } from "./zigUtil";
import { existsSync } from "fs";

const ZIG_MODE: DocumentSelector = [
    { language: "zig", scheme: "file" },
    { language: "zig", scheme: "untitled" },
];

let outputChannel: vscode.OutputChannel;
export let client: LanguageClient | null = null;

export async function restartClient(context: vscode.ExtensionContext): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    if (!configuration.get<string>("path") && configuration.get<"ask" | "off" | "on">("enabled", "ask") !== "on") {
        await stopClient();
        return;
    }

    const result = await getZLSPath(context);
    if (!result) return;

    try {
        const newClient = await startClient(result.exe);
        await stopClient();
        client = newClient;
    } catch (reason) {
        if (reason instanceof Error) {
            void vscode.window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason.message}`);
        } else {
            void vscode.window.showWarningMessage("Failed to run Zig Language Server (ZLS)");
        }
    }
}

async function startClient(zlsPath: string): Promise<LanguageClient> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: ZIG_MODE,
        outputChannel,
        middleware: {
            workspace: {
                configuration: configurationMiddleware,
            },
        },
    };

    const languageClient = new LanguageClient("zig.zls", "Zig Language Server", serverOptions, clientOptions);
    await languageClient.start();
    // Formatting is handled by `zigFormat.ts`
    languageClient.getFeature("textDocument/formatting").dispose();
    return languageClient;
}

async function stopClient(): Promise<void> {
    if (!client) return;
    // The `stop` call will send the "shutdown" notification to the LSP
    await client.stop();
    // The `dipose` call will send the "exit" request to the LSP which actually tells the child process to exit
    await client.dispose();
    client = null;
}

/** returns the file system path to the zls executable */
async function getZLSPath(context: vscode.ExtensionContext): Promise<{ exe: string; version: semver.SemVer } | null> {
    const configuration = vscode.workspace.getConfiguration("zig.zls");
    let zlsExePath = configuration.get<string>("path");
    let zlsVersion: semver.SemVer | null = null;

    if (!zlsExePath) {
        if (configuration.get<"ask" | "off" | "on">("enabled", "ask") !== "on") return null;

        let zigVersion: semver.SemVer | null;
        try {
            zigVersion = getVersion(getZigPath(), "version");
        } catch {
            return null;
        }
        if (!zigVersion) return null;

        const result = await fetchVersion(context, zigVersion, true);
        if (!result) return null;

        const isWindows = process.platform === "win32";
        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zls", result.version.raw);
        zlsExePath = vscode.Uri.joinPath(installDir, isWindows ? "zls.exe" : "zls").fsPath;
        zlsVersion = result.version;

        if (!existsSync(zlsExePath)) {
            try {
                await downloadAndExtractArtifact(
                    "ZLS",
                    "zls",
                    installDir,
                    result.artifact.tarball,
                    result.artifact.shasum,
                    [],
                );
            } catch {
                void vscode.window.showErrorMessage(`Failed to install ZLS ${result.version.toString()}!`);
                return null;
            }
        }
    }

    const checkedZLSVersion = getVersion(zlsExePath, "--version");
    if (!checkedZLSVersion) {
        void vscode.window.showErrorMessage(`Unable to check ZLS version. '${zlsExePath} --version' failed!`);
        return null;
    }
    if (zlsVersion && checkedZLSVersion.compare(zlsVersion) !== 0) {
        // The Matrix is broken!
        void vscode.window.showErrorMessage(
            `Encountered unexpected ZLS version. Expected '${zlsVersion.toString()}' from '${zlsExePath} --version' but got '${checkedZLSVersion.toString()}'!`,
        );
        return null;
    }

    return {
        exe: zlsExePath,
        version: checkedZLSVersion,
    };
}

async function configurationMiddleware(
    params: ConfigurationParams,
    token: CancellationToken,
    next: RequestHandler<ConfigurationParams, LSPAny[], void>,
): Promise<LSPAny[] | ResponseError> {
    const optionIndices: Record<string, number | undefined> = {};

    params.items.forEach((param, index) => {
        if (param.section) {
            if (param.section === "zls.zig_exe_path") {
                param.section = "zig.path";
            } else {
                param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
            }
            optionIndices[param.section] = index;
        }
    });

    const result = await next(params, token);
    if (result instanceof ResponseError) {
        return result;
    }

    const configuration = vscode.workspace.getConfiguration("zig.zls");

    for (const name in optionIndices) {
        const index = optionIndices[name] as unknown as number;
        const section = name.slice("zig.zls.".length);
        const configValue = configuration.get(section);
        if (typeof configValue === "string" && configValue) {
            result[index] = handleConfigOption(configValue);
        }
    }

    const indexOfZigPath = optionIndices["zig.path"];
    if (indexOfZigPath !== undefined) {
        try {
            result[indexOfZigPath] = getZigPath();
        } catch {
            // ZLS will try to find Zig by itself and likely fail as well.
            // This will cause two "Zig can't be found in $PATH" error messages to be reported.
            result[indexOfZigPath] = null;
        }
    }

    const additionalOptions = configuration.get<Record<string, unknown>>("additionalOptions", {});

    for (const optionName in additionalOptions) {
        const section = optionName.slice("zig.zls.".length);

        const doesOptionExist = configuration.inspect(section)?.defaultValue !== undefined;
        if (doesOptionExist) {
            // The extension has defined a config option with the given name but the user still used `additionalOptions`.
            const response = await vscode.window.showWarningMessage(
                `The config option 'zig.zls.additionalOptions' contains the already existing option '${optionName}'`,
                `Use ${optionName} instead`,
                "Show zig.zls.additionalOptions",
            );
            switch (response) {
                case `Use ${optionName} instead`:
                    const { [optionName]: newValue, ...updatedAdditionalOptions } = additionalOptions;
                    await configuration.update("additionalOptions", updatedAdditionalOptions, true);
                    await configuration.update(section, newValue, true);
                    break;
                case "Show zig.zls.additionalOptions":
                    await vscode.commands.executeCommand("workbench.action.openSettingsJson", {
                        revealSetting: { key: "zig.zls.additionalOptions" },
                    });
                    continue;
                case undefined:
                    continue;
            }
        }

        const optionIndex = optionIndices[optionName];
        if (!optionIndex) {
            // ZLS has not requested a config option with the given name.
            continue;
        }

        result[optionIndex] = additionalOptions[optionName];
    }

    return result as unknown[];
}

/**
 * Similar to https://ziglang.org/download/index.json
 */
interface SelectVersionResponse {
    /** The ZLS version */
    version: string;
    /** `YYYY-MM-DD` */
    date: string;
    [artifact: string]: ArtifactEntry | string | undefined;
}

interface SelectVersionFailureResponse {
    /**
     * The `code` **may** be one of `SelectVersionFailureCode`. Be aware that new
     * codes can be added over time.
     */
    code: number;
    /** A simplified explanation of why no ZLS build could be selected */
    message: string;
}

interface ArtifactEntry {
    /** A download URL */
    tarball: string;
    /** A SHA256 hash of the tarball */
    shasum: string;
    /** Size of the tarball in bytes */
    size: string;
}

async function fetchVersion(
    context: vscode.ExtensionContext,
    zigVersion: semver.SemVer,
    useCache: boolean,
): Promise<{ version: semver.SemVer; artifact: ArtifactEntry } | null> {
    // Should the cache be periodically cleared?
    const cacheKey = `zls-select-version-${zigVersion.raw}`;

    let response: SelectVersionResponse | SelectVersionFailureResponse | null = null;
    try {
        response = (
            await axios.get<SelectVersionResponse | SelectVersionFailureResponse>(
                "https://releases.zigtools.org/v1/zls/select-version",
                {
                    params: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        zig_version: zigVersion.raw,
                        compatibility: "only-runtime",
                    },
                },
            )
        ).data;

        // Cache the response
        if (useCache) {
            await context.globalState.update(cacheKey, response);
        }
    } catch (err) {
        // Try to read the result from cache
        if (useCache) {
            response = context.globalState.get<SelectVersionResponse | SelectVersionFailureResponse>(cacheKey) ?? null;
        }

        if (!response) {
            if (err instanceof Error) {
                void vscode.window.showErrorMessage(`Failed to query ZLS version: ${err.message}`);
            } else {
                throw err;
            }
            return null;
        }
    }

    if ("message" in response) {
        void vscode.window.showErrorMessage(`Unable to fetch ZLS: ${response.message as string}`);
        return null;
    }

    const hostName = getHostZigName();

    if (!(hostName in response)) {
        void vscode.window.showErrorMessage(
            `A prebuilt ZLS ${response.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
        );
        return null;
    }

    return {
        version: new semver.SemVer(response.version),
        artifact: response[hostName] as ArtifactEntry,
    };
}

async function isEnabled(): Promise<boolean> {
    const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
    if (!!zlsConfig.get<string>("path")) return true;

    switch (zlsConfig.get<"ask" | "off" | "on">("enabled", "ask")) {
        case "on":
            return true;
        case "off":
            return false;
        case "ask": {
            const response = await vscode.window.showInformationMessage(
                "We recommend enabling the ZLS Language Server for a better editing experience. Would you like to install it?",
                { modal: true },
                "Yes",
                "No",
            );
            switch (response) {
                case "Yes":
                    await zlsConfig.update("enabled", "on");
                    return true;
                case "No":
                    await zlsConfig.update("enabled", "off");
                    return false;
                case undefined:
                    return false;
            }
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // convert a `zig.zls.path` that points to the global storage to `zig.zls.enabled == "on"`
        const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
        const zlsPath = zlsConfig.get<string>("path", "");
        if (zlsPath.startsWith(context.globalStorageUri.fsPath)) {
            await zlsConfig.update("enabled", "on", true);
            await zlsConfig.update("path", undefined, true);
        }
    }

    outputChannel = vscode.window.createOutputChannel("Zig Language Server");

    context.subscriptions.push(
        outputChannel,
        vscode.commands.registerCommand("zig.zls.enable", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await zlsConfig.update("enabled", "on");
        }),
        vscode.commands.registerCommand("zig.zls.stop", async () => {
            await stopClient();
        }),
        vscode.commands.registerCommand("zig.zls.startRestart", async () => {
            const zlsConfig = vscode.workspace.getConfiguration("zig.zls");
            await zlsConfig.update("enabled", "on");
            await restartClient(context);
        }),
        vscode.commands.registerCommand("zig.zls.openOutput", () => {
            outputChannel.show();
        }),
        vscode.workspace.onDidChangeConfiguration(async (change) => {
            if (
                change.affectsConfiguration("zig.path", undefined) ||
                change.affectsConfiguration("zig.zls.enabled", undefined) ||
                change.affectsConfiguration("zig.zls.path", undefined) ||
                change.affectsConfiguration("zig.zls.debugLog", undefined)
            ) {
                await restartClient(context);
            }
        }),
    );

    if (await isEnabled()) {
        await restartClient(context);
    }
}

export async function deactivate(): Promise<void> {
    await stopClient();
}
