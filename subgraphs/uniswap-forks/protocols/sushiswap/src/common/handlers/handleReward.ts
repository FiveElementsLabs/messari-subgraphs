import { BigDecimal, BigInt, ethereum, log } from "@graphprotocol/graph-ts";
import { NetworkConfigs } from "../../../../../configurations/configure";
import { MasterChefSushiswap } from "../../../../../generated/MasterChef/MasterChefSushiswap";
import {
  LiquidityPool,
  _HelperStore,
  _MasterChef,
  _MasterChefStakingPool,
} from "../../../../../generated/schema";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  INT_ZERO,
  RECENT_BLOCK_THRESHOLD,
  UsageType,
} from "../../../../../src/common/constants";
import { getOrCreateToken } from "../../../../../src/common/getters";
import {
  findNativeTokenPerToken,
  updateNativeTokenPriceInUSD,
} from "../../../../../src/price/price";
import { getRewardsPerDay } from "../../../../../src/common/rewards";
import { getOrCreateMasterChef } from "../helpers";
import { MasterChef } from "../constants";
import { convertTokenToDecimal } from "../../../../../src/common/utils/utils";

export function handleReward(
  event: ethereum.Event,
  pid: BigInt,
  amount: BigInt,
  usageType: string
): void {
  let poolContract = MasterChefSushiswap.bind(event.address);
  let masterChefPool = getOrCreateMasterChefStakingPool(
    event,
    MasterChef.MASTERCHEF,
    pid,
    poolContract
  );
  let masterChef = getOrCreateMasterChef(event, MasterChef.MASTERCHEF);

  let pool = LiquidityPool.load(masterChefPool.poolAddress);
  if (!pool) {
    return;
  }

  // Update staked amounts
  if (usageType == UsageType.DEPOSIT) {
    pool.stakedOutputTokenAmount = pool.stakedOutputTokenAmount!.plus(amount);
  } else {
    pool.stakedOutputTokenAmount = pool.stakedOutputTokenAmount!.minus(amount);
  }

  // Return if you have calculated rewards recently
  if (
    event.block.number
      .minus(masterChefPool.lastRewardBlock)
      .lt(RECENT_BLOCK_THRESHOLD)
  ) {
    pool.save();
    return;
  }

  // Get necessary values from the master chef contract to calculate rewards
  let poolInfo = poolContract.poolInfo(pid);
  masterChefPool.poolAllocPoint = poolInfo.value1;

  // Mutliplier including block mulitplier
  let fullMultiplier = poolContract
    .getMultiplier(masterChefPool.lastRewardBlock, event.block.number)
    .div(masterChefPool.lastRewardBlock.minus(event.block.number));

  // Divide out the block multiplier so only the bonus multiplier is left
  masterChefPool.multiplier = fullMultiplier.div(
    masterChefPool.lastRewardBlock.minus(event.block.number)
  );
  masterChef.totalAllocPoint = poolContract.totalAllocPoint();

  // Address where allocation is moved to over time to reduce inflation
  let masterPoolAllocPID45 = poolContract.poolInfo(BigInt.fromI32(45)).value1;

  // Allocation from the MasterChefV2 Contract
  let masterPoolAllocPID250 = poolContract.poolInfo(BigInt.fromI32(250)).value1;

  // Total allocation to staking pools that are giving out rewards to users
  let usedTotalAllocation = masterChef.totalAllocPoint
    .minus(masterPoolAllocPID45)
    .minus(masterPoolAllocPID250);

  // Actual total sushi given out per block to users
  masterChef.adjustedRewardTokenRate = usedTotalAllocation
    .div(masterChef.totalAllocPoint)
    .times(masterChef.rewardTokenRate);
  masterChef.lastUpdatedRewardRate = event.block.number;

  // Calculate Reward Emission per Block
  let poolRewardTokenRate = masterChef.adjustedRewardTokenRate
    .times(masterChefPool.poolAllocPoint)
    .div(masterChef.totalAllocPoint);

  let nativeToken = updateNativeTokenPriceInUSD();

  let rewardToken = getOrCreateToken(NetworkConfigs.getRewardToken());
  rewardToken.lastPriceUSD = findNativeTokenPerToken(rewardToken, nativeToken);

  let poolRewardTokenRateBigDecimal = BigDecimal.fromString(
    poolRewardTokenRate.toString()
  );
  let poolRewardTokenPerDay = getRewardsPerDay(
    event.block.timestamp,
    event.block.number,
    poolRewardTokenRateBigDecimal,
    masterChef.rewardTokenInterval
  );

  pool.rewardTokenEmissionsAmount = [
    BigInt.fromString(poolRewardTokenPerDay.toString()),
  ];
  pool.rewardTokenEmissionsUSD = [
    convertTokenToDecimal(
      pool.rewardTokenEmissionsAmount![INT_ZERO],
      rewardToken.decimals
    ).times(rewardToken.lastPriceUSD!),
  ];

  masterChefPool.lastRewardBlock = event.block.number;

  masterChefPool.save();
  masterChef.save();
  rewardToken.save();
  nativeToken.save();
  pool.save();
}

function getOrCreateMasterChefStakingPool(
  event: ethereum.Event,
  masterChefType: string,
  pid: BigInt,
  poolContract: MasterChefSushiswap
): _MasterChefStakingPool {
  let masterChefPool = _MasterChefStakingPool.load(
    masterChefType + "-" + pid.toString()
  );

  // Create entity to track masterchef pool mappings
  if (!masterChefPool) {
    masterChefPool = new _MasterChefStakingPool(
      masterChefType + "-" + pid.toString()
    );
    masterChefPool.poolAddress = poolContract
      .poolInfo(pid)
      .value0.toHexString();
    masterChefPool.multiplier = BIGINT_ONE;
    masterChefPool.poolAllocPoint = BIGINT_ZERO;
    masterChefPool.lastRewardBlock = event.block.number;
    log.warning("MASTERCHEF POOL CREATED: " + masterChefPool.poolAddress, []);

    masterChefPool.save();
  }

  return masterChefPool;
}
