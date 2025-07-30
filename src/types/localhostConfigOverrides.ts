export interface LocalhostDeployments {
  pools: Record<string, string>;
  parentPool: { network: string; address: string };
  usdcTokens: Record<string, string>;
  iouTokens: Record<string, string>;
}

export interface LocalhostNetwork {
  id: number;
  name: string;
  displayName: string;
  chainId: number;
  rpcUrls: string[];
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorerUrls: string[];
  isTestnet: boolean;
  isActive: boolean;
}

export interface LocalhostConfigOverrides {
  localhostDeployments?: LocalhostDeployments;
  localhostNetworks?: LocalhostNetwork[];
}