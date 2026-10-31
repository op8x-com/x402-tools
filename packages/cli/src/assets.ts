// Asset data for the spend-control findings (see docs/designs/2026-10-30-cli-spend-controls-design.md).
// DEFAULT_ASSETS and V1_NETWORKS are copies from @x402/evm 2.29.0 and @x402/svm 2.29.0;
// test/assets.test.ts fails when they drift from the installed packages.

export interface AssetInfo {
  asset: string;
  symbol: string;
  decimals: number;
}

/** Assets that default x402 clients accept, by CAIP-2 network (DEFAULT_ASSETS of @x402/evm and @x402/svm). */
export const DEFAULT_ASSETS: Record<string, AssetInfo[]> = {
  "eip155:8453": [
    { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  ],
  "eip155:84532": [
    { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 },
  ],
  "eip155:1": [
    { asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  ],
  "eip155:43114": [
    { asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", decimals: 6 },
  ],
  "eip155:4326": [
    { asset: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", symbol: "MegaUSD", decimals: 18 },
  ],
  "eip155:143": [
    { asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", symbol: "USDC", decimals: 6 },
  ],
  "eip155:10143": [
    { asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3", symbol: "USDC", decimals: 6 },
  ],
  "eip155:988": [
    { asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", symbol: "USDT0", decimals: 6 },
  ],
  "eip155:2201": [
    { asset: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9", symbol: "USDT0", decimals: 6 },
  ],
  "eip155:137": [
    { asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
  ],
  "eip155:42161": [
    { asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
  ],
  "eip155:421614": [
    { asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6 },
  ],
  "eip155:31612": [
    { asset: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186", symbol: "mUSD", decimals: 18 },
  ],
  "eip155:31611": [
    { asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", symbol: "mUSD", decimals: 18 },
  ],
  "eip155:723487": [
    { asset: "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", symbol: "SBC", decimals: 6 },
  ],
  "eip155:72344": [
    { asset: "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", symbol: "SBC", decimals: 6 },
  ],
  "eip155:36900": [
    { asset: "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", symbol: "USDC.e", decimals: 6 },
  ],
  "eip155:190415": [
    { asset: "0x401eCb1D350407f13ba348573E5630B83638E30D", symbol: "USDC.e", decimals: 6 },
  ],
  "eip155:181228": [
    { asset: "0x401eCb1D350407f13ba348573E5630B83638E30D", symbol: "USDC.e", decimals: 6 },
  ],
  "eip155:50": [
    { asset: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", symbol: "USDC", decimals: 6 },
  ],
  "eip155:51": [
    { asset: "0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4", symbol: "USDC", decimals: 6 },
  ],
  "eip155:38833": [
    { asset: "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7", symbol: "USDC", decimals: 6 },
  ],
  "eip155:14": [
    { asset: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", symbol: "USDT0", decimals: 6 },
  ],
  "eip155:42220": [
    { asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", symbol: "USDC", decimals: 6 },
    { asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USDT", decimals: 6 },
    { asset: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", symbol: "USAT", decimals: 6 },
  ],
  "eip155:11142220": [
    { asset: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", symbol: "USDC", decimals: 6 },
  ],
  "eip155:1329": [
    { asset: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", symbol: "USDC", decimals: 6 },
  ],
  "eip155:1328": [
    { asset: "0x4fCF1784B31630811181f670Aea7A7bEF803eaED", symbol: "USDC", decimals: 6 },
  ],
  "eip155:5042": [
    { asset: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6 },
  ],
  "eip155:5042002": [
    { asset: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6 },
  ],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": [
    { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
    { asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
    { asset: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", symbol: "USDG", decimals: 6 },
    { asset: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", symbol: "PYUSD", decimals: 6 },
    { asset: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", symbol: "CASH", decimals: 6 },
  ],
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": [
    { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
    { asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", symbol: "USDG", decimals: 6 },
    { asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", symbol: "PYUSD", decimals: 6 },
  ],
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z": [
    { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
    { asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", symbol: "USDG", decimals: 6 },
    { asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", symbol: "PYUSD", decimals: 6 },
  ],
};

/**
 * EURC (not a default asset), from Circle's published contract list
 * (https://developers.circle.com/stablecoins/eurc-contract-addresses, read 2026-10-30).
 */
export const EURC_ASSETS: Record<string, AssetInfo[]> = {
  "eip155:8453": [{ asset: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 }],
  "eip155:84532": [{ asset: "0x808456652fdb597867f38412077A9182bf77359F", symbol: "EURC", decimals: 6 }],
  "eip155:1": [{ asset: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", symbol: "EURC", decimals: 6 }],
  "eip155:11155111": [{ asset: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4", symbol: "EURC", decimals: 6 }],
  "eip155:43114": [{ asset: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD", symbol: "EURC", decimals: 6 }],
  "eip155:43113": [{ asset: "0x5E44db7996c682E92a960b65AC713a54AD815c6B", symbol: "EURC", decimals: 6 }],
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": [{ asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", symbol: "EURC", decimals: 6 }],
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": [{ asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", symbol: "EURC", decimals: 6 }],
};

/** v1 network names that default clients register, mapped to CAIP-2 (@x402/evm/v1 and @x402/svm). */
export const V1_NETWORKS: Record<string, string> = {
  ethereum: "eip155:1",
  sepolia: "eip155:11155111",
  abstract: "eip155:2741",
  "abstract-testnet": "eip155:11124",
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
  "avalanche-fuji": "eip155:43113",
  avalanche: "eip155:43114",
  iotex: "eip155:4689",
  sei: "eip155:1329",
  "sei-testnet": "eip155:1328",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  peaq: "eip155:3338",
  story: "eip155:1514",
  educhain: "eip155:41923",
  "skale-base-sepolia": "eip155:324705682",
  megaeth: "eip155:4326",
  monad: "eip155:143",
  "monad-testnet": "eip155:10143",
  stable: "eip155:988",
  "stable-testnet": "eip155:2201",
  celo: "eip155:42220",
  flare: "eip155:14",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana-testnet": "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

/** The Solana networks @x402/svm knows; it throws for any other "solana:" network. */
export const SOLANA_NETWORKS = Object.keys(DEFAULT_ASSETS).filter((n) => n.startsWith("solana:"));

// Network names come from the challenge: only own keys count, never "__proto__" or "constructor".
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** CAIP-2 form of a network as a client of the given version resolves it. */
export function caip2(network: string, version: 1 | 2): string {
  return version === 1 ? (own(V1_NETWORKS, network) ?? network) : network;
}

// EVM addresses compare case-insensitively, Solana mints exactly, as the SDKs do.
function lookup(table: Record<string, AssetInfo[]>, network: string, asset: string): AssetInfo | undefined {
  const evm = network.startsWith("eip155:");
  return own(table, network)?.find((row) => (evm ? row.asset.toLowerCase() === asset.toLowerCase() : row.asset === asset));
}

/** The default asset for a CAIP-2 network, as findDefaultAsset of @x402/evm and @x402/svm returns it. */
export const findDefaultAsset = (asset: string, network: string) => lookup(DEFAULT_ASSETS, network, asset);

/** The EURC row for a CAIP-2 network and asset, if it is EURC. */
export const findEurc = (asset: string, network: string) => lookup(EURC_ASSETS, network, asset);

/** A known asset (default or EURC) for labels. */
export const findKnownAsset = (asset: string, network: string) => findDefaultAsset(asset, network) ?? findEurc(asset, network);
