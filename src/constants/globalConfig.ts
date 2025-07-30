import { getEnvVar } from '@concero/operator-utils';
import { minutes, seconds } from 'src/utils/time';
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
    DEFAULT_TIMEOUT: seconds(5),
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
    NETWORK_UPDATE_INTERVAL_MS:
      parseInt(getEnvVar('LANCA_NETWORK_UPDATE_INTERVAL_MS')) || minutes(30),
  },
  DEPLOYMENT_MANAGER: {
    POOL_PATTERNS: [/LBF_CHILD_POOL_(.+)/, /LBF_PARENT_POOL_(.+)/],
    TOKEN_PATTERNS: [/USDC_(.+)/, /IOU_(.+)/],
  },
  BALANCE_MANAGER: {
    UPDATE_INTERVAL_MS:
      parseInt(getEnvVar('BALANCE_UPDATE_INTERVAL_MS')) || seconds(60),
  },
  REBALANCER: {
    DEFICIT_THRESHOLD: BigInt(getEnvVar('DEFICIT_THRESHOLD') || 10),
    SURPLUS_THRESHOLD: BigInt(getEnvVar('SURPLUS_THRESHOLD') || 10),
    CHECK_INTERVAL_MS:
      parseInt(getEnvVar('REBALANCER_CHECK_INTERVAL_MS')) || seconds(30),
    NET_TOTAL_ALLOWANCE: BigInt(getEnvVar('NET_TOTAL_ALLOWANCE')) || 1_000_000n, // Default 1M
    MIN_ALLOWANCE: {
      USDC: BigInt(getEnvVar('MIN_ALLOWANCE_USDC') || 1_000_000n), // Default 1M USDC
      IOU: BigInt(getEnvVar('MIN_ALLOWANCE_IOU') || 1_000_000n), // Default 1M IOU
    },
  },
  TX_MONITOR: {
    CHECK_INTERVAL_MS: seconds(5),
    DROP_TIMEOUT_MS: seconds(60),
    RETRY_DELAY_MS: seconds(30),
  },
  NONCE_MANAGER: {},
};

export { globalConfig };
