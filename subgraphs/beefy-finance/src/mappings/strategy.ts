/* import { Strategy } from "../../generated/schema";
import {
  Deposit,
  StratHarvest,
  Withdraw,
} from "../../generated/templates/Strategy/Strategy";
import { getStrategyOrCreate, getVaultOrCreate } from "../utils/getters";
import { getAddressFromId } from "../utils/helpers";

const NETWORK_SUFFIX = "-137";

export async function createStrategy(strategyAddress: string, block: any) {
  const strategy = new Strategy(strategyAddress + NETWORK_SUFFIX);

  strategy.protocol = "Assign BeefyFinance"; //type YieldAggregator
  strategy.createdTimestamp = block.timestamp;
  strategy.createdBlockNumber = block.number;

  strategy.vault = ;

  strategy.save();
}

export async function handleDeposit(event: Deposit): Promise<void> {
  const strategy = getStrategyOrCreate(
    event.address.toHexString(),
    NETWORK_SUFFIX
  );

  await updateBalance(strategy);
}

//TODO: handle deposit and withdraw could be collapsed into one function
export async function handleWithdraw(event: Withdraw): Promise<void> {
  const strategy = getStrategyOrCreate(
    event.address.toHexString(),
    NETWORK_SUFFIX
  );

  await updateBalance(strategy);
}

export async function handleStratHarvest(event: StratHarvest): Promise<void> {
  const strategy = getStrategyOrCreate(
    event.address.toHexString(),
    NETWORK_SUFFIX
  );

  await updateBalance(strategy);
}

export async function updateBalance(strategy: Strategy): Promise<void> {
  const strategyContract = new ethers.Contract(
    strategy.id.split("-")[0],
    strategyABI
  );
  strategy.inputTokenBalance = await strategyContract.balanceOf();

  const vault = getVaultOrCreate(
    strategy.vault.split("-")[0],
    "-" + strategy.vault.split("-")[1]
  );
  const vaultContract = new ethers.Contract(
    getAddressFromId(strategy.vault),
    vaultABI
  );
  vault.inputTokenBalance = await vaultContract.balance();
  vault.totalValueLockedUSD = (await vaultContract.pricePerFullShare()).mul(
    await vaultContract.totalSupply()
  );
  strategy.totalValueLockedUSD = (await strategyContract.balanceOf())
    .mul(vault.totalValueLockedUSD)
    .div(await vaultContract.balance());

  strategy.save();
  vault.save();
} */
