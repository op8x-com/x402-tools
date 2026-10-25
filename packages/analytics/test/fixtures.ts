export function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export const PAYER = "0x2222222222222222222222222222222222222222";
export const TX = "0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca";

const accepted = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
};

export const v2Challenge = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://example.com/api" },
  accepts: [accepted],
};

export const v1Challenge = {
  x402Version: 1,
  error: "X-PAYMENT header is required",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x1111111111111111111111111111111111111111",
    },
  ],
};

export const v2Payment = {
  x402Version: 2,
  accepted,
  payload: {
    signature: "0xdeadbeef",
    authorization: { from: PAYER, to: accepted.payTo, value: "1000" },
  },
};

export const v1Payment = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0xdeadbeef",
    authorization: { from: PAYER, to: accepted.payTo, value: "1000" },
  },
};

export const v2Receipt = {
  success: true,
  transaction: TX,
  network: "eip155:84532",
  payer: PAYER,
};

export const v1Receipt = {
  success: true,
  transaction: TX,
  network: "base-sepolia",
  payer: PAYER,
};
