import { Logger } from '@concero/operator-utils';
import { defineChain } from 'viem';
import { initializeManagers } from './utils/initializeManagers';

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown handler
let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    console.log('Shutdown already in progress...');
    return;
  }

  shutdownInProgress = true;
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  try {
    // Get logger instance if available
    const logger = Logger.getInstance();
    if (logger) {
      logger.getLogger('Main').info(`Shutting down due to ${signal}`);
      await logger.dispose();
    }

    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Main function
async function main(): Promise<void> {
  console.log('Starting Lanca Rebalancer...');

  const TEST_CONSTANTS = {
    // Network constants
    LOCALHOST_URL: 'http://127.0.0.1:8545',
    LOCALHOST_CHAIN_ID: 1,
    LOCALHOST_CHAIN_NAME: 'Localhost',

    // Token constants
    USDC_DECIMALS: 6,
    DEFAULT_TOKEN_DECIMALS: 18,

    // Test timeouts (in milliseconds)
    DEFAULT_TIMEOUT: 120000,
    EVENT_TIMEOUT: 10000,
    BALANCE_TIMEOUT: 60000,

    // Test values
    DEFAULT_IOU_MINT_AMOUNT: '100',
    DEFAULT_USDC_MINT_AMOUNT: '100',
    DEFAULT_ETH_BALANCE: '100',
    DEFAULT_NATIVE_TRANSFER: '1',

    // Test intervals
    BLOCK_CHECK_INTERVAL: 1000,
    CHAIN_STARTUP_INTERVAL: 100,
  } as const;
  const localhostViemChain = /*#__PURE__*/ defineChain({
    id: TEST_CONSTANTS.LOCALHOST_CHAIN_ID,
    name: TEST_CONSTANTS.LOCALHOST_CHAIN_NAME,
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [TEST_CONSTANTS.LOCALHOST_URL] },
    },
  });

  try {
    await initializeManagers({
      localhostDeployments: {
        pools: {
          localhost2: '0xcAE447Abb396Ed83a0CF5bD760fC85C2E6Bbb04D',
        },
        parentPool: {
          network: 'localhost1',
          address: '0x0A296F00bC3300153a78DC584Bc607fe8d8030A4',
        },
        usdcTokens: {
          localhost1: '0x3c598f47F1fAa37395335f371ea7cd3b741D06B6',
          localhost2: '0x3c598f47F1fAa37395335f371ea7cd3b741D06B6',
        },
        iouTokens: {
          localhost1: '0xa45F4A08eCE764a74cE20306d704e7CbD755D8a4',
          localhost2: '0xa45F4A08eCE764a74cE20306d704e7CbD755D8a4',
        },
      },
      localhostNetworks: [
        {
          id: TEST_CONSTANTS.LOCALHOST_CHAIN_ID,
          name: 'localhost1',
          displayName: 'Localhost Chain 1',
          rpcUrls: [TEST_CONSTANTS.LOCALHOST_URL],
          chainSelector: '2',
          isTestnet: true,
          viemChain: {
            ...localhostViemChain,
            id: TEST_CONSTANTS.LOCALHOST_CHAIN_ID,
            name: 'Localhost 1',
            network: 'localhost1',
            nativeCurrency: {
              NAME: 'Ether',
              SYMBOL: 'ETH',
              DECIMALS: 18,
            },
            rpcUrls: {
              default: {
                http: [TEST_CONSTANTS.LOCALHOST_URL],
              },
              public: {
                http: [TEST_CONSTANTS.LOCALHOST_URL],
              },
            },
          },
        },
        {
          id: 2,
          name: 'localhost2',
          displayName: 'Localhost Chain 2',
          rpcUrls: [TEST_CONSTANTS.LOCALHOST_URL],
          chainSelector: '2',
          isTestnet: true,
          viemChain: {
            ...localhostViemChain,
            id: TEST_CONSTANTS.LOCALHOST_CHAIN_ID,
            name: 'Localhost 2',
            network: 'localhost2',
            nativeCurrency: {
              NAME: 'Ether',
              SYMBOL: 'ETH',
              DECIMALS: 18,
            },
            rpcUrls: {
              default: {
                http: [TEST_CONSTANTS.LOCALHOST_URL],
              },
              public: {
                http: [TEST_CONSTANTS.LOCALHOST_URL],
              },
            },
          },
        },
      ],
    });
    console.log('Lanca Rebalancer is running');

    // Keep the process alive
    setInterval(() => {
      // Heartbeat to keep the process alive
    }, 60000); // Every minute
  } catch (error) {
    console.error('Failed to start Lanca Rebalancer:', error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
