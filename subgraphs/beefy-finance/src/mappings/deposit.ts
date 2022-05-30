import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { Deposit, Vault } from "../../generated/schema";
import {
  BeefyStrategy,
  Deposit as DepositEvent,
} from "../../generated/ExampleVault/BeefyStrategy";
import {
  getBeefyFinanceOrCreate,
  getVaultFromStrategyOrCreate,
  getTokenOrCreate,
} from "../utils/getters";
import { getLastPriceUSD } from "./token";
import { ZERO_ADDRESS_STRING } from "../prices/common/constants";

export function createDeposit(
  event: DepositEvent,
  depositedAmount: BigInt,
  networkSuffix: string
): Deposit {
  const deposit = new Deposit(
    event.transaction.hash
      .toHexString()
      .concat(`-${event.transaction.index}`)
      .concat(networkSuffix)
  );

  deposit.hash = event.transaction.hash.toHexString();
  deposit.logIndex = event.transaction.index.toI32();
  deposit.protocol = getBeefyFinanceOrCreate().id;
  deposit.from = event.transaction.from.toHexString();
  const to = event.transaction.to;
  deposit.to = to ? to.toHexString() : ZERO_ADDRESS_STRING;
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;

  const strategyContract = BeefyStrategy.bind(event.address);
  deposit.asset = getTokenOrCreate(strategyContract.want(), networkSuffix).id;
  deposit.amount = depositedAmount;
  deposit.amountUSD = getLastPriceUSD(
    strategyContract.want(),
    event.block.number
  ).times(new BigDecimal(depositedAmount));

  deposit.vault = getVaultFromStrategyOrCreate(
    event.address,
    event.block,
    networkSuffix
  ).id;

  deposit.save();
  return deposit;
}

export function getOrCreateFirstDeposit(vault: Vault): Deposit {
  let deposit = Deposit.load("MockDeposit" + vault.id);
  if (!deposit) {
    deposit = new Deposit("MockDeposit" + vault.id);

    deposit.hash = ZERO_ADDRESS_STRING;
    deposit.logIndex = 0;
    deposit.protocol = getBeefyFinanceOrCreate().id;
    deposit.from = ZERO_ADDRESS_STRING;
    deposit.to = ZERO_ADDRESS_STRING;
    deposit.blockNumber = vault.createdBlockNumber;
    deposit.timestamp = vault.createdTimestamp;
    deposit.asset = vault.inputToken;
    deposit.amount = new BigInt(0);
    deposit.amountUSD = new BigDecimal(new BigInt(0));
    deposit.vault = vault.id;

    deposit.save();
  }

  return deposit;
}
