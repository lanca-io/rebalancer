import {
  NetworkManager as ConceroNetworkManager,
  HttpClient,
  Logger, // Using alias until library is updated
  NonceManager,
  RpcManager,
  TxMonitor,
  TxReader,
  TxWriter,
  ViemClientManager,
} from '@concero/operator-utils';
import { globalConfig } from '../constants/globalConfig';
import {
  BalanceManager,
  DeploymentManager,
  LancaNetworkManager,
  Rebalancer,
} from '../managers';

/** Initialize all managers in the correct dependency order */
export async function initializeManagers(): Promise<void> {
  const logger = Logger.createInstance({
    logLevelsGranular: {},
    logLevelDefault: globalConfig.LOGGER.LOG_LEVEL_DEFAULT,
    logDir: globalConfig.LOGGER.LOG_DIR,
    logMaxSize: globalConfig.LOGGER.LOG_MAX_SIZE,
    logMaxFiles: globalConfig.LOGGER.LOG_MAX_FILES,
    enableConsoleTransport: process.env.NODE_ENV !== 'production',
  });
  await logger.initialize();

  const httpLoggerInstance = logger.getLogger('HttpClient');
  const httpClient = HttpClient.createInstance(httpLoggerInstance, {
    retryDelay: globalConfig.HTTPCLIENT.RETRY_DELAY,
    maxRetries: globalConfig.HTTPCLIENT.MAX_RETRIES,
    defaultTimeout: globalConfig.HTTPCLIENT.DEFAULT_TIMEOUT,
  });

  await httpClient.initialize();

  // Core infrastructure managers
  const rpcManager = RpcManager.createInstance(logger.getLogger('RpcManager'), {
    rpcOverrides: globalConfig.RPC.OVERRIDE,
    rpcExtensions: globalConfig.RPC.EXTENSION,
    conceroRpcsUrl: globalConfig.URLS.CONCERO_RPCS,
    networkMode: globalConfig.NETWORK_MODE as
      | 'mainnet'
      | 'testnet'
      | 'localhost',
  });

  const viemClientManager = ViemClientManager.createInstance(
    logger.getLogger('ViemClientManager'),
    rpcManager,
    {
      fallbackTransportOptions: globalConfig.VIEM.FALLBACK_TRANSPORT_OPTIONS,
    }
  );

  // Initialize ConceroNetworkManager (no auto-updates, controlled by LancaNetworkManager)
  const conceroNetworkManager = ConceroNetworkManager.createInstance(
    logger.getLogger('ConceroNetworkManager'),
    httpClient,
    {
      networkMode: globalConfig.NETWORK_MODE as
        | 'mainnet'
        | 'testnet'
        | 'localhost',
      ignoredNetworkIds: globalConfig.IGNORED_NETWORK_IDS,
      whitelistedNetworkIds: globalConfig.WHITELISTED_NETWORK_IDS,
      defaultConfirmations: globalConfig.TX_MANAGER.DEFAULT_CONFIRMATIONS,
      mainnetUrl: globalConfig.URLS.V2_NETWORKS.MAINNET,
      testnetUrl: globalConfig.URLS.V2_NETWORKS.TESTNET,
    }
  );

  // Initialize DeploymentManager
  const deploymentManager = DeploymentManager.createInstance(
    logger.getLogger('DeploymentManager'),
    {
      poolDeploymentsUrl: globalConfig.URLS.LANCA_POOL_DEPLOYMENTS,
      tokenDeploymentsUrl: globalConfig.URLS.LANCA_TOKEN_DEPLOYMENTS,
      poolPatterns: globalConfig.DEPLOYMENT_MANAGER.POOL_PATTERNS,
      tokenPatterns: globalConfig.DEPLOYMENT_MANAGER.TOKEN_PATTERNS,
    }
  );

  // Initialize LancaNetworkManager - this controls the update cycle
  const lancaNetworkManager = LancaNetworkManager.createInstance(
    logger.getLogger('LancaNetworkManager'),
    conceroNetworkManager,
    deploymentManager,
    {
      networkUpdateIntervalMs:
        globalConfig.LANCA_NETWORK_MANAGER.NETWORK_UPDATE_INTERVAL_MS,
      whitelistedNetworkIds:
        globalConfig.WHITELISTED_NETWORK_IDS[
          globalConfig.NETWORK_MODE as keyof typeof globalConfig.WHITELISTED_NETWORK_IDS
        ],
      blacklistedNetworkIds: globalConfig.IGNORED_NETWORK_IDS,
    }
  );

  // Initialize BalanceManager
  const balanceManager = BalanceManager.createInstance(
    logger.getLogger('BalanceManager'),
    viemClientManager,
    deploymentManager,
    {
      updateIntervalMs: globalConfig.BALANCE_MANAGER.UPDATE_INTERVAL_MS,
    }
  );

  // Initialize core managers
  await conceroNetworkManager.initialize();
  await rpcManager.initialize();
  await viemClientManager.initialize();
  await deploymentManager.initialize();
  await lancaNetworkManager.initialize();
  await balanceManager.initialize();

  // LancaNetworkManager registers and controls all network update listeners
  // It dictates when ConceroNetworkManager should update
  lancaNetworkManager.registerUpdateListener(rpcManager);
  lancaNetworkManager.registerUpdateListener(viemClientManager);
  lancaNetworkManager.registerUpdateListener(balanceManager);

  // Trigger initial updates through LancaNetworkManager
  // This will cascade updates to all registered listeners
  await lancaNetworkManager.triggerInitialUpdates();

  // Initialize transaction managers
  const txMonitor = TxMonitor.createInstance(
    logger.getLogger('TxMonitor'),
    viemClientManager,
    {
      checkIntervalMs: globalConfig.TX_MONITOR.CHECK_INTERVAL_MS,
      dropTimeoutMs: globalConfig.TX_MONITOR.DROP_TIMEOUT_MS,
      retryDelayMs: globalConfig.TX_MONITOR.RETRY_DELAY_MS,
    }
  );

  const txReader = TxReader.createInstance(
    logger.getLogger('TxReader'),
    lancaNetworkManager,
    viemClientManager,
    {}
  );

  const nonceManager = NonceManager.createInstance(
    logger.getLogger('NonceManager'),
    globalConfig.NONCE_MANAGER
  );
  await nonceManager.initialize();

  const txWriter = TxWriter.createInstance(
    logger.getLogger('TxWriter'),
    viemClientManager,
    txMonitor,
    nonceManager,
    {
      dryRun: globalConfig.TX_MANAGER.DRY_RUN,
      simulateTx: false,
      defaultGasLimit: 2_000_000n,
    }
  );

  await txWriter.initialize();
  await txReader.initialize();

  // Initialize Rebalancer
  const rebalancer = Rebalancer.createInstance(
    logger.getLogger('Rebalancer'),
    txReader,
    txWriter,
    txMonitor,
    balanceManager,
    deploymentManager,
    lancaNetworkManager,
    {
      deficitThreshold: globalConfig.REBALANCER.DEFICIT_THRESHOLD,
      surplusThreshold: globalConfig.REBALANCER.SURPLUS_THRESHOLD,
      checkIntervalMs: globalConfig.REBALANCER.CHECK_INTERVAL_MS,
      netTotalAllowance: globalConfig.REBALANCER.NET_TOTAL_ALLOWANCE,
    }
  );

  await rebalancer.initialize();

  // Start pool listeners
  await rebalancer.setupPoolListeners();

  logger.getLogger('Main').info('All managers initialized successfully');
}
