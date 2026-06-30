import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  readWranglerConfig,
  resolveAndValidateReplyRulesConfigPath,
} from "./wrangler-config";

export type ReleaseCommand = string[];

export interface ReleaseCommandPlan {
  preflight: ReleaseCommand[];
  deploy: ReleaseCommand[];
}

export interface ReleaseContext {
  wranglerConfig: {
    path: string;
    text: string;
  };
  replyRulesPath: string;
  plan: ReleaseCommandPlan;
}

type ReadWranglerConfig = typeof readWranglerConfig;
type ValidateReplyRulesConfig = (wranglerConfigPath: string) => Promise<string>;

export function buildReleaseCommandPlan(databaseName: string): ReleaseCommandPlan {
  return {
    preflight: [
      ["bun", "run", "typecheck"],
      ["bun", "run", "test"],
      ["bun", "run", "smoke:d1"],
    ],
    deploy: [
      ["bun", "run", "wrangler", "d1", "migrations", "apply", databaseName, "--remote"],
      ["bun", "run", "deploy"],
      ["bun", "run", "bot:status"],
    ],
  };
}

export function parseD1DatabaseName(wranglerToml: string): string {
  const d1SectionStart = wranglerToml.indexOf("[[d1_databases]]");
  const d1Section = d1SectionStart >= 0 ? wranglerToml.slice(d1SectionStart) : wranglerToml;
  const match = /^\s*database_name\s*=\s*"([^"]+)"\s*$/m.exec(d1Section);
  if (!match?.[1]) {
    throw new Error("Could not find D1 database_name in Wrangler config");
  }

  return match[1];
}

export function shouldRunDeployCommands(input: {
  isTty: boolean;
  confirmation: string;
}): boolean {
  return input.isTty && input.confirmation === "DEPLOY";
}

export function formatCommand(command: ReleaseCommand): string {
  return command.join(" ");
}

export async function prepareReleaseContext(input: {
  readWranglerConfig?: ReadWranglerConfig;
  validateReplyRulesConfig?: ValidateReplyRulesConfig;
} = {}): Promise<ReleaseContext> {
  const wranglerConfig = await (input.readWranglerConfig ?? readWranglerConfig)({
    preferProduction: true,
  });
  const validateReplyRulesConfig = input.validateReplyRulesConfig ??
    ((wranglerConfigPath) =>
      resolveAndValidateReplyRulesConfigPath({ wranglerConfigPath }));
  const replyRulesPath = await validateReplyRulesConfig(wranglerConfig.path);
  const databaseName = parseD1DatabaseName(wranglerConfig.text);

  return {
    wranglerConfig,
    replyRulesPath,
    plan: buildReleaseCommandPlan(databaseName),
  };
}

async function main(): Promise<void> {
  const context = await prepareReleaseContext();

  console.log(`Using Wrangler config: ${context.wranglerConfig.path}`);
  console.log(`Using reply rules: ${context.replyRulesPath}`);
  console.log("Running release preflight:");
  for (const command of context.plan.preflight) {
    await runCommand(command);
  }

  console.log("\nPreflight passed. Deploy commands:");
  printCommands(context.plan.deploy);

  if (!stdin.isTTY) {
    console.log("\nNon-interactive terminal detected. Deploy was not run.");
    return;
  }

  const confirmation = await readConfirmation();
  if (!shouldRunDeployCommands({ isTty: Boolean(stdin.isTTY), confirmation })) {
    console.log("Deploy was not run.");
    return;
  }

  for (const command of context.plan.deploy) {
    await runCommand(command);
  }
}

async function runCommand(command: ReleaseCommand): Promise<void> {
  console.log(`\n$ ${formatCommand(command)}`);
  const proc = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${formatCommand(command)}`);
  }
}

function printCommands(commands: ReleaseCommand[]): void {
  for (const command of commands) {
    console.log(`  ${formatCommand(command)}`);
  }
}

async function readConfirmation(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question("\nType DEPLOY to apply remote migrations and deploy: ")).trim();
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
