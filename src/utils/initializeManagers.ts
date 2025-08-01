import {
    NetworkManager as ConceroNetworkManager,
    HttpClient,
    Logger,
    NonceManager,
    RpcManager,
    TxMonitor,
    TxReader,
    TxWriter,
    ViemClientManager,
} from '@concero/operator-utils';
import { IOU_TOKEN_DECIMALS, USDC_DECIMALS } from 'src/constants';

import { globalConfig } from '../constants/globalConfig';
import {
    DeploymentManager,
    LancaBalanceManager,
    LancaNetworkManager,
    Rebalancer,
} from '../managers';

/** Initialize all managers in the correct dependency order */
export async function initializeManagers(
    overrideConfig: typeof globalConfig = globalConfig,
): Promise<void> {
    const config = { ...globalConfig, ...overrideConfig };

    const logger = Logger.createInstance({
        logLevelsGranular: {},
        logLevelDefault: config.LOGGER.LOG_LEVEL_DEFAULT,
        logDir: config.LOGGER.LOG_DIR,
        logMaxSize: config.LOGGER.LOG_MAX_SIZE,
        logMaxFiles: config.LOGGER.LOG_MAX_FILES,
        enableConsoleTransport: process.env.NODE_ENV !== 'production',
    });
    await logger.initialize();

    const httpLoggerInstance = logger.getLogger('HttpClient');
    const httpClient = HttpClient.createInstance(httpLoggerInstance, {
        retryDelay: config.HTTPCLIENT.RETRY_DELAY,
        maxRetries: config.HTTPCLIENT.MAX_RETRIES,
        defaultTimeout: config.HTTPCLIENT.DEFAULT_TIMEOUT,
    });

    await httpClient.initialize();

    // Core infrastructure managers
    const rpcManager = RpcManager.createInstance(logger.getLogger('RpcManager'), {
        rpcOverrides: config.RPC.OVERRIDE,
        rpcExtensions: config.RPC.EXTENSION,
        conceroRpcsUrl: config.URLS.CONCERO_RPCS,
        networkMode: config.NETWORK_MODE,
    });

    const viemClientManager = ViemClientManager.createInstance(
        logger.getLogger('ViemClientManager'),
        rpcManager,
        {
            fallbackTransportOptions: config.VIEM.FALLBACK_TRANSPORT_OPTIONS,
        },
    );

    // Initialize ConceroNetworkManager (no auto-updates, controlled by LancaNetworkManager)
    const conceroNetworkManager = ConceroNetworkManager.createInstance(
        logger.getLogger('ConceroNetworkManager'),
        httpClient,
        {
            networkMode: config.NETWORK_MODE,
            ignoredNetworkIds: config.IGNORED_NETWORK_IDS,
            whitelistedNetworkIds: config.WHITELISTED_NETWORK_IDS,
            defaultConfirmations: config.TX_MANAGER.DEFAULT_CONFIRMATIONS,
            mainnetUrl: config.URLS.V2_NETWORKS.MAINNET,
            testnetUrl: config.URLS.V2_NETWORKS.TESTNET,
        },
    );

    // Initialize DeploymentManager
    const deploymentManager = DeploymentManager.createInstance(
        logger.getLogger('DeploymentManager'),
        {
            poolDeploymentUrls: config.URLS.LANCA_POOL_DEPLOYMENTS,
            tokenDeploymentUrls: config.URLS.LANCA_TOKEN_DEPLOYMENTS,
            poolPatterns: config.DEPLOYMENT_MANAGER.POOL_PATTERNS,
            tokenPatterns: config.DEPLOYMENT_MANAGER.TOKEN_PATTERNS,
            networkMode: config.NETWORK_MODE,
            ...(config.NETWORK_MODE === 'localhost' && config.localhostDeployments
                ? { localhostDeployments: config.localhostDeployments }
                : {}),
        },
    );

    // Initialize LancaNetworkManager - this controls the update cycle
    const lancaNetworkManager = LancaNetworkManager.createInstance(
        logger.getLogger('LancaNetworkManager'),
        conceroNetworkManager,
        deploymentManager,
        {
            networkUpdateIntervalMs: config.LANCA_NETWORK_MANAGER.NETWORK_UPDATE_INTERVAL_MS,
            whitelistedNetworkIds: config.WHITELISTED_NETWORK_IDS[config.NETWORK_MODE],
            blacklistedNetworkIds: config.IGNORED_NETWORK_IDS,
            networkMode: config.NETWORK_MODE,
            ...(config.NETWORK_MODE === 'localhost' && config.localhostNetworks
                ? { localhostNetworks: config.localhostNetworks }
                : {}),
        },
    );

    // Initialize transaction managers
    const txMonitor = TxMonitor.createInstance(logger.getLogger('TxMonitor'), viemClientManager, {
        checkIntervalMs: config.TX_MONITOR.CHECK_INTERVAL_MS,
        dropTimeoutMs: config.TX_MONITOR.DROP_TIMEOUT_MS,
        retryDelayMs: config.TX_MONITOR.RETRY_DELAY_MS,
    });

    const txReader = TxReader.createInstance(
        logger.getLogger('TxReader'),
        lancaNetworkManager,
        viemClientManager,
        {},
    );

    // Initialize LancaBalanceManager (changed from BalanceManager)
    const balanceManager = LancaBalanceManager.createInstance(
        logger.getLogger('LancaBalanceManager'),
        viemClientManager,
        deploymentManager,
        txReader,
        {
            minAllowances: new Map([
                ['USDC', config.BALANCE_MANAGER.MIN_ALLOWANCE_USDC],
                ['IOU', config.BALANCE_MANAGER.MIN_ALLOWANCE_IOU],
            ]),
        },
    );

    // Initialize core managers
    await conceroNetworkManager.initialize();
    await rpcManager.initialize();
    await viemClientManager.initialize();
    await deploymentManager.initialize();
    await lancaNetworkManager.initialize();
    await txReader.initialize();
    await balanceManager.initialize();

    // LancaNetworkManager registers and controls all network update listeners
    // It dictates when ConceroNetworkManager should update
    lancaNetworkManager.registerUpdateListener(rpcManager);
    lancaNetworkManager.registerUpdateListener(viemClientManager);
    lancaNetworkManager.registerUpdateListener(balanceManager);

    // Trigger initial updates through LancaNetworkManager
    // This will cascade updates to all registered listeners
    await lancaNetworkManager.triggerInitialUpdates();

    const nonceManager = NonceManager.createInstance(
        logger.getLogger('NonceManager'),
        config.NONCE_MANAGER,
    );
    await nonceManager.initialize();

    const txWriter = TxWriter.createInstance(
        logger.getLogger('TxWriter'),
        viemClientManager,
        txMonitor,
        nonceManager,
        {
            dryRun: config.TX_MANAGER.DRY_RUN,
            simulateTx: false,
            defaultGasLimit: 2_000_000n,
        },
    );

    await txWriter.initialize();
    await txReader.initialize();

    // Initialize Rebalancer
    const rebalancer = Rebalancer.createInstance(
        logger.getLogger('Rebalancer'),
        txReader,
        txWriter,
        txMonitor,
        viemClientManager,
        balanceManager,
        deploymentManager,
        lancaNetworkManager,
        {
            deficitThreshold: config.REBALANCER.DEFICIT_THRESHOLD,
            surplusThreshold: config.REBALANCER.SURPLUS_THRESHOLD,
            checkIntervalMs: config.REBALANCER.CHECK_INTERVAL_MS,
            netTotalAllowance: config.REBALANCER.NET_TOTAL_ALLOWANCE,
            minAllowance: config.REBALANCER.MIN_ALLOWANCE,
            opportunityScorer: {
                minScore: config.OPPORTUNITY_SCORER.MIN_SCORE,
            },
        },
    );

    await rebalancer.initialize();

    // Start pool listeners
    await rebalancer.setupPoolListeners();

    logger.getLogger('Main').info('All managers initialized successfully');
}
