import {
  PUBLIC_REPLY_RULES_CONFIG,
  PUBLIC_WRANGLER_CONFIG,
  resolveAndValidateReplyRulesConfigPath,
  resolveWranglerConfigPath,
} from "./wrangler-config";
import { access, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error("Expected Wrangler command arguments");
  }

  const configArg = parseWranglerConfigArg(args);
  const preferProduction = shouldPreferProductionConfig(args);
  const configPath = configArg.explicitConfigPath ??
    await resolveWranglerConfigPath({ preferProduction });

  if (shouldUseDeployWorkspace(args)) {
    const exitCode = await runDeployFromWorkspace(configArg.argsWithoutConfig, configPath);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const wranglerArgs = configArg.explicitConfigPath ? args : [...args, "--config", configPath];
  const exitCode = await runWrangler(wranglerArgs);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function shouldPreferProductionConfig(args: string[]): boolean {
  return args[0] === "deploy" || args.includes("--remote");
}

function shouldUseDeployWorkspace(args: string[]): boolean {
  return args[0] === "deploy";
}

export function parseWranglerConfigArg(args: string[]): {
  explicitConfigPath?: string;
  argsWithoutConfig: string[];
} {
  let explicitConfigPath: string | undefined;
  const argsWithoutConfig: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--config") {
      const configPath = args[index + 1];
      if (!configPath || configPath.startsWith("--")) {
        throw new Error("--config requires a config path");
      }
      if (explicitConfigPath) {
        throw new Error("Only one --config argument is supported");
      }
      explicitConfigPath = configPath;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const configPath = arg.slice("--config=".length);
      if (!configPath) {
        throw new Error("--config requires a config path");
      }
      if (explicitConfigPath) {
        throw new Error("Only one --config argument is supported");
      }
      explicitConfigPath = configPath;
      continue;
    }

    argsWithoutConfig.push(arg);
  }

  return { explicitConfigPath, argsWithoutConfig };
}

async function runDeployFromWorkspace(args: string[], configPath: string): Promise<number> {
  const workspace = await mkdtemp(join(tmpdir(), "instagram-bot-deploy-"));
  try {
    await copyGitVisibleFiles(workspace);
    await linkLocalDependencies(workspace);
    await copyFile(configPath, join(workspace, PUBLIC_WRANGLER_CONFIG));

    const replyRulesPath = await resolveAndValidateReplyRulesConfigPath({
      wranglerConfigPath: configPath,
    });
    await copyFile(replyRulesPath, join(workspace, PUBLIC_REPLY_RULES_CONFIG));

    return await runWrangler(args, workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function copyGitVisibleFiles(destinationRoot: string): Promise<void> {
  const proc = Bun.spawnSync([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (proc.exitCode !== 0) {
    throw new Error("Could not list deploy files");
  }

  const paths = proc.stdout.toString().split("\0").filter(Boolean);
  for (const path of paths) {
    const destination = join(destinationRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
  }
}

async function linkLocalDependencies(destinationRoot: string): Promise<void> {
  if (!(await pathExists("node_modules"))) {
    return;
  }

  await symlink(join(process.cwd(), "node_modules"), join(destinationRoot, "node_modules"), "dir");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runWrangler(args: string[], cwd?: string): Promise<number> {
  const proc = Bun.spawn(["bunx", "wrangler", ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
