import {
  Address,
  BigDecimal,
  BigInt,
  dataSource,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import {
  Deposit,
  LiquidityPool,
  LiquidityPoolDailySnapshot,
  LiquidityPoolHourlySnapshot,
  Swap as SwapEvent,
  Token,
  Withdraw,
} from "../../generated/schema";
import { Swap } from "../../generated/templates/Swap/Swap";
import { SwapV1 } from "../../generated/templates/Swap/SwapV1";
import {
  BIGDECIMAL_HUNDRED,
  BIGDECIMAL_ONE,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  BROKEN_POOLS,
  POOL_DATA,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  ZERO_ADDRESS,
} from "../utils/constants";
import { bigIntToBigDecimal, calculateAverage } from "../utils/numbers";
import { getProtocolFee, getSupplySideFee, createOrUpdateAllFees } from "./fee";
import {
  addProtocolUSDRevenue,
  addProtocolUSDVolume,
  getOrCreateProtocol,
  incrementProtocolDepositCount,
  incrementProtocolSwapCount,
  incrementProtocolWithdrawCount,
  updateProtocolTVL,
} from "./protocol";
import {
  checkValidToken,
  getOrCreateRewardToken,
  getOrCreateToken,
  getOrCreateTokenFromString,
  getTokenDecimals,
} from "./token";
import { getPriceUSD, getTokenAmountsSumUSD } from "../utils/price";
import { prefixID } from "../utils/strings";
import { MiniChefV2 } from "../../generated/templates/Swap/MiniChefV2";
import { NewSwapPool } from "../../generated/templates/Swap/SwapDeployer";
import { SimpleRewarder } from "../../generated/templates/Swap/SimpleRewarder";

export function getOrCreatePool(address: Address): LiquidityPool {
  let pool = LiquidityPool.load(address.toHexString());
  if (!pool) {
    // Pool was not created through a SwapDeployer
    pool = createPoolFromAddress(address);
  }
  return pool;
}

export function createPoolFromEvent(event: NewSwapPool): boolean {
  const address = event.params.swapAddress;
  const addressString = address.toHexString();
  // Don't track unused/broken pools
  if (BROKEN_POOLS.has(addressString)) {
    return false;
  }
  const contract = Swap.bind(address);
  let lpTokenAddress = contract.swapStorage().value6;
  // Check if LP token exists
  if (!checkValidToken(lpTokenAddress)) {
    const v1contract = SwapV1.bind(address);
    lpTokenAddress = v1contract.swapStorage().value7;
    if (!checkValidToken(lpTokenAddress)) {
      log.error("Invalid LP token address {} in pool {}", [
        lpTokenAddress.toHexString(),
        address.toHexString(),
      ]);
      return false;
    }
  }
  const pool = new LiquidityPool(addressString);
  pool.protocol = getOrCreateProtocol().id;
  pool.inputTokens = getOrCreateInputTokens(event.params.pooledTokens);
  const token = getOrCreateToken(lpTokenAddress, addressString);
  pool.outputToken = token.id;
  pool.outputTokenSupply = BIGINT_ZERO;
  pool.createdTimestamp = event.block.timestamp;
  pool.createdBlockNumber = event.block.number;
  pool.name = token.name;
  pool.symbol = token.symbol;
  const tradingFee = contract.swapStorage().value4; // swapFee
  const adminFee = contract.swapStorage().value5; // adminFee
  pool.fees = createOrUpdateAllFees(address, tradingFee, adminFee);
  pool._basePool = getBasePool(contract);
  setInputTokenBalancesAndWeights(pool, contract);
  pool.save();
  return true;
}

export function getOrCreatePoolDailySnapshot(
  event: ethereum.Event,
  pool: LiquidityPool
): LiquidityPoolDailySnapshot {
  const day: i64 = event.block.timestamp.toI64() / SECONDS_PER_DAY;
  const id = `${pool.id}-${day}`;
  let poolDailySnapshot = LiquidityPoolDailySnapshot.load(id);
  if (!poolDailySnapshot) {
    poolDailySnapshot = new LiquidityPoolDailySnapshot(id);
    poolDailySnapshot.protocol = pool.protocol;
    poolDailySnapshot.pool = pool.id;
    poolDailySnapshot.dailyVolumeByTokenAmount = new Array<BigInt>(
      pool.inputTokens.length
    ).map<BigInt>(() => BIGINT_ZERO);
    poolDailySnapshot.dailyVolumeByTokenUSD = new Array<BigDecimal>(
      pool.inputTokens.length
    ).map<BigDecimal>(() => BIGDECIMAL_ZERO);

    poolDailySnapshot.dailySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    poolDailySnapshot.dailyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    poolDailySnapshot.dailyTotalRevenueUSD = BIGDECIMAL_ZERO;
  }
  poolDailySnapshot.totalValueLockedUSD = pool.totalValueLockedUSD;
  poolDailySnapshot.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
  poolDailySnapshot.inputTokenBalances = pool.inputTokenBalances;
  poolDailySnapshot.inputTokenWeights = pool.inputTokenWeights;
  poolDailySnapshot.outputTokenSupply = pool.outputTokenSupply;
  poolDailySnapshot.outputTokenPriceUSD = pool.outputTokenPriceUSD;
  poolDailySnapshot.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
  poolDailySnapshot.rewardTokenEmissionsAmount =
    pool.rewardTokenEmissionsAmount;
  poolDailySnapshot.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

  poolDailySnapshot.cumulativeSupplySideRevenueUSD =
    pool.cumulativeSupplySideRevenueUSD;
  poolDailySnapshot.cumulativeProtocolSideRevenueUSD =
    pool.cumulativeProtocolSideRevenueUSD;
  poolDailySnapshot.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;

  poolDailySnapshot.blockNumber = event.block.number;
  poolDailySnapshot.timestamp = event.block.timestamp;
  poolDailySnapshot.save();
  return poolDailySnapshot;
}

export function getOrCreatePoolHourlySnapshot(
  event: ethereum.Event,
  pool: LiquidityPool
): LiquidityPoolHourlySnapshot {
  const timestamp = event.block.timestamp.toI64();
  const hours: i64 = timestamp / SECONDS_PER_HOUR;
  const id = `${pool.id}-${hours}`;
  let poolHourlySnapshot = LiquidityPoolHourlySnapshot.load(id);
  if (!poolHourlySnapshot) {
    poolHourlySnapshot = new LiquidityPoolHourlySnapshot(id);
    poolHourlySnapshot.protocol = pool.protocol;
    poolHourlySnapshot.pool = pool.id;
    poolHourlySnapshot.hourlyVolumeByTokenAmount = new Array<BigInt>(
      pool.inputTokens.length
    ).map<BigInt>(() => BIGINT_ZERO);
    poolHourlySnapshot.hourlyVolumeByTokenUSD = new Array<BigDecimal>(
      pool.inputTokens.length
    ).map<BigDecimal>(() => BIGDECIMAL_ZERO);

    poolHourlySnapshot.hourlySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    poolHourlySnapshot.hourlyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    poolHourlySnapshot.hourlyTotalRevenueUSD = BIGDECIMAL_ZERO;
  }
  poolHourlySnapshot.totalValueLockedUSD = pool.totalValueLockedUSD;
  poolHourlySnapshot.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
  poolHourlySnapshot.inputTokenBalances = pool.inputTokenBalances;
  poolHourlySnapshot.inputTokenWeights = pool.inputTokenWeights;
  poolHourlySnapshot.outputTokenSupply = pool.outputTokenSupply;
  poolHourlySnapshot.outputTokenPriceUSD = pool.outputTokenPriceUSD;
  poolHourlySnapshot.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
  poolHourlySnapshot.rewardTokenEmissionsAmount =
    pool.rewardTokenEmissionsAmount;
  poolHourlySnapshot.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

  poolHourlySnapshot.cumulativeSupplySideRevenueUSD =
    pool.cumulativeSupplySideRevenueUSD;
  poolHourlySnapshot.cumulativeProtocolSideRevenueUSD =
    pool.cumulativeProtocolSideRevenueUSD;
  poolHourlySnapshot.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;

  poolHourlySnapshot.blockNumber = event.block.number;
  poolHourlySnapshot.timestamp = event.block.timestamp;
  poolHourlySnapshot.save();

  return poolHourlySnapshot;
}

export function handlePoolDeposit(
  event: ethereum.Event,
  pool: LiquidityPool,
  deposit: Deposit
): void {
  setInputTokenBalancesAndWeights(pool);
  pool.outputTokenSupply = pool.outputTokenSupply!.plus(
    deposit.outputTokenAmount!
  );
  updateOutputTokenPriceAndTVL(event, pool);
  updateRewardTokenEmissionsUSD(event, pool);
  pool.save();
  getOrCreatePoolDailySnapshot(event, pool);
  getOrCreatePoolHourlySnapshot(event, pool);
  incrementProtocolDepositCount(event);
}

export function handlePoolWithdraw(
  event: ethereum.Event,
  pool: LiquidityPool,
  withdraw: Withdraw
): void {
  setInputTokenBalancesAndWeights(pool);
  pool.outputTokenSupply = pool.outputTokenSupply!.minus(
    withdraw.outputTokenAmount!
  );
  updateOutputTokenPriceAndTVL(event, pool);
  updateRewardTokenEmissionsUSD(event, pool);
  pool.save();
  getOrCreatePoolDailySnapshot(event, pool);
  getOrCreatePoolHourlySnapshot(event, pool);
  incrementProtocolWithdrawCount(event);
}

export function handlePoolSwap(
  event: ethereum.Event,
  pool: LiquidityPool,
  swap: SwapEvent
): void {
  const volumeUSD = calculateAverage([swap.amountInUSD, swap.amountOutUSD]);
  pool.cumulativeVolumeUSD = pool.cumulativeVolumeUSD.plus(volumeUSD);
  setInputTokenBalancesAndWeights(pool);
  updateOutputTokenPriceAndTVL(event, pool);
  updateRewardTokenEmissionsUSD(event, pool);
  pool.save();
  const dailySnapshot = getOrCreatePoolDailySnapshot(event, pool);
  dailySnapshot.dailyVolumeUSD = dailySnapshot.dailyVolumeUSD.plus(volumeUSD);
  dailySnapshot.dailyVolumeByTokenAmount = addTokenVolume(
    dailySnapshot.dailyVolumeByTokenAmount,
    swap,
    pool
  );
  dailySnapshot.dailyVolumeByTokenUSD = addTokenVolumeUSD(
    dailySnapshot.dailyVolumeByTokenUSD,
    swap,
    pool
  );
  dailySnapshot.save();
  const hourlySnapshot = getOrCreatePoolHourlySnapshot(event, pool);
  hourlySnapshot.hourlyVolumeUSD =
    hourlySnapshot.hourlyVolumeUSD.plus(volumeUSD);
  hourlySnapshot.hourlyVolumeByTokenAmount = addTokenVolume(
    hourlySnapshot.hourlyVolumeByTokenAmount,
    swap,
    pool
  );
  hourlySnapshot.hourlyVolumeByTokenUSD = addTokenVolumeUSD(
    hourlySnapshot.hourlyVolumeByTokenUSD,
    swap,
    pool
  );
  hourlySnapshot.save();
  incrementProtocolSwapCount(event);
  addProtocolUSDVolume(event, volumeUSD);
  const supplySideRevenueUSD = swap.amountInUSD.times(
    getSupplySideFee(pool.id)
  );
  const protocolRevenueUSD = swap.amountInUSD.times(getProtocolFee(pool.id));
  addProtocolUSDRevenue(event, pool, supplySideRevenueUSD, protocolRevenueUSD);
}

export function handlePoolRewardsUpdated(
  event: ethereum.Event,
  miniChef: MiniChefV2,
  pid: BigInt,
  stakedAmountChange: BigInt = BIGINT_ZERO
): void {
  const lpTokenAddress = miniChef.lpToken(pid);
  if (lpTokenAddress.toHexString() == ZERO_ADDRESS) {
    return;
  }
  const poolInfo = miniChef.poolInfo(pid);
  const poolAllocPoint = poolInfo.value2;
  const saddlePerSecond = miniChef.saddlePerSecond();
  const totalAllocPoint = miniChef.totalAllocPoint();
  const token = getOrCreateToken(lpTokenAddress);
  if (!token._pool) {
    log.error("Could not find source pool for LP token: {}", [
      lpTokenAddress.toHexString(),
    ]);
    return;
  }
  const pool = getOrCreatePool(Address.fromString(token._pool!));
  const sdlRewardsPerDay = saddlePerSecond
    .times(BigInt.fromI64(SECONDS_PER_DAY))
    .times(poolAllocPoint)
    .div(totalAllocPoint);
  const rewardTokenEmissions = [sdlRewardsPerDay];
  const rewardTokens = [getOrCreateRewardToken(miniChef.SADDLE()).id];
  const rewarderAddress = miniChef.rewarder(pid);
  if (rewarderAddress.toHexString() != ZERO_ADDRESS) {
    const rewarder = SimpleRewarder.bind(rewarderAddress);
    const rewardTokenAddress = rewarder.rewardToken();
    if (!checkValidToken(rewardTokenAddress)) {
      log.error("Invalid reward token: {}", [rewardTokenAddress.toHexString()]);
    } else {
      const rewardPerSecond = rewarder.rewardPerSecond();
      const rewardPerDay = rewardPerSecond.times(
        BigInt.fromI64(SECONDS_PER_DAY)
      );
      rewardTokens.push(getOrCreateRewardToken(rewardTokenAddress).id);
      rewardTokenEmissions.push(rewardPerDay);
    }
  }
  pool.rewardTokens = rewardTokens;
  pool.rewardTokenEmissionsAmount = rewardTokenEmissions;
  updateRewardTokenEmissionsUSD(event, pool);
  if (!pool.stakedOutputTokenAmount) {
    pool.stakedOutputTokenAmount = BIGINT_ZERO;
  }
  pool.stakedOutputTokenAmount =
    pool.stakedOutputTokenAmount!.plus(stakedAmountChange);
  pool.save();
  getOrCreatePoolDailySnapshot(event, pool);
  getOrCreatePoolHourlySnapshot(event, pool);
}

function updateRewardTokenEmissionsUSD(
  event: ethereum.Event,
  pool: LiquidityPool
): void {
  if (!pool.rewardTokens) {
    return;
  }
  const rewardTokenEmissionsUSD = new Array<BigDecimal>(
    pool.rewardTokens!.length
  );
  for (let i = 0; i < pool.rewardTokens!.length; i++) {
    const rewardToken = getOrCreateTokenFromString(pool.rewardTokens![i]);
    const emissionAmount = pool.rewardTokenEmissionsAmount![i];
    rewardTokenEmissionsUSD[i] = bigIntToBigDecimal(
      emissionAmount,
      rewardToken.decimals
    ).times(getPriceUSD(rewardToken, event));
  }
  pool.rewardTokenEmissionsUSD = rewardTokenEmissionsUSD;
}

function addTokenVolume(
  tokenVolume: BigInt[],
  swap: SwapEvent,
  pool: LiquidityPool
): BigInt[] {
  const tokenInIndex = pool.inputTokens.indexOf(swap.tokenIn);
  const tokenOutIndex = pool.inputTokens.indexOf(swap.tokenOut);
  tokenVolume[tokenInIndex] = tokenVolume[tokenInIndex].plus(swap.amountIn);
  tokenVolume[tokenOutIndex] = tokenVolume[tokenOutIndex].plus(swap.amountOut);
  return tokenVolume;
}

function addTokenVolumeUSD(
  tokenVolume: BigDecimal[],
  swap: SwapEvent,
  pool: LiquidityPool
): BigDecimal[] {
  const tokenInIndex = pool.inputTokens.indexOf(swap.tokenIn);
  const tokenOutIndex = pool.inputTokens.indexOf(swap.tokenOut);
  tokenVolume[tokenInIndex] = tokenVolume[tokenInIndex].plus(swap.amountInUSD);
  tokenVolume[tokenOutIndex] = tokenVolume[tokenOutIndex].plus(
    swap.amountOutUSD
  );
  return tokenVolume;
}

function getBasePool(contract: Swap): string | null {
  const metaSwapStorageCall = contract.try_metaSwapStorage();
  if (metaSwapStorageCall.reverted) {
    return null;
  }
  return metaSwapStorageCall.value.value0 /* baseSwap */
    .toHexString();
}

function getOrCreateInputTokens(pooledTokens: Address[]): string[] {
  let tokens = pooledTokens.map<Token>((t) => getOrCreateToken(t));
  let tokenIds = tokens.map<string>((t) => t.id);
  let basePoolId = tokens[tokens.length - 1]._pool;
  if (basePoolId) {
    tokenIds.pop();
    const basePool = getOrCreatePool(Address.fromString(basePoolId));
    tokenIds = tokenIds.concat(basePool.inputTokens);
  }
  return tokenIds;
}

function updateOutputTokenPriceAndTVL(
  event: ethereum.Event,
  pool: LiquidityPool
): void {
  const totalValueLocked = getTokenAmountsSumUSD(
    event,
    pool.inputTokenBalances,
    pool.inputTokens
  );
  const outputTokenAmount = bigIntToBigDecimal(
    pool.outputTokenSupply!,
    getTokenDecimals(pool.outputToken!)
  );
  pool.outputTokenPriceUSD = totalValueLocked.div(outputTokenAmount);
  updateProtocolTVL(event, totalValueLocked.minus(pool.totalValueLockedUSD));
  pool.totalValueLockedUSD = totalValueLocked;
}

function setInputTokenBalancesAndWeights(
  pool: LiquidityPool,
  contract: Swap | null = null
): void {
  if (contract == null) {
    contract = Swap.bind(Address.fromString(pool.id));
  }
  let balances: BigInt[] = [];
  if (pool._basePool) {
    const basePool = getOrCreatePool(Address.fromString(pool._basePool!));
    const lpTokenIndex = pool.inputTokens.length - basePool.inputTokens.length;
    const lpTokenBalance = contract.getTokenBalance(lpTokenIndex);
    const totalLPTokenSupply = basePool.outputTokenSupply!;
    // Calculate pool input token amounts based on LP token ratio
    for (let i = 0; i < basePool.inputTokenBalances.length; i++) {
      const balance = basePool.inputTokenBalances[i];
      balances.push(balance.times(lpTokenBalance).div(totalLPTokenSupply));
    }
  }
  pool.inputTokenBalances = getBalances(
    contract,
    pool.inputTokens.length - balances.length
  ).concat(balances);
  pool.inputTokenWeights = getBalanceWeights(
    pool.inputTokenBalances,
    pool.inputTokens
  );
}

function getBalances(contract: Swap, n: i32): BigInt[] {
  const balances: BigInt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    balances[i] = contract.getTokenBalance(i);
  }
  return balances;
}

