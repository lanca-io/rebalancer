export interface GlobalConfig {
  NETWORK_MODE: string;
  OPERATOR_ADDRESS: string;
  IGNORED_NETWORK_IDS: number[];
  WHITELISTED_NETWORK_IDS: {
    mainnet: number[];
    testnet: number[];
    localhost: number[];
  };
  LOGGER: {
    LOG_DIR: string;
    LOG_MAX_FILES: string;
    LOG_MAX_SIZE: string;
    LOG_LEVEL_DEFAULT: string;
  };
  URLS: {
    CONCERO_RPCS: string;
    LANCA_POOL_DEPLOYMENTS: string;
    LANCA_TOKEN_DEPLOYMENTS: string;
    V2_NETWORKS: {
      MAINNET: string;
      TESTNET: string;
    };
  };
  VIEM: {
    FALLBACK_TRANSPORT_OPTIONS: {
      retryCount: number;
      retryDelay: number;
    };
  };
  HTTPCLIENT: {
    DEFAULT_TIMEOUT: number;
    MAX_RETRIES: number;
    RETRY_DELAY: number;
  };
  RPC: {
    OVERRIDE: Record<string, string[]>;
    EXTENSION: Record<string, string[]>;
  };
  TX_MANAGER: {
    DRY_RUN: boolean;
    DEFAULT_CONFIRMATIONS: number;
  };
  LANCA_NETWORK_MANAGER: {
    NETWORK_UPDATE_INTERVAL_MS: number;
  };
  DEPLOYMENT_MANAGER: {
    POOL_PATTERNS: RegExp[];
    TOKEN_PATTERNS: RegExp[];
  };
  BALANCE_MANAGER: {
    UPDATE_INTERVAL_MS: number;
  };
  REBALANCER: {
    DEFICIT_THRESHOLD: bigint;
    SURPLUS_THRESHOLD: bigint;
    CHECK_INTERVAL_MS: number;
    NET_TOTAL_ALLOWANCE: bigint;
  };
  TX_MONITOR: {
    CHECK_INTERVAL_MS: number;
    DROP_TIMEOUT_MS: number;
    RETRY_DELAY_MS: number;
  };
  NONCE_MANAGER: Record<string, never>;
}
