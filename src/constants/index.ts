import { abi as erc20Abi } from './erc20Abi.json';
import { abi as lbfAbi } from './lbfAbi.json';

export * from './globalConfig';
export * from './tokens';

// Combine LBF ABI and ERC20 ABI to create full LBF ABI
export const FULL_LBF_ABI = [...lbfAbi, ...erc20Abi];