function getBalanceWeights(balances: BigInt[], tokens: string[]): BigDecimal[] {
  const decimalBalances: BigDecimal[] = new Array(balances.length);
  for (let i = 0; i < balances.length; i++) {
    decimalBalances[i] = bigIntToBigDecimal(
      balances[i],
      getTokenDecimals(tokens[i])
    );
  }
  let sum = decimalBalances.reduce((a, b) => a.plus(b), BIGDECIMAL_ZERO);
  if (sum == BIGDECIMAL_ZERO) {
    sum = BIGDECIMAL_ONE.times(new BigDecimal(BigInt.fromI32(balances.length)));
  }
  const weights: BigDecimal[] = new Array(balances.length);
  for (let i = 0; i < balances.length; i++) {
    weights[i] = decimalBalances[i].div(sum).times(BIGDECIMAL_HUNDRED);
  }
  return weights;
}

function createPoolFromAddress(address: Address): LiquidityPool {
  const poolData = POOL_DATA.get(
    prefixID(dataSource.network(), address.toHexString())
  );
  const pool = new LiquidityPool(address.toHexString());
  const contract = Swap.bind(address);
  let lpTokenAddress = contract.swapStorage().value6;
  // Check if LP token is valid
  if (!checkValidToken(lpTokenAddress)) {
    const v1contract = SwapV1.bind(address);
    lpTokenAddress = v1contract.swapStorage().value7;
    if (!checkValidToken(lpTokenAddress)) {
      log.critical("Invalid LP token address {} in pool {}", [
        lpTokenAddress.toHexString(),
        address.toHexString(),
      ]);
    }
  }

  const protocol = getOrCreateProtocol();
  pool.protocol = protocol.id;
  pool.inputTokens = getOrCreateInputTokensFromContract(contract);
  const token = getOrCreateToken(lpTokenAddress, address.toHexString());
  pool.outputToken = token.id;
  pool.outputTokenSupply = BIGINT_ZERO;
  pool.createdTimestamp = poolData.createdTimestamp;
  pool.createdBlockNumber = poolData.createdBlockNumber;
  pool.name = token.name;
  pool.symbol = token.symbol;
  const tradingFee = contract.swapStorage().value4; // swapFee
  const adminFee = contract.swapStorage().value5; // adminFee
  pool.fees = createOrUpdateAllFees(address, tradingFee, adminFee);
  pool._basePool = getBasePool(contract);
  setInputTokenBalancesAndWeights(pool, contract);

  pool.isSingleSided = false;
  pool.cumulativeSupplySideRevenueUSD = BIGDECIMAL_ZERO;
  pool.cumulativeProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
  pool.cumulativeTotalRevenueUSD = BIGDECIMAL_ZERO;

  protocol.totalPoolCount += 1;

  protocol.save();
  pool.save();

  return pool;
}

function getOrCreateInputTokensFromContract(contract: Swap): string[] {
  const tokens: Address[] = [];
  let i = 0;
  let call: ethereum.CallResult<Address>;
  do {
    call = contract.try_getToken(i);
    if (!call.reverted) {
      tokens.push(call.value);
    }
    i += 1;
  } while (!call.reverted);
  return getOrCreateInputTokens(tokens);
}
