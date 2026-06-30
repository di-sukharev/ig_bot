import { parseCliOptions, requireAdminApiKey } from "./cli";

const options = parseCliOptions();
requireAdminApiKey(options.adminApiKey);

const response = await fetch(new URL("/admin/status", options.baseUrl), {
  headers: {
    Authorization: `Bearer ${options.adminApiKey}`,
  },
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Status request failed with ${response.status}: ${body}`);
}

const parsed = JSON.parse(body) as unknown;
console.log(JSON.stringify(parsed, null, 2));
