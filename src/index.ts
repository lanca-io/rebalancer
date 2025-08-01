import { Logger } from '@concero/operator-utils';

import { initializeManagers } from './utils/initializeManagers';

// Global error handlers
process.on('uncaughtException', error => {
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

    try {
        await initializeManagers();
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
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
