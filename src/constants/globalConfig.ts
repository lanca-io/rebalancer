import { getEnvVar } from '@concero/operator-utils';
import { type GlobalConfig } from '../types/GlobalConfig';

const globalConfig: GlobalConfig = {
  NETWORK_MODE: getEnvVar('NETWORK_MODE') as
    | 'mainnet'
    | 'testnet'
    | 'localhost',
  OPERATOR_ADDRESS: getEnvVar('OPERATOR_ADDRESS'),
  IGNORED_NETWORK_IDS: [],
  WHITELISTED_NETWORK_IDS: {
    mainnet: [],
    testnet: [],
    localhost: [],
  },
  LOGGER: {
    LOG_DIR: 'logs',
    LOG_MAX_FILES: '7d',
    LOG_MAX_SIZE: '20m',
    LOG_LEVEL_DEFAULT: getEnvVar('LOG_LEVEL_DEFAULT'),
  },
  URLS: {
    CONCERO_RPCS: `https://raw.githubusercontent.com/concero/rpcs/refs/heads/master/output`,
    LANCA_POOL_DEPLOYMENTS: {
      MAINNET:
        'https://raw.githubusercontent.com/lanca-io/lbf-contracts/refs/heads/master/.env.deployments.mainnet',
      TESTNET:
        'https://raw.githubusercontent.com/lanca-io/lbf-contracts/refs/heads/master/.env.deployments.testnet',
    },
    LANCA_TOKEN_DEPLOYMENTS: {
      MAINNET:
        'https://raw.githubusercontent.com/lanca-io/lbf-contracts/refs/heads/master/.env.tokens.mainnet',
      TESTNET:
        'https://raw.githubusercontent.com/lanca-io/lbf-contracts/refs/heads/master/.env.tokens.testnet',
    },
    V2_NETWORKS: {
      MAINNET:
        'https://github.com/concero/v2-networks/raw/refs/heads/master/networks/mainnet.json',
      TESTNET:
        'https://github.com/concero/v2-networks/raw/refs/heads/master/networks/testnet.json',
    },
  },
  VIEM: {
    FALLBACK_TRANSPORT_OPTIONS: {
      retryCount: 5,
      retryDelay: 150,
    },
  },
  HTTPCLIENT: {
    DEFAULT_TIMEOUT: 5000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 100,
  },
  RPC: {
    OVERRIDE: {},
    EXTENSION: {},
  },
  TX_MANAGER: {
    DRY_RUN: getEnvVar('DRY_RUN') === 'true',
    DEFAULT_CONFIRMATIONS: 3,
  },

  LANCA_NETWORK_MANAGER: {
    NETWORK_UPDATE_INTERVAL_MS: parseInt(
      getEnvVar('LANCA_NETWORK_UPDATE_INTERVAL_MS') || '300000'
    ), // 5 minutes default
  },
  DEPLOYMENT_MANAGER: {
    POOL_PATTERNS: [/LBF_CHILD_POOL_(.+)/, /LBF_PARENT_POOL_(.+)/],
    TOKEN_PATTERNS: [/USDC_(.+)/, /IOU_(.+)/],
  },
  BALANCE_MANAGER: {
    UPDATE_INTERVAL_MS: parseInt(
      getEnvVar('BALANCE_UPDATE_INTERVAL_MS') || '60000'
    ), // 1 minute default
  },
  REBALANCER: {
    DEFICIT_THRESHOLD: BigInt(getEnvVar('DEFICIT_THRESHOLD') || 10),
    SURPLUS_THRESHOLD: BigInt(getEnvVar('SURPLUS_THRESHOLD') || 10),
    CHECK_INTERVAL_MS: parseInt(
      getEnvVar('REBALANCER_CHECK_INTERVAL_MS') || '30000'
    ), // 30 seconds default
    NET_TOTAL_ALLOWANCE: BigInt(getEnvVar('NET_TOTAL_ALLOWANCE') || '1000000'), // Default 1M
  },
  TX_MONITOR: {
    CHECK_INTERVAL_MS: 5000,
    DROP_TIMEOUT_MS: 60000,
    RETRY_DELAY_MS: 30000,
  },
  NONCE_MANAGER: {},
};

export { globalConfig };
