import type { Method, ProbeResult } from "../src/types.ts";

export const v2 = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/weather",
    description: "Weather data",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

export const v1 = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      resource: "https://api.example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxTimeoutSeconds: 60,
    },
  ],
};

export function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function pr(
  method: Method,
  status: number,
  headers: Record<string, string> = {},
  body?: unknown,
): ProbeResult {
  return {
    method,
    url: "https://api.example.com/weather",
    status,
    headers,
    bodyText: body === undefined ? "" : JSON.stringify(body),
    ms: 1,
  };
}
